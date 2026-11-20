import { describe, expect, it } from 'vitest';
import { settle, visibleBoardTools } from '@ensemble/shared';
import { roomStateOf } from '../src/domain/rooms';
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
    expect(first).toMatchObject({ users: 5, agents: 5, room_agents: 3 });
  });

  it('구성이 계획과 같다', () => {
    const ctx = makeCtx();
    const kinds = Object.fromEntries(ctx.repo.listUsers().map((u) => [u.name, u.kind]));
    expect(kinds).toEqual({ Alice: 'person', Bob: 'person', 엄마: 'seed', 아빠: 'seed', Dana: 'seed' });
    const room = (id: string) => ctx.repo.getRoom(id)!;
    expect([room(SEED.rooms.myAlice).theme, room(SEED.rooms.myBob).theme]).toEqual(['studio', 'lounge']);
    for (const id of [SEED.rooms.friends, SEED.rooms.family, SEED.rooms.team]) {
      expect(room(id)).toMatchObject({ kind: 'our', theme: 'cafe' });
    }
    expect(room(SEED.rooms.family).themeVariant).toBe('home');
    expect(room(SEED.rooms.team).themeVariant).toBe('meeting');
    expect(ctx.repo.memberIds(SEED.rooms.friends)).toEqual([SEED.users.alice, SEED.users.bob]);
    expect(ctx.repo.memberIds(SEED.rooms.family)).toEqual([SEED.users.alice, SEED.users.mom, SEED.users.dad]);
    expect(room(SEED.rooms.myDad)).toMatchObject({ kind: 'my', ownerId: SEED.users.dad });
    expect(ctx.repo.memberIds(SEED.rooms.team)).toEqual([SEED.users.alice, SEED.users.bob, SEED.users.dana]);
    expect(room(SEED.rooms.dmAliceBob).kind).toBe('dm');
    for (const k of ['friends', 'family', 'team'] as const) {
      expect(ctx.repo.getRoomAgentByRoom(SEED.rooms[k])?.id).toBe(SEED.roomAgents[k]);
    }
  });

  it('아빠가 없는 기존 DB도 재시드만으로 아빠가 추가되고 기존 대화는 그대로다', () => {
    const ctx = makeCtx();
    const D = SEED.users.dad;
    const before = ctx.store.lastSeq(SEED.rooms.family);
    ctx.db.raw.exec(`DELETE FROM room_members WHERE user_id = '${D}'`);
    ctx.db.raw.exec(`DELETE FROM memory_items WHERE id = 'mem_seed_dad_for_family'`);
    ctx.db.raw.exec(`DELETE FROM agents WHERE owner_id = '${D}'`);
    ctx.db.raw.exec(`DELETE FROM events WHERE room_id = '${SEED.rooms.myDad}'`);
    ctx.db.raw.exec(`DELETE FROM rooms WHERE id = '${SEED.rooms.myDad}'`);
    ctx.db.raw.exec(`DELETE FROM users WHERE id = '${D}'`);
    expect(ctx.repo.memberIds(SEED.rooms.family)).toEqual([SEED.users.alice, SEED.users.mom]);
    seedDatabase(ctx);
    seedDatabase(ctx);
    expect(ctx.repo.memberIds(SEED.rooms.family)).toEqual([SEED.users.alice, SEED.users.mom, D]);
    expect(ctx.repo.getUser(D)).toMatchObject({ name: '아빠', kind: 'seed' });
    expect(ctx.repo.getAgent(SEED.agents.dad)).toBeDefined();
    expect(ctx.repo.listMemoryItems(`agent:${SEED.agents.dad}:for:${SEED.rooms.family}`)).toHaveLength(1);
    expect(ctx.store.lastSeq(SEED.rooms.family)).toBe(before);
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

  it('친구들 방에 대화·미확정 카드·방 기억이 있고, Alice의 비공개 선호는 방 기억에 없다', () => {
    const ctx = makeCtx();
    const R = SEED.rooms.friends;
    expect(ctx.store.listAll(R).filter((e) => e.type === 'message').length).toBeGreaterThanOrEqual(3);
    expect(ctx.repo.getCard(R, 'c_seed_friends_movie')).toMatchObject({ title: '주말 저녁 영화 모임' });
    const mems = ctx.repo.listMemoryItems(`room:${R}`).map((m) => m.text);
    expect(mems.length).toBeGreaterThanOrEqual(1);
    expect(mems.some((t) => t.includes('매운'))).toBe(false);
  });

  it('room_created만 있는 기존 친구들 방도 재시드하면 시나리오가 들어가고, 재실행은 중복되지 않는다', () => {
    const ctx = makeCtx();
    const R = SEED.rooms.friends;
    ctx.db.raw.exec(`DELETE FROM events WHERE room_id = '${R}' AND type IN ('message','card_created')`);
    ctx.db.raw.exec(`DELETE FROM board_cards WHERE room_id = '${R}'`);
    const n = () => ctx.store.listAll(R).filter((e) => e.type === 'message').length;
    expect(n()).toBe(0);
    seedDatabase(ctx);
    expect(n()).toBe(3);
    seedDatabase(ctx);
    expect(n()).toBe(3);
  });

  it('엄마·Dana·Bob의 persona가 들어 있다 (기존 DB의 옛 persona도 갱신된다)', () => {
    const ctx = makeCtx();
    ctx.db.raw.exec(`UPDATE agents SET persona_public = '옛 설정' WHERE id = '${SEED.agents.mom}'`);
    seedDatabase(ctx);
    expect(ctx.repo.getAgent(SEED.agents.mom)!.personaPublic).toContain('~하자');
    expect(ctx.repo.getAgent(SEED.agents.dana)!.personaPublic).toContain('30분');
    expect(ctx.repo.getAgent(SEED.agents.dad)!.personaPublic).toContain('등산');
    expect(ctx.repo.getAgent(SEED.agents.bob)!.personaPublic).toContain('유머');
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
    expect((users.json() as { users: unknown[] }).users).toHaveLength(5);
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { name: '엄마' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { name: '아빠' } })).statusCode).toBe(403);
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

describe('seed 보드 도구', () => {
  const tools = (ctx: ReturnType<typeof makeCtx>, roomId: string) => visibleBoardTools(roomStateOf(ctx, roomId));

  it('방마다 어울리는 도구가 Room Agent가 만든 것으로 들어 있고 사다리는 실행 전이다', () => {
    const ctx = makeCtx();
    const friends = tools(ctx, SEED.rooms.friends);
    expect(friends.map((t) => [t.kind, t.title])).toEqual([
      ['ladder', '오늘 커피 누가 살까?'],
      ['settlement', '지난주 영화 정산'],
    ]);
    expect(friends[0]).toMatchObject({ createdBy: { kind: 'room_agent', id: SEED.roomAgents.friends }, ownerTag: 'ours', run: null });
    const settlement = friends[1]!;
    if (settlement.kind !== 'settlement') throw new Error('settlement 아님');
    expect(settle(settlement).transfers).toEqual([{ from: 'Bob', to: 'Alice', amount: 6000 }]);

    const family = tools(ctx, SEED.rooms.family);
    expect(family).toHaveLength(1);
    const trip = family[0]!;
    if (trip.kind !== 'trip') throw new Error('trip 아님');
    expect(trip.items).toHaveLength(3);
    expect(trip.items.some((i) => i.memo === '아빠')).toBe(true);
    expect(trip.checklist.map((c) => c.text)).toEqual(['장바구니', '숯·고기', '디저트 예약']);

    const team = tools(ctx, SEED.rooms.team);
    expect(team.map((t) => t.kind)).toEqual(['ladder']);
    expect(team[0]).toMatchObject({ participants: ['Alice', 'Bob', 'Dana'], outcomes: ['진행자', '서기', '타임키퍼'] });

    for (const id of [SEED.rooms.myAlice, SEED.rooms.myBob, SEED.rooms.dmAliceBob]) expect(tools(ctx, id)).toHaveLength(0);
  });

  it('재시드해도 도구가 늘지 않고 id가 같다', () => {
    const ctx = makeCtx();
    const ids = () => Object.values(SEED.rooms).flatMap((r) => tools(ctx, r).map((t) => t.toolId));
    const first = ids();
    expect(first).toHaveLength(4);
    seedDatabase(ctx);
    expect(ids()).toEqual(first);
  });

  it('도구 이벤트가 있는 Room에는 시드 도구를 추가하지 않고, 없는 Room에는 기존 DB에도 추가한다', () => {
    const ctx = makeCtx();
    const F = SEED.rooms.friends;
    const T = SEED.rooms.team;
    ctx.db.raw.exec(`DELETE FROM events WHERE room_id IN ('${F}','${T}') AND type LIKE 'board_tool_%'`);
    ctx.store.append({
      roomId: F,
      actorKind: 'human',
      actorId: SEED.users.alice,
      type: 'board_tool_created',
      toolId: 't_mine',
      title: '내 사다리',
      ownerTag: 'ours',
      init: { kind: 'ladder', participants: ['Alice', 'Bob'], outcomes: ['당첨', '꽝'] },
    });
    seedDatabase(ctx);
    expect(tools(ctx, F).map((t) => t.toolId)).toEqual(['t_mine']);
    expect(tools(ctx, T)).toHaveLength(1);
  });
});
