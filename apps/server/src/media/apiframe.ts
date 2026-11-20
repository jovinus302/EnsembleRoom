/**
 * APIFrame(v2) 이미지 생성 클라이언트 — 서버 전용. 키·외부 URL·응답 원문은 어디에도 로그/반환하지 않는다.
 * 흐름: POST /v2/images/generate(202, jobId) → GET /v2/jobs/:id 폴링(QUEUED|PROCESSING|COMPLETED|FAILED)
 *       → result.images[0](CDN URL)을 서버가 내려받아 바이트로만 돌려준다.
 * 모델: nano-banana-2-lite. 공식 문서상 "가장 빠른 Nano Banana"(텍스트→이미지 약 4초), 1K 고정.
 */

const BASE_URL = 'https://api.apiframe.ai';
export const COVER_MODEL = 'nano-banana-2-lite';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type CoverErrorCode =
  | 'no_key'
  | 'http_error'
  | 'bad_response'
  | 'job_failed'
  | 'timeout'
  | 'bad_image'
  | 'untrusted_host';

/** 사유 코드만 담는다(원문·URL 금지) */
export class CoverError extends Error {
  constructor(
    readonly code: CoverErrorCode,
    readonly status?: number,
  ) {
    super(status ? `${code}:${status}` : code);
  }
}

export interface ApiframeOptions {
  apiKey: string | undefined;
  fetchImpl?: typeof fetch;
  /** 폴링 간격(ms). 기본 1000 */
  pollMs?: number;
  /** 생성 대기 총 시간(ms). 기본 60000 */
  timeoutMs?: number;
}

export interface GeneratedImage {
  bytes: Buffer;
  ext: 'jpg' | 'png' | 'webp';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function sniff(b: Buffer): GeneratedImage['ext'] | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** 허용 CDN인가: https + apiframe.ai 하위 도메인 */
function trustedImageUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return u.hostname === 'apiframe.ai' || u.hostname.endsWith('.apiframe.ai') ? u : null;
  } catch {
    return null;
  }
}

export async function generateCoverImage(prompt: string, opts: ApiframeOptions): Promise<GeneratedImage> {
  const key = opts.apiKey?.trim();
  if (!key) throw new CoverError('no_key');
  const doFetch = opts.fetchImpl ?? fetch;
  const pollMs = opts.pollMs ?? 1000;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  const left = () => Math.max(1, deadline - Date.now());
  const headers = { 'X-API-Key': key, 'Content-Type': 'application/json' };

  const call = async (path: string, init: RequestInit): Promise<Record<string, unknown>> => {
    let res: Response;
    try {
      res = await doFetch(`${BASE_URL}${path}`, { ...init, signal: AbortSignal.timeout(left()) });
    } catch {
      throw new CoverError(Date.now() >= deadline ? 'timeout' : 'http_error');
    }
    if (!res.ok) throw new CoverError('http_error', res.status);
    try {
      const body: unknown = await res.json();
      if (body && typeof body === 'object') return body as Record<string, unknown>;
    } catch {
      /* fallthrough */
    }
    throw new CoverError('bad_response');
  };

  const created = await call('/v2/images/generate', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt,
      model: COVER_MODEL,
      nanoBananaParams: { aspect_ratio: '16:9', output_format: 'jpg' },
    }),
  });
  const jobId = created.jobId ?? created.id;
  if (typeof jobId !== 'string' || !/^[\w-]{1,80}$/.test(jobId)) throw new CoverError('bad_response');

  let url: URL | null = null;
  for (;;) {
    if (Date.now() >= deadline) throw new CoverError('timeout');
    await sleep(Math.min(pollMs, left()));
    const job = await call(`/v2/jobs/${encodeURIComponent(jobId)}`, { method: 'GET', headers: { 'X-API-Key': key } });
    const status = typeof job.status === 'string' ? job.status.toUpperCase() : '';
    if (status === 'FAILED') throw new CoverError('job_failed');
    if (status === 'COMPLETED') {
      const images = (job.result as { images?: unknown } | null)?.images;
      url = Array.isArray(images) ? trustedImageUrl(images[0]) : null;
      if (!url) throw new CoverError(Array.isArray(images) && images.length ? 'untrusted_host' : 'bad_response');
      break;
    }
  }

  let res: Response;
  try {
    res = await doFetch(url, { redirect: 'error', signal: AbortSignal.timeout(left()) });
  } catch {
    throw new CoverError(Date.now() >= deadline ? 'timeout' : 'http_error');
  }
  if (!res.ok) throw new CoverError('http_error', res.status);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_IMAGE_BYTES) throw new CoverError('bad_image');
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch {
    throw new CoverError(Date.now() >= deadline ? 'timeout' : 'http_error');
  }
  const ext = bytes.length <= MAX_IMAGE_BYTES ? sniff(bytes) : null;
  if (!ext) throw new CoverError('bad_image');
  return { bytes, ext };
}
