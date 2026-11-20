import { describe, expect, it } from 'vitest';
import { seedDatabase } from '../src/db/seed';
import { SEED, auth, loginAs, makeApp, makeCtx } from './helpers';

const counts = (ctx: ReturnType<typeof makeCtx>) =>
  Object.fromEntries(
    ['users', 'agents', 'rooms', 'room_agents', 'room_members', 'events', 'board_cards', 'memory_items'].map((t) => [
      t,
      (ctx.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
    ]),
  );

describe('seed', () => {
  it('재실행해도 중복되지 않는다', () => {
    const ctx = makeCtx();
    const first = counts(ctx);
    seedDatabase(ctx);
    seedDatabase(ctx);
    expect(counts(ctx)).toEqual(first);
    expect(first).toMatchObject({ users: 4, agents: 4, room_agents: 3 });
  });

  it('구성이 계획과 같다', () => {
    const ctx = makeCtx();
    const kinds = Object.fromEntries(ctx.repo.listUsers().map((u) => [u.name, u.kind]));
    expect(kinds).toEqual({ Alice: 'person', Bob: 'person', 엄마: 'seed', Dana: 'seed' });
    const room = (id: string) => ctx.repo.getRoom(id)!;
    expect([room(SEED.rooms.myAlice).theme, room(SEED.rooms.myBob).theme]).toEqual(['studio', 'lounge']);
    for (const id of [SEED.rooms.friends, SEED.rooms.family, SEED.rooms.team]) {
      expect(room(id)).toMatchObject({ kind: 'our', theme: 'cafe' });
    }
    expect(room(SEED.rooms.family).themeVariant).toBe('home');
    expect(room(SEED.rooms.team).themeVariant).toBe('meeting');
    expect(ctx.repo.memberIds(SEED.rooms.friends)).toEqual([SEED.users.alice, SEED.users.bob]);
    expect(ctx.repo.memberIds(SEED.rooms.family)).toEqual([SEED.users.alice, SEED.users.mom]);
    expect(ctx.repo.memberIds(SEED.rooms.team)).toEqual([SEED.users.alice, SEED.users.bob, SEED.users.dana]);
    expect(room(SEED.rooms.dmAliceBob).kind).toBe('dm');
    for (const k of ['friends', 'family', 'team'] as const) {
      expect(ctx.repo.getRoomAgentByRoom(SEED.rooms[k])?.id).toBe(SEED.roomAgents[k]);
    }
  });

  it('가족과 팀의 시드 기억은 서로 다른 ns와 내용이다', () => {
    const ctx = makeCtx();
    const family = ctx.repo.listMemoryItems(`room:${SEED.rooms.family}`).map((m) => m.text);
    const team = ctx.repo.listMemoryItems(`room:${SEED.rooms.team}`).map((m) => m.text);
    expect(family.length).toBeGreaterThan(0);
    expect(team.length).toBeGreaterThan(0);
    expect(family.filter((t) => team.includes(t))).toEqual([]);
    expect(ctx.repo.listMemoryItems(`agent:${SEED.agents.alice}:for:${SEED.rooms.family}`)).toHaveLength(1);
    expect(ctx.repo.listMemoryItems(`agent:${SEED.agents.alice}:for:${SEED.rooms.team}`)).toHaveLength(0);
  });

  it('로그인: 이름으로 토큰, 시드 사용자와 모르는 이름은 거부', async () => {
    const { app } = await makeApp();
    const ok = await app.inject({ method: 'POST', url: '/api/login', payload: { name: 'alice' } });
    expect(ok.statusCode).toBe(200);
    const { token, user } = ok.json() as { token: string; user: { id: string } };
    expect(user.id).toBe(SEED.users.alice);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: auth(token) });
    expect(me.json()).toMatchObject({ user: { name: 'Alice' }, agent: { id: SEED.agents.alice, kind: 'personal' } });
    const users = await app.inject({ method: 'GET', url: '/api/users', headers: auth(token) });
    expect((users.json() as { users: unknown[] }).users).toHaveLength(4);
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { name: '엄마' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { name: 'Zed' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    await app.close();
  });
});

describe('world / snapshot', () => {
  it('Alice의 월드: 내 캡슐 투명+detail, 남의 My Room은 서리+detail 없음, 남의 Our는 숨김', async () => {
    const { app } = await makeApp();
    const alice = await loginAs(app, 'Alice');
    const world = (await app.inject({ method: 'GET', url: '/api/world', headers: auth(alice) })).json() as {
      rooms: { id: string; kind: string; theme: string; preview: { glass: string; ambience: string; detail: unknown } }[];
    };
    const byId = Object.fromEntries(world.rooms.map((r) => [r.id, r]));
    expect(world.rooms[0]!.id).toBe(SEED.rooms.myAlice);
    expect(byId[SEED.rooms.myAlice]!.preview).toMatchObject({ glass: 'clear', ambience: 'empty' });
    expect(byId[SEED.rooms.myAlice]!.preview.detail).not.toBeNull();
    expect(byId[SEED.rooms.myBob]).toMatchObject({ theme: 'lounge', preview: { glass: 'frosted', detail: null } });
    expect(byId[SEED.rooms.family]!.preview.glass).toBe('clear');

    const bob = await loginAs(app, 'Bob');
    const bw = (await app.inject({ method: 'GET', url: '/api/world', headers: auth(bob) })).json() as typeof world;
    expect(bw.rooms.map((r) => r.id)).not.toContain(SEED.rooms.family);
    expect(bw.rooms[0]!.id).toBe(SEED.rooms.myBob);
    await app.close();
  });

  it('snapshot: 보이는 이벤트만, 접근 불가는 403, 메시지 전송이 반영된다', async () => {
    const { app, ctx } = await makeApp();
    const alice = await loginAs(app, 'Alice');
    const r = SEED.rooms.family;
    const snap = (await app.inject({ method: 'GET', url: `/api/rooms/${r}/snapshot`, headers: auth(alice) })).json() as {
      events: { seq: number; type: string }[];
      lastSeq: number;
      room: { themeVariant: string };
    };
    expect(snap.room.themeVariant).toBe('home');
    expect(snap.events.length).toBeGreaterThan(3);
    expect(snap.lastSeq).toBe(ctx.store.lastSeq(r));

    const send = await app.inject({ method: 'POST', url: `/api/rooms/${r}/messages`, headers: auth(alice), payload: { text: '안녕', clientId: 'x1' } });
    expect(send.statusCode).toBe(200);
    expect((send.json() as { seq: number }).seq).toBe(snap.lastSeq + 1);

    const bob = await loginAs(app, 'Bob');
    expect((await app.inject({ method: 'GET', url: `/api/rooms/${r}/snapshot`, headers: auth(bob) })).statusCode).toBe(403);
    await app.close();
  });
});
