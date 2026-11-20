import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { privateTo, type ServerWsMessage } from '@ensemble/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/context';
import { acceptVisit, endVisit, sendAgentVisit } from '../src/domain/visits';
import { SEED, auth, insertVisit, loginAs, makeApp } from './helpers';

const { alice, bob } = SEED.users;

class Client {
  msgs: ServerWsMessage[] = [];
  private ws: WebSocket;
  ready: Promise<void>;
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
  async waitFor(pred: (m: ServerWsMessage) => boolean, ms = 2000): Promise<ServerWsMessage> {
    const t0 = Date.now();
    for (;;) {
      const hit = this.msgs.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error('timeout waiting for message');
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  events() {
    // 구독이 일으키는 입장 기록(member_entered)은 presence 테스트에서 따로 본다
    return this.msgs
      .filter((m): m is Extract<ServerWsMessage, { type: 'event' }> => m.type === 'event')
      .map((m) => m.event)
      .filter((e) => e.type !== 'member_entered');
  }
  close() {
    this.ws.close();
  }
}

let ctx: AppContext;
let app: FastifyInstance;
let base: string;
let tokens: Record<string, string>;
const clients: Client[] = [];

const connect = async (name: string): Promise<Client> => {
  const c = new Client(`${base.replace('http', 'ws')}/ws?token=${tokens[name]}`);
  clients.push(c);
  await c.ready;
  return c;
};
const settle = () => new Promise((r) => setTimeout(r, 150));
const post = (name: string, roomId: string, text: string, clientId = 'cid-' + text) =>
  app.inject({ method: 'POST', url: `/api/rooms/${roomId}/messages`, headers: auth(tokens[name]!), payload: { text, clientId } });

beforeEach(async () => {
  ({ ctx, app } = await makeApp());
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  tokens = { Alice: await loginAs(app, 'Alice'), Bob: await loginAs(app, 'Bob') };
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  ctx.hub.closeAll();
  await app.close();
});

describe('WS hub', () => {
  it('토큰이 없거나 틀리면 4401로 닫힌다', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=bad`);
    const code = await new Promise<number>((res) => (ws.onclose = (e) => res(e.code)));
    expect(code).toBe(4401);
  });

  it('같은 Room을 구독한 두 클라이언트가 같은 이벤트를 받고, presence가 온다', async () => {
    const a = await connect('Alice');
    const b = await connect('Bob');
    a.send({ type: 'subscribe', roomId: SEED.rooms.friends });
    b.send({ type: 'subscribe', roomId: SEED.rooms.friends });
    await b.waitFor((m) => m.type === 'presence' && m.userIds.length === 2);

    const res = await post('Alice', SEED.rooms.friends, '안녕', 'c-hello');
    expect(res.statusCode).toBe(200);
    const { seq } = res.json() as { seq: number };

    for (const c of [a, b]) {
      const ev = await c.waitFor((m) => m.type === 'event' && m.event.type === 'message');
      expect(ev).toMatchObject({ type: 'event', event: { seq, roomId: SEED.rooms.friends, text: '안녕', clientId: 'c-hello' } });
    }
    // 보낸 사람만 ack를 받는다
    expect(await a.waitFor((m) => m.type === 'ack')).toEqual({ type: 'ack', clientId: 'c-hello', seq });
    expect(b.msgs.some((m) => m.type === 'ack')).toBe(false);
  });

  it('구독하지 않은 Room의 이벤트는 오지 않는다', async () => {
    const b = await connect('Bob');
    b.send({ type: 'subscribe', roomId: SEED.rooms.friends });
    await settle();
    await post('Alice', SEED.rooms.team, 'team only');
    await settle();
    expect(b.events()).toEqual([]);
  });

  it('접근 권한이 없는 Room 구독은 무시된다', async () => {
    const b = await connect('Bob');
    b.send({ type: 'subscribe', roomId: SEED.rooms.family });
    b.send({ type: 'subscribe', roomId: SEED.rooms.myAlice });
    await settle();
    ctx.store.append({ roomId: SEED.rooms.family, actorKind: 'human', actorId: alice, type: 'message', text: 'family' });
    ctx.store.append({ roomId: SEED.rooms.myAlice, actorKind: 'human', actorId: alice, type: 'message', text: 'mine' });
    await settle();
    expect(b.events()).toEqual([]);
    expect(b.msgs.some((m) => m.type === 'presence')).toBe(false);
  });

  it('private:X 이벤트는 X의 소켓에만 간다', async () => {
    const a = await connect('Alice');
    const b = await connect('Bob');
    a.send({ type: 'subscribe', roomId: SEED.rooms.friends });
    b.send({ type: 'subscribe', roomId: SEED.rooms.friends });
    await settle();
    ctx.store.append({ roomId: SEED.rooms.friends, actorKind: 'system', actorId: null, type: 'visit_report', visitId: 'v1', summary: 'for alice', visibility: privateTo(alice) });
    ctx.store.append({ roomId: SEED.rooms.friends, actorKind: 'human', actorId: alice, type: 'message', text: 'public' });
    await a.waitFor((m) => m.type === 'event' && m.event.type === 'message');
    await b.waitFor((m) => m.type === 'event' && m.event.type === 'message');
    expect(a.events().map((e) => e.type)).toEqual(['visit_report', 'message']);
    expect(b.events().map((e) => e.type)).toEqual(['message']);
  });

  it('my Room 방문자는 활성인 동안 start_seq 이상만 받는다', async () => {
    const room = SEED.rooms.myAlice;
    // 소유자의 구독이 member_entered를 기록하므로, 먼저 구독시킨 뒤 start_seq를 정한다
    const a = await connect('Alice');
    a.send({ type: 'subscribe', roomId: room });
    await settle();
    const start = ctx.store.lastSeq(room) + 2;
    const visitId = insertVisit(ctx, { hostRoomId: room, visitorUserId: bob, permissions: ['comment'], startSeq: start });
    const b = await connect('Bob');
    b.send({ type: 'subscribe', roomId: room });
    await settle();

    const msg = (text: string) => ctx.store.append({ roomId: room, actorKind: 'human', actorId: alice, type: 'message', text });
    msg('before start');
    const e2 = msg('at start');
    await b.waitFor((m) => m.type === 'event' && m.event.seq === e2.seq);
    expect(b.events().map((e) => e.seq)).toEqual([e2.seq]);
    expect(a.events().length).toBe(2);

    // 방문이 끝나면 더 이상 받지 못한다
    ctx.db.raw.prepare("UPDATE visits SET status = 'ended' WHERE id = ?").run(visitId);
    msg('after end');
    await a.waitFor((m) => m.type === 'event' && m.event.type === 'message' && m.event.text === 'after end');
    await settle();
    expect(b.events().map((e) => e.seq)).toEqual([e2.seq]);
  });

  it('cursor는 같은 Room 구독자(보낸 사람 제외)에게만, 월드 cursor는 world 구독자에게만 간다', async () => {
    const a = await connect('Alice');
    const b = await connect('Bob');
    a.send({ type: 'subscribe', roomId: SEED.rooms.friends });
    b.send({ type: 'subscribe', roomId: SEED.rooms.friends });
    await settle();
    a.send({ type: 'cursor', roomId: SEED.rooms.friends, x: 1, y: 2, z: 3 });
    const cur = await b.waitFor((m) => m.type === 'cursor');
    expect(cur).toEqual({ type: 'cursor', userId: alice, roomId: SEED.rooms.friends, x: 1, y: 2, z: 3 });
    // 구독하지 않은 Room에는 쏠 수 없다
    a.send({ type: 'cursor', roomId: SEED.rooms.team, x: 0, y: 0, z: 0 });
    // 월드
    b.send({ type: 'subscribe_world' });
    await settle();
    a.send({ type: 'cursor', roomId: null, x: 9, y: 8, z: 7 });
    await b.waitFor((m) => m.type === 'cursor' && m.roomId === null);
    expect(b.msgs.filter((m) => m.type === 'cursor').length).toBe(2);
    expect(a.msgs.some((m) => m.type === 'cursor')).toBe(false);
  });

  it('subscribe_world: 미리보기를 받고, 남의 Room에는 detail이 없다', async () => {
    const b = await connect('Bob');
    b.send({ type: 'subscribe_world' });
    await b.waitFor((m) => m.type === 'world_preview' && m.preview.roomId === SEED.rooms.myAlice);
    const previews = b.msgs.filter((m): m is Extract<ServerWsMessage, { type: 'world_preview' }> => m.type === 'world_preview');
    const byRoom = Object.fromEntries(previews.map((p) => [p.preview.roomId, p.preview]));
    expect(byRoom[SEED.rooms.myAlice]).toMatchObject({ glass: 'frosted', detail: null });
    expect(byRoom[SEED.rooms.myBob]!.glass).toBe('clear');
    expect(byRoom[SEED.rooms.myBob]!.detail).not.toBeNull();
    expect(byRoom[SEED.rooms.family]).toBeUndefined();

    await post('Alice', SEED.rooms.friends, 'ping');
    const upd = await b.waitFor(
      (m) => m.type === 'world_preview' && m.preview.roomId === SEED.rooms.friends && (m.preview.detail?.unread ?? 0) >= 1,
    );
    expect(upd).toMatchObject({ type: 'world_preview' });
  });

  it('Agent 방문 수락·종료 시 호스트와 방문 Agent 소유자의 월드 미리보기가 다시 나간다', async () => {
    const a = await connect('Alice');
    const b = await connect('Bob');
    a.send({ type: 'subscribe_world' });
    b.send({ type: 'subscribe_world' });
    await settle();
    const v = sendAgentVisit(ctx, bob, SEED.rooms.myAlice, { text: 'hi', allowedActions: ['chat'] });
    acceptVisit(ctx, alice, v.visitId, ['chat']);
    const hasBob = (m: ServerWsMessage) =>
      m.type === 'world_preview' &&
      m.preview.roomId === SEED.rooms.myAlice &&
      !!m.preview.detail?.agents.some((c) => c.agentId === SEED.agents.bob && c.mode === 'visiting');
    await a.waitFor(hasBob);
    const bobSide = await b.waitFor(
      (m) => m.type === 'world_preview' && m.myAgent?.mode === 'visiting' && m.myAgent.travel?.toRoomId === SEED.rooms.myAlice,
    );
    expect(bobSide.type).toBe('world_preview');
    // Bob에게 Alice 방은 계속 서리 유리 + detail 없음
    expect(b.msgs.some(hasBob)).toBe(false);
    a.msgs.length = 0;
    endVisit(ctx, { kind: 'human', userId: alice }, v.visitId);
    await a.waitFor((m) => m.type === 'world_preview' && m.preview.roomId === SEED.rooms.myAlice && !m.preview.detail?.agents.some((c) => c.agentId === SEED.agents.bob));
  });

  it('연결이 끊기면 presence가 갱신된다', async () => {
    const a = await connect('Alice');
    const b = await connect('Bob');
    a.send({ type: 'subscribe', roomId: SEED.rooms.friends });
    b.send({ type: 'subscribe', roomId: SEED.rooms.friends });
    await a.waitFor((m) => m.type === 'presence' && m.userIds.length === 2);
    b.close();
    await a.waitFor((m) => m.type === 'presence' && m.userIds.length === 1 && m.userIds[0] === alice);
  });
});
