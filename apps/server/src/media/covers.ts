import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { COVER_KINDS, COVER_ASSET_ID, type BoardTool } from '@ensemble/shared';
import type { AppContext } from '../context';
import { dispatch } from '../domain/actions';
import { roomStateOf } from '../domain/rooms';
import { generateCoverImage, type CoverError } from './apiframe';

/**
 * 보드 도구 커버 이미지(선택 기능, 계획 13.3). 도구(trip·custom)가 만들어지면 비동기로 1장을 생성해
 * 로컬 파일로 캐시하고, 시스템 이벤트(cover_set)로 도구에 붙인다. 외부 URL·키는 어디에도 저장·노출하지 않는다.
 * 키가 없거나 BOARD_TOOL_COVERS=off면 모든 경로가 no-op이다(도구에는 cover 이벤트가 생기지 않는다).
 * 최종 상태는 항상 ready 또는 failed — 실패해도 조용히 기본 일러스트가 유지된다. 재시도는 없다.
 */

export interface CoverLimits {
  /** 서버 전체 동시 생성 수 */
  concurrency: number;
  /** Room당 분당 생성 시작 수 */
  perRoomPerMinute: number;
  /** 하루(서버 기동 기준, 로컬 날짜) 총 생성 수 */
  perDay: number;
}

export const DEFAULT_COVER_LIMITS: CoverLimits = { concurrency: 1, perRoomPerMinute: 5, perDay: 20 };

export interface CoverServiceOptions {
  enabled: boolean;
  /** 캐시 디렉터리. 기본 data/media (gitignore) */
  mediaDir?: string;
  /** 기본: process.env.APIFRAME_API_KEY (호출 시점에 읽는다) */
  getApiKey?: () => string | undefined;
  fetchImpl?: typeof fetch;
  pollMs?: number;
  timeoutMs?: number;
  limits?: Partial<CoverLimits>;
  now?: () => number;
}

export interface CoverMeta {
  roomId: string;
  toolId: string;
  ext: 'jpg' | 'png' | 'webp';
}

export const COVER_MIME: Record<CoverMeta['ext'], string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 프롬프트: 도구 제목·장소(메모·사람 이름 제외)로 만든 템플릿만 */
export function coverPrompt(tool: BoardTool, names: readonly string[]): string {
  const parts = [tool.title];
  if (tool.kind === 'trip') parts.push(...[...new Set(tool.items.map((i) => i.place))].slice(0, 3));
  let text = parts.join(', ');
  for (const n of [...names].filter((x) => x.length >= 2).sort((a, b) => b.length - a.length)) {
    text = text.replace(new RegExp(escapeRe(n), 'gi'), ' ');
  }
  text = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"`{}<>\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return `flat illustration, ${text || 'cozy gathering'}, soft pastel colors, simple shapes, no people, no text, no letters`;
}

export class CoverService {
  private readonly limits: CoverLimits;
  readonly mediaDir: string;
  private readonly known = new Set<string>();
  private readonly queue: { roomId: string; toolId: string }[] = [];
  private running = 0;
  private stopped = false;
  private readonly roomStarts = new Map<string, number[]>();
  private day = '';
  private dayCount = 0;

  constructor(
    private readonly ctx: AppContext,
    private readonly o: CoverServiceOptions,
  ) {
    this.limits = { ...DEFAULT_COVER_LIMITS, ...o.limits };
    const dbPath = ctx.config.dbPath;
    this.mediaDir =
      o.mediaDir ?? (dbPath && dbPath !== ':memory:' ? resolve(dbPath, '..', 'media') : resolve(tmpdir(), 'ensemble-room-media'));
  }

  private key(): string | undefined {
    return (this.o.getApiKey ?? (() => process.env.APIFRAME_API_KEY))();
  }

  get enabled(): boolean {
    return this.o.enabled && !this.stopped && !!this.key()?.trim();
  }

  stop(): void {
    this.stopped = true;
  }

  /** 도구가 만들어졌을 때(afterAppend). 트랜잭션 밖에서 시작하도록 미룬다 */
  enqueue(roomId: string, toolId: string): void {
    if (!this.enabled || this.known.has(toolId)) return;
    this.known.add(toolId);
    setImmediate(() => this.admit(roomId, toolId));
  }

  /** 서버 기동 시: 커버 상태가 없거나 pending(이전 기동에서 끊김)인 live 도구를 한 번씩 건다 */
  sweep(): void {
    if (!this.enabled) return;
    for (const room of this.ctx.repo.listRooms()) {
      for (const t of Object.values(roomStateOf(this.ctx, room.id).boardTools)) {
        if (!t.removed && COVER_KINDS.includes(t.kind) && (!t.cover || t.cover.status === 'pending')) this.enqueue(room.id, t.toolId);
      }
    }
  }

  /** 테스트용: 진행·대기 중 job이 모두 끝날 때까지 */
  async idle(): Promise<void> {
    while (this.known.size > 0) await new Promise<void>((r) => setTimeout(r, 10));
  }

  private mark(roomId: string, toolId: string, status: 'pending' | 'ready' | 'failed', assetId?: string): void {
    try {
      dispatch(this.ctx, { kind: 'system' }, { type: 'set_board_tool_cover', roomId, toolId, status, assetId });
    } catch {
      /* 도구가 내려갔거나 Room이 없다 — 조용히 포기 */
    }
  }

  private overLimit(roomId: string): boolean {
    const now = (this.o.now ?? Date.now)();
    const day = new Date(now).toDateString();
    if (day !== this.day) {
      this.day = day;
      this.dayCount = 0;
    }
    const recent = (this.roomStarts.get(roomId) ?? []).filter((t) => now - t < 60_000);
    this.roomStarts.set(roomId, recent);
    if (this.dayCount >= this.limits.perDay || recent.length >= this.limits.perRoomPerMinute) return true;
    recent.push(now);
    this.dayCount += 1;
    return false;
  }

  private liveTool(roomId: string, toolId: string): BoardTool | null {
    try {
      const t = roomStateOf(this.ctx, roomId).boardTools[toolId];
      return t && !t.removed && COVER_KINDS.includes(t.kind) && t.cover?.status !== 'ready' ? t : null;
    } catch {
      return null;
    }
  }

  private admit(roomId: string, toolId: string): void {
    if (!this.liveTool(roomId, toolId)) {
      this.known.delete(toolId);
      return;
    }
    if (this.overLimit(roomId)) {
      this.mark(roomId, toolId, 'failed');
      this.known.delete(toolId);
      return;
    }
    this.mark(roomId, toolId, 'pending');
    this.queue.push({ roomId, toolId });
    this.pump();
  }

  private pump(): void {
    while (this.running < this.limits.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running += 1;
      void this.run(job.roomId, job.toolId).finally(() => {
        this.running -= 1;
        this.known.delete(job.toolId);
        this.pump();
      });
    }
  }

  private names(): string[] {
    const out: string[] = [];
    for (const u of this.ctx.repo.listUsers()) {
      out.push(u.name);
      const a = this.ctx.repo.getAgentByOwner(u.id);
      if (a) out.push(a.name);
    }
    return out;
  }

  private async run(roomId: string, toolId: string): Promise<void> {
    const tool = this.liveTool(roomId, toolId);
    if (!tool) return;
    try {
      const img = await generateCoverImage(coverPrompt(tool, this.names()), {
        apiKey: this.key(),
        fetchImpl: this.o.fetchImpl,
        pollMs: this.o.pollMs,
        timeoutMs: this.o.timeoutMs,
      });
      const assetId = `m_${randomBytes(8).toString('hex')}`;
      mkdirSync(this.mediaDir, { recursive: true });
      writeFileSync(resolve(this.mediaDir, `${assetId}.${img.ext}`), img.bytes);
      const meta: CoverMeta = { roomId, toolId, ext: img.ext };
      writeFileSync(resolve(this.mediaDir, `${assetId}.json`), JSON.stringify(meta));
      this.mark(roomId, toolId, 'ready', assetId);
    } catch (e) {
      const code = (e as CoverError).code ?? 'error';
      const status = (e as CoverError).status;
      console.warn(`[cover] failed: ${code}${status ? ` ${status}` : ''}`); // 사유 코드만. 키·URL·응답 원문 금지
      this.mark(roomId, toolId, 'failed');
    }
  }

  /** 캐시 파일 조회(라우트용). 형식이 맞지 않는 id는 null */
  readAsset(assetId: string): { meta: CoverMeta; bytes: Buffer } | null {
    if (!COVER_ASSET_ID.test(assetId)) return null;
    try {
      const meta = JSON.parse(readFileSync(resolve(this.mediaDir, `${assetId}.json`), 'utf8')) as CoverMeta;
      if (!(meta.ext in COVER_MIME)) return null;
      return { meta, bytes: readFileSync(resolve(this.mediaDir, `${assetId}.${meta.ext}`)) };
    } catch {
      return null;
    }
  }
}
