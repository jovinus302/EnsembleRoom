import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BoardTool, type TripTool } from '@ensemble/shared';
import { dispatch } from '../src/domain/actions';
import { roomStateOf } from '../src/domain/rooms';
import { DomainError } from '../src/errors';
import { generateCoverImage } from '../src/media/apiframe';
import { CoverService, coverPrompt, type CoverServiceOptions } from '../src/media/covers';
import { SEED, auth, loginAs, makeApp, makeCtx } from './helpers';

const R = SEED.rooms;
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'cover-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** 성공 시나리오 fetch mock: generate → 폴링 1회(PROCESSING) → COMPLETED → CDN 이미지 */
function okFetch(calls: string[] = []): typeof fetch {
  let polls = 0;
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
    if (url.endsWith('/v2/images/generate')) return json({ jobId: 'job-1', status: 'QUEUED' }, 202);
    if (url.includes('/v2/jobs/')) {
      polls += 1;
      return polls < 2
        ? json({ id: 'job-1', status: 'PROCESSING', result: null })
        : json({ id: 'job-1', status: 'COMPLETED', result: { images: ['https://cdn2.apiframe.ai/images/job-1-1.jpg'] } });
    }
    return new Response(JPG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }) as typeof fetch;
}

function setup(over: Partial<CoverServiceOptions> = {}) {
  const ctx = makeCtx();
  ctx.covers = new CoverService(ctx, { enabled: true, mediaDir: tmp(), getApiKey: () => 'test-key', pollMs: 1, timeoutMs: 2000, ...over });
  return ctx;
}
const human = { kind: 'human', userId: SEED.users.alice } as const;
const createTrip = (ctx: ReturnType<typeof setup>, roomId: string = R.family, title = '제주 여행') =>
  dispatch(ctx, human, { type: 'create_board_tool', roomId, title, init: { kind: 'trip', days: 1, items: [{ day: 1, place: '성산일출봉', memo: 'Alice 메모' }], checklist: [] } })
    .data.toolId as string;
const toolOf = (ctx: ReturnType<typeof setup>, roomId: string, id: string): BoardTool => roomStateOf(ctx, roomId).boardTools[id]!;

describe('generateCoverImage (fetch mock)', () => {
  it('성공: 인증 헤더·모델·폴링·다운로드', async () => {
    const calls: string[] = [];
    const seen: { headers?: Record<string, string>; body?: string } = {};
    const f = okFetch(calls);
    const wrapped = ((i: string | URL, init?: RequestInit) => {
      if (String(i).endsWith('/v2/images/generate')) {
        seen.headers = init?.headers as Record<string, string>;
        seen.body = String(init?.body);
      }
      return f(i, init);
    }) as typeof fetch;
    const img = await generateCoverImage('p', { apiKey: 'k1', fetchImpl: wrapped, pollMs: 1 });
    expect(img.ext).toBe('jpg');
    expect(img.bytes.length).toBe(JPG.length);
    expect(seen.headers?.['X-API-Key']).toBe('k1');
    expect(JSON.parse(seen.body!).model).toBe('nano-banana-2-lite');
    expect(calls[0]).toBe('POST /v2/images/generate');
    expect(calls.filter((c) => c.startsWith('GET /v2/jobs/')).length).toBe(2);
  });

  it('키 없음 / HTTP 오류 / FAILED / 타임아웃 / 신뢰하지 않는 호스트 / 이미지 아님', async () => {
    await expect(generateCoverImage('p', { apiKey: '', fetchImpl: okFetch() })).rejects.toMatchObject({ code: 'no_key' });
    await expect(generateCoverImage('p', { apiKey: 'k', fetchImpl: (async () => json({}, 401)) as typeof fetch })).rejects.toMatchObject({ code: 'http_error', status: 401 });
    const failed = (async (i: string | URL) =>
      String(i).endsWith('/generate') ? json({ jobId: 'j' }, 202) : json({ status: 'FAILED', error: 'x' })) as typeof fetch;
    await expect(generateCoverImage('p', { apiKey: 'k', fetchImpl: failed, pollMs: 1 })).rejects.toMatchObject({ code: 'job_failed' });
    const never = (async (i: string | URL) =>
      String(i).endsWith('/generate') ? json({ jobId: 'j' }, 202) : json({ status: 'PROCESSING' })) as typeof fetch;
    await expect(generateCoverImage('p', { apiKey: 'k', fetchImpl: never, pollMs: 5, timeoutMs: 60 })).rejects.toMatchObject({ code: 'timeout' });
    const evil = (async (i: string | URL) =>
      String(i).endsWith('/generate') ? json({ jobId: 'j' }, 202) : json({ status: 'COMPLETED', result: { images: ['https://evil.example.com/a.jpg'] } })) as typeof fetch;
    await expect(generateCoverImage('p', { apiKey: 'k', fetchImpl: evil, pollMs: 1 })).rejects.toMatchObject({ code: 'untrusted_host' });
    const html = (async (i: string | URL) => {
      const u = String(i);
      if (u.endsWith('/generate')) return json({ jobId: 'j' }, 202);
      if (u.includes('/v2/jobs/')) return json({ status: 'COMPLETED', result: { images: ['https://cdn2.apiframe.ai/x.png'] } });
      return new Response('<html>', { status: 200 });
    }) as typeof fetch;
    await expect(generateCoverImage('p', { apiKey: 'k', fetchImpl: html, pollMs: 1 })).rejects.toMatchObject({ code: 'bad_image' });
  });
});

describe('coverPrompt', () => {
  it('제목·장소로만 만들고 사람 이름·메모는 제외한다', () => {
    const ctx = setup();
    const id = createTrip(ctx, R.family, 'Alice 생일 제주 여행');
    const p = coverPrompt(toolOf(ctx, R.family, id), ['Alice', 'Bob']);
    expect(p).toContain('성산일출봉');
    expect(p).not.toMatch(/Alice|메모/);
    expect(p).toContain('no text');
  });
});

describe('CoverService', () => {
  it('키가 없으면 완전히 no-op (cover 이벤트 없음)', async () => {
    const ctx = setup({ getApiKey: () => undefined });
    const fetchSpy = vi.fn();
    (ctx.covers as unknown as { o: CoverServiceOptions }).o.fetchImpl = fetchSpy as unknown as typeof fetch;
    const id = createTrip(ctx);
    await ctx.covers.idle();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(toolOf(ctx, R.family, id).cover).toBeNull();
    expect(ctx.store.listAll(R.family).some((e) => e.type === 'board_tool_updated' && e.op.op === 'cover_set')).toBe(false);
  });

  it('ready: pending → ready, 캐시 파일 + cover_set(시스템 actor), 이벤트에 URL·키 없음', async () => {
    const ctx = setup({ fetchImpl: okFetch() });
    const id = createTrip(ctx);
    await ctx.covers.idle();
    const t = toolOf(ctx, R.family, id) as TripTool;
    expect(t.cover?.status).toBe('ready');
    expect(t.cover?.assetId).toMatch(/^m_[0-9a-f]{16}$/);
    const covers = ctx.store.listAll(R.family).filter((e) => e.type === 'board_tool_updated' && e.op.op === 'cover_set');
    expect(covers.map((e) => (e.type === 'board_tool_updated' && e.op.op === 'cover_set' ? e.op.status : ''))).toEqual(['pending', 'ready']);
    expect(covers.every((e) => e.actorKind === 'system')).toBe(true);
    const dump = JSON.stringify(covers);
    expect(dump).not.toMatch(/apiframe|http|test-key/i);
    expect(ctx.covers.readAsset(t.cover!.assetId!)?.bytes.length).toBe(JPG.length);
    expect(t.rev).toBe(0); // 커버는 내용 변경이 아니다
  });

  it('실패: failed로 끝나고 기본 일러스트(cover.assetId null)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = setup({ fetchImpl: (async () => json({}, 500)) as typeof fetch });
    const id = createTrip(ctx);
    await ctx.covers.idle();
    expect(toolOf(ctx, R.family, id).cover).toEqual({ status: 'failed', assetId: null });
  });

  it('타임아웃도 failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const never = (async (i: string | URL) =>
      String(i).endsWith('/generate') ? json({ jobId: 'j' }, 202) : json({ status: 'PROCESSING' })) as typeof fetch;
    const ctx = setup({ fetchImpl: never, pollMs: 5, timeoutMs: 80 });
    const id = createTrip(ctx);
    await ctx.covers.idle();
    expect(toolOf(ctx, R.family, id).cover?.status).toBe('failed');
  });

  it('ladder·settlement는 대상이 아니다', async () => {
    const fetchSpy = vi.fn(okFetch());
    const ctx = setup({ fetchImpl: fetchSpy as unknown as typeof fetch });
    dispatch(ctx, human, { type: 'create_board_tool', roomId: R.family, title: '정산', init: { kind: 'settlement', participants: [], expenses: [] } });
    await ctx.covers.idle();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('레이트리밋: Room당 분당 상한을 넘으면 생성 없이 failed', async () => {
    const fetchSpy = vi.fn(okFetch());
    const ctx = setup({ fetchImpl: fetchSpy as unknown as typeof fetch, limits: { perRoomPerMinute: 1 }, now: () => 1_000_000 });
    const a = createTrip(ctx, R.family, '첫째');
    const b = createTrip(ctx, R.family, '둘째');
    await ctx.covers.idle();
    expect(toolOf(ctx, R.family, a).cover?.status).toBe('ready');
    expect(toolOf(ctx, R.family, b).cover?.status).toBe('failed');
    expect(fetchSpy.mock.calls.filter((c) => String(c[0]).endsWith('/v2/images/generate')).length).toBe(1);
  });

  it('일일 상한', async () => {
    const ctx = setup({ fetchImpl: okFetch(), limits: { perDay: 1, perRoomPerMinute: 99 } });
    const a = createTrip(ctx, R.family, '하나');
    const b = createTrip(ctx, R.family, '둘');
    await ctx.covers.idle();
    expect([toolOf(ctx, R.family, a).cover?.status, toolOf(ctx, R.family, b).cover?.status]).toEqual(['ready', 'failed']);
  });

  it('동시 job 수 제한: 동시에 1개만 진행', async () => {
    let inflight = 0;
    let peak = 0;
    const base = okFetch();
    const f = (async (i: string | URL, init?: RequestInit) => {
      const isGen = String(i).endsWith('/generate');
      if (isGen) {
        inflight += 1;
        peak = Math.max(peak, inflight);
      }
      const r = await base(i, init);
      if (!isGen && !String(i).includes('/v2/jobs/')) inflight -= 1;
      return r;
    }) as typeof fetch;
    const ctx = setup({ fetchImpl: f, limits: { perRoomPerMinute: 99 } });
    createTrip(ctx, R.family, 'a');
    createTrip(ctx, R.family, 'b');
    await ctx.covers.idle();
    expect(peak).toBe(1);
  });

  it('sweep: 이미 ready/failed인 도구는 건너뛰고, 커버가 없는 도구만 한 번 건다', async () => {
    const ctx = setup({ getApiKey: () => undefined });
    const a = createTrip(ctx, R.family, '키 없을 때 생성');
    const calls: string[] = [];
    ctx.covers = new CoverService(ctx, { enabled: true, mediaDir: tmp(), getApiKey: () => 'k', pollMs: 1, fetchImpl: okFetch(calls) });
    ctx.covers.sweep();
    await ctx.covers.idle();
    expect(toolOf(ctx, R.family, a).cover?.status).toBe('ready');
    const before = calls.length;
    ctx.covers.sweep();
    await ctx.covers.idle();
    expect(calls.length).toBe(before); // 재시작해도 반복 생성 없음
  });

  it('REST/Agent로는 cover_set을 만들 수 없다', async () => {
    const ctx = setup({ fetchImpl: okFetch() });
    const id = createTrip(ctx);
    await ctx.covers.idle();
    let err: unknown;
    try {
      dispatch(ctx, human, { type: 'set_board_tool_cover', roomId: R.family, toolId: id, status: 'ready', assetId: 'm_0123456789abcdef' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).status).toBe(403);
    const { app } = await makeApp();
    const token = await loginAs(app, 'Alice');
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${R.family}/tools/${id}/ops`,
      headers: auth(token),
      payload: { op: { op: 'cover_set', status: 'ready', assetId: 'm_0123456789abcdef' } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/media/:assetId', () => {
  it('권한 있는 구성원은 받고, 비구성원·미인증·잘못된 id는 거부', async () => {
    const { ctx, app } = await makeApp();
    ctx.covers = new CoverService(ctx, { enabled: true, mediaDir: tmp(), getApiKey: () => 'k', pollMs: 1, fetchImpl: okFetch() });
    // 우리 가족 방 구성원(엄마·Alice?)을 확인하기 위해 Alice의 My Room에 만든다(소유자만 접근)
    const aliceMy = ctx.repo.listRooms().find((r) => r.kind === 'my' && r.ownerId === SEED.users.alice)!;
    const id = createTrip(ctx as unknown as ReturnType<typeof setup>, aliceMy.id);
    await ctx.covers.idle();
    const assetId = (toolOf(ctx as unknown as ReturnType<typeof setup>, aliceMy.id, id).cover!.assetId)!;
    const alice = await loginAs(app, 'Alice');
    const ok = await app.inject({ method: 'GET', url: `/api/media/${assetId}`, headers: auth(alice) });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(ok.rawPayload.length).toBe(JPG.length);
    const bob = await loginAs(app, 'Bob');
    expect((await app.inject({ method: 'GET', url: `/api/media/${assetId}`, headers: auth(bob) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/media/${assetId}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/media/..%2Fsecret', headers: auth(alice) })).statusCode).toBe(404);
    // 도구를 내리면 더는 내보내지 않는다
    dispatch(ctx, human, { type: 'remove_board_tool', roomId: aliceMy.id, toolId: id });
    expect((await app.inject({ method: 'GET', url: `/api/media/${assetId}`, headers: auth(alice) })).statusCode).toBe(404);
  });
});
