import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RoomEvent, WorldResponse } from '@ensemble/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/context';
import { resolveSubject } from '../src/domain/rooms';
import { SEED, auth, loginAs, makeApp } from './helpers';

const { alice, bob } = SEED.users;
const R = SEED.rooms;

class Client {
  private ws: WebSocket;
  ready: Promise<void>;
  msgs: Array<{ type: string; userIds?: string[] }> = [];
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => this.msgs.push(JSON.parse(String(ev.data)));
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('ws error'));
    });
  }
  send(m: object) {
    this.ws.send(JSON.stringify(m));
  }
  close() {
    this.ws.close();
  }
}

const until = async (pred: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ctx: AppContext;
let app: FastifyInstance;
let base: string;
let tokens: Record<string, string>;
const clients: Client[] = [];

const types = (roomId: string, ...t: string[]) => ctx.store.listAll(roomId).filter((e) => t.includes(e.type));
const connect = async (name: string): Promise<Client> => {
  const c = new Client(`${base.replace('http', 'ws')}/ws?token=${tokens[name]}`);
  clients.push(c);
  await c.ready;
  return c;
};
const post = (name: string, url: string, payload: object = {}) =>
  app.inject({ method: 'POST', url, headers: auth(tokens[name]!), payload });
const world = async (name: string) =>
  (await app.inject({ method: 'GET', url: '/api/world', headers: auth(tokens[name]!) })).json() as WorldResponse;
const ambience = async (name: string, roomId: string) => (await world(name)).rooms.find((r) => r.id === roomId)!.preview.ambience;

beforeEach(async () => {
  ({ ctx, app } = await makeApp({ implicitLeaveMs: 120 }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  tokens = { Alice: await loginAs(app, 'Alice'), Bob: await loginAs(app, 'Bob') };
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  ctx.hub.closeAll();
  await app.close();
});

describe('입장과 조명 단계', () => {
  it('시드 직후에는 아무도 접속하지 않았으므로 모든 Room이 empty다 (시드 이벤트·기억은 유지)', async () => {
    const w = await world('Alice');
    for (const r of w.rooms) expect(r.preview.ambience).toBe('empty');
    expect(types(R.family, 'message').length).toBeGreaterThan(0);
    expect(ctx.repo.listMemoryItems(`room:${R.family}`).length).toBeGreaterThan(0);
  });

  it('Room을 구독하면 member_entered가 기록되고 occupied가 된다. 재구독해도 중복되지 않는다', async () => {
    const a = await connect('Alice');
    a.send({ type: 'subscribe', roomId: R.myAlice });
    await until(() => types(R.myAlice, 'member_entered').length === 1);
    expect(types(R.myAlice, 'member_entered')[0]).toMatchObject({ userId: alice, role: 'owner' });
    expect(await ambience('Alice', R.myAlice)).toBe('occupied');
    // 남의 월드에서도 조명은 보인다(내용은 아님)
    expect(await ambience('Bob', R.myAlice)).toBe('occupied');

    const a2 = await connect('Alice');
    a2.send({ type: 'subscribe', roomId: R.myAlice });
    await sleep(100);
    expect(types(R.myAlice, 'member_entered')).toHaveLength(1);
  });

  it('명시적 진입(POST /enter)도 member_entered를 기록하고 멱등이다', async () => {
    expect((await post('Alice', `/api/rooms/${R.friends}/enter`)).statusCode).toBe(200);
    expect((await post('Alice', `/api/rooms/${R.friends}/enter`)).statusCode).toBe(200);
    expect(types(R.friends, 'member_entered')).toHaveLength(1);
    expect(await ambience('Alice', R.friends)).toBe('occupied');
    // 구성원이 아니면 403
    expect((await post('Bob', `/api/rooms/${R.family}/enter`)).statusCode).toBe(403);
  });

  it('DM에는 입장이 기록되지 않는다', async () => {
    await post('Alice', `/api/rooms/${R.dmAliceBob}/enter`);
    expect(types(R.dmAliceBob, 'member_entered')).toHaveLength(0);
  });
});

describe('암묵적 퇴장', () => {
  it('구독이 끊기고 타이머가 지나면 member_left{implicit:true}가 기록된다 (mandate 없음 → Agent는 대리 참여 안 함)', async () => {
    const a = await connect('Alice');
    a.send({ type: 'subscribe', roomId: R.myAlice });
    await until(() => types(R.myAlice, 'member_entered').length === 1);
    expect(resolveSubject(ctx, ctx.repo.getRoom(R.myAlice)!, { kind: 'agent', agentId: SEED.agents.alice })).toMatchObject({ mode: 'accompanied' });

    a.close();
    await until(() => types(R.myAlice, 'member_left').length === 1);
    expect(types(R.myAlice, 'member_left')[0]).toMatchObject({ userId: alice, implicit: true });
    expect((types(R.myAlice, 'member_left')[0] as { mandate?: unknown }).mandate).toBeUndefined();
    expect(resolveSubject(ctx, ctx.repo.getRoom(R.myAlice)!, { kind: 'agent', agentId: SEED.agents.alice })).toMatchObject({ mode: 'accompanied' });
    expect(await ambience('Alice', R.myAlice)).toBe('empty');
    expect(ctx.repo.getCursor(alice, R.myAlice).leftAtSeq).not.toBeNull();
  });

  it('타이머가 지나기 전에 재접속하면 취소된다', async () => {
    const a = await connect('Alice');
    a.send({ type: 'subscribe', roomId: R.myAlice });
    await until(() => types(R.myAlice, 'member_entered').length === 1);
    a.close();
    await until(() => ctx.presence.pending === 1);

    const a2 = await connect('Alice');
    a2.send({ type: 'subscribe', roomId: R.myAlice });
    await until(() => ctx.presence.pending === 0);
    await sleep(300);
    expect(types(R.myAlice, 'member_left')).toHaveLength(0);
    expect(await ambience('Alice', R.myAlice)).toBe('occupied');
  });

  it('같은 사용자의 다른 창이 열려 있으면 퇴장 타이머가 돌지 않는다', async () => {
    const a1 = await connect('Alice');
    const a2 = await connect('Alice');
    a1.send({ type: 'subscribe', roomId: R.friends });
    a2.send({ type: 'subscribe', roomId: R.friends });
    await until(() => types(R.friends, 'member_entered').length === 1);
    a1.close();
    await sleep(350);
    expect(ctx.presence.pending).toBe(0);
    expect(types(R.friends, 'member_left')).toHaveLength(0);
  });

  it('unsubscribe 뒤에도 타이머가 돈다. 암묵적 퇴장 뒤 재구독하면 member_rejoined로 돌아온다', async () => {
    const a = await connect('Alice');
    a.send({ type: 'subscribe', roomId: R.friends });
    await until(() => types(R.friends, 'member_entered').length === 1);
    a.send({ type: 'unsubscribe', roomId: R.friends });
    await until(() => types(R.friends, 'member_left').length === 1);
    expect(types(R.friends, 'member_left')[0]).toMatchObject({ implicit: true });

    await post('Bob', `/api/rooms/${R.friends}/messages`, { text: '자리 비운 사이', clientId: 'x1' });
    a.send({ type: 'subscribe', roomId: R.friends });
    await until(() => types(R.friends, 'member_rejoined').length === 1);
    expect(types(R.friends, 'member_rejoined')[0]).toMatchObject({ userId: alice, missedCount: 1 });
  });
});

describe('Leave / Rejoin', () => {
  it('mandate와 함께 Leave하면 소유자 Agent가 representing으로 판별되고 조명은 agentOnly가 된다', async () => {
    await post('Alice', `/api/rooms/${R.myAlice}/enter`);
    const room = ctx.repo.getRoom(R.myAlice)!;
    const agent = { kind: 'agent', agentId: SEED.agents.alice } as const;
    expect(resolveSubject(ctx, room, agent)).toMatchObject({ mode: 'accompanied' });
    expect(await ambience('Alice', R.myAlice)).toBe('occupied');

    const res = await post('Alice', `/api/rooms/${R.myAlice}/leave`, {
      mandate: { text: '토요일 오후, 3만원, 확정은 내 승인', allowedActions: ['chat', 'comment', 'propose_edit'] },
    });
    expect(res.statusCode).toBe(200);
    expect(resolveSubject(ctx, room, agent)).toMatchObject({ mode: 'representing' });
    expect(types(R.myAlice, 'member_left')[0]).toMatchObject({ implicit: false, agentId: SEED.agents.alice });
    expect(await ambience('Alice', R.myAlice)).toBe('agentOnly');
    expect((await world('Alice')).myAgent).toMatchObject({ mode: 'representing', location: R.myAlice });

    // Leave한 뒤에는 구독해도 자동으로 돌아오지 않는다(Rejoin을 해야 한다)
    const a = await connect('Alice');
    a.send({ type: 'subscribe', roomId: R.myAlice });
    await sleep(100);
    expect(types(R.myAlice, 'member_entered')).toHaveLength(1);
    expect((await post('Alice', `/api/rooms/${R.myAlice}/enter`)).statusCode).toBe(409);
    expect((await post('Alice', `/api/rooms/${R.myAlice}/leave`)).statusCode).toBe(409);
  });

  it('명시적 Leave한 사용자는 구독이 살아 있어도 presence 접속자에서 빠지고, Rejoin하면 돌아온다', async () => {
    const a = await connect('Alice');
    const b = await connect('Bob');
    a.send({ type: 'subscribe', roomId: R.friends });
    b.send({ type: 'subscribe', roomId: R.friends });
    const lastPresence = () => [...b.msgs].reverse().find((m) => m.type === 'presence')?.userIds;
    await until(() => lastPresence()?.length === 2);

    expect((await post('Alice', `/api/rooms/${R.friends}/leave`)).statusCode).toBe(200);
    await until(() => lastPresence()?.length === 1);
    expect(lastPresence()).toEqual([bob]);
    expect(ctx.hub.presentUserIds(R.friends)).toEqual([bob]);
    // 소켓은 살아 있으므로 암묵적 퇴장 판정용 원본 집합에는 남아 있다
    expect(ctx.hub.connectedUserIds(R.friends)).toContain(alice);
    expect(await ambience('Bob', R.friends)).toBe('occupied');

    expect((await post('Alice', `/api/rooms/${R.friends}/rejoin`)).statusCode).toBe(200);
    await until(() => lastPresence()?.length === 2);
    expect(ctx.hub.presentUserIds(R.friends).sort()).toEqual([alice, bob].sort());
  });

  it('Rejoin은 missedCount를 기록하고, 다이제스트를 볼 때까지 부재 중 변화가 유지된다', async () => {
    await post('Alice', `/api/rooms/${R.friends}/enter`);
    const left = (await post('Alice', `/api/rooms/${R.friends}/leave`)).json() as { seq: number };
    expect(ctx.repo.getCursor(alice, R.friends).leftAtSeq).toBe(left.seq);
    expect(await ambience('Alice', R.friends)).toBe('empty');

    await post('Bob', `/api/rooms/${R.friends}/messages`, { text: '하나', clientId: 'c1' });
    await post('Bob', `/api/rooms/${R.friends}/messages`, { text: '둘', clientId: 'c2' });
    const w1 = await world('Alice');
    expect(w1.rooms.find((r) => r.id === R.friends)!.preview.detail!.missedChanges).toBe(2);

    const re = await post('Alice', `/api/rooms/${R.friends}/rejoin`);
    expect(re.statusCode).toBe(200);
    expect((re.json() as { missedCount: number }).missedCount).toBe(2);
    const last = types(R.friends, 'member_rejoined', 'member_left').pop() as RoomEvent;
    expect(last).toMatchObject({ type: 'member_rejoined', userId: alice, missedCount: 2 });
    expect(await ambience('Alice', R.friends)).toBe('occupied');
    // 다이제스트 확인 전까지 left_at_seq가 남는다
    expect(ctx.repo.getCursor(alice, R.friends).leftAtSeq).toBe(left.seq);

    await post('Alice', `/api/rooms/${R.friends}/digest_viewed`);
    expect(types(R.friends, 'digest_viewed')).toHaveLength(1);
    expect(ctx.repo.getCursor(alice, R.friends).leftAtSeq).toBeNull();
    // 두 번째는 이벤트 없이 통과
    await post('Alice', `/api/rooms/${R.friends}/digest_viewed`);
    expect(types(R.friends, 'digest_viewed')).toHaveLength(1);

    // 자리를 비운 상태가 아니면 Rejoin은 409
    expect((await post('Alice', `/api/rooms/${R.friends}/rejoin`)).statusCode).toBe(409);
  });

  it('놓친 변화가 없으면 missedCount 0이고 left_at_seq가 바로 해제된다', async () => {
    await post('Alice', `/api/rooms/${R.friends}/enter`);
    await post('Alice', `/api/rooms/${R.friends}/leave`);
    const re = (await post('Alice', `/api/rooms/${R.friends}/rejoin`)).json() as { missedCount: number };
    expect(re.missedCount).toBe(0);
    expect(ctx.repo.getCursor(alice, R.friends).leftAtSeq).toBeNull();
  });

  it('구성원이 아니거나 mandate가 있는데 Agent가 없으면 거부된다', async () => {
    expect((await post('Bob', `/api/rooms/${R.family}/leave`)).statusCode).toBe(403);
    expect((await post('Bob', `/api/rooms/${R.myAlice}/leave`)).statusCode).toBe(403);
    expect((await post('Alice', `/api/rooms/${R.dmAliceBob}/leave`)).statusCode).toBe(400);
    void bob;
  });
});
