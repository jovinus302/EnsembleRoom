import { beforeEach, describe, expect, it } from 'vitest';
import type { RoomSnapshot, VisitDto, WorldResponse } from '@ensemble/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/context';
import { dispatch } from '../src/domain/actions';
import { resolveSubject } from '../src/domain/rooms';
import { endVisit } from '../src/domain/visits';
import { SEED, auth, loginAs, makeApp } from './helpers';

const { alice, bob } = SEED.users;
const R = SEED.rooms;

let ctx: AppContext;
let app: FastifyInstance;
let tk: Record<string, string>;

const post = (name: string, url: string, payload: object = {}) =>
  app.inject({ method: 'POST', url, headers: auth(tk[name]!), payload });
const get = (name: string, url: string) => app.inject({ method: 'GET', url, headers: auth(tk[name]!) });
const types = (roomId: string, ...t: string[]) => ctx.store.listAll(roomId).filter((e) => t.includes(e.type));
const requestHuman = async (name: string, roomId: string) =>
  ((await post(name, `/api/rooms/${roomId}/visits`, { kind: 'human' })).json() as { visitId: string; visit: VisitDto }).visitId;
const clarity = async (name: string, roomId: string) =>
  ((await get(name, '/api/world')).json() as WorldResponse).rooms.find((r) => r.id === roomId)!.preview.glass;

beforeEach(async () => {
  ({ ctx, app } = await makeApp());
  tk = { Alice: await loginAs(app, 'Alice'), Bob: await loginAs(app, 'Bob') };
});

describe('사람 방문', () => {
  it('요청은 DM과 호스트 Room 양쪽에 기록되고, 수락 전에는 아무 권한도 없다', async () => {
    const visitId = await requestHuman('Bob', R.myAlice);
    for (const room of [R.myAlice, R.dmAliceBob]) {
      expect(types(room, 'visit_requested')).toMatchObject([{ visitId, visitorKind: 'human', visitorUserId: bob }]);
    }
    expect(ctx.repo.getVisit(visitId)).toMatchObject({ status: 'requested', requestedInDmRoomId: R.dmAliceBob });

    // 수락 전: 스냅샷 403, 쓰기 403, 구독 불가
    expect((await get('Bob', `/api/rooms/${R.myAlice}/snapshot`)).statusCode).toBe(403);
    expect((await post('Bob', `/api/rooms/${R.myAlice}/messages`, { text: 'hi', clientId: 'c' })).statusCode).toBe(403);
    expect(resolveSubject(ctx, ctx.repo.getRoom(R.myAlice)!, { kind: 'human', userId: bob })).toBeNull();
    expect(await clarity('Bob', R.myAlice)).toBe('frosted');
    // 같은 요청을 또 보낼 수 없다
    expect((await post('Bob', `/api/rooms/${R.myAlice}/visits`, { kind: 'human' })).statusCode).toBe(409);
    // 호스트만 수락할 수 있다
    expect((await post('Bob', `/api/visits/${visitId}/accept`, { permissions: ['comment'] })).statusCode).toBe(403);
  });

  it('수락하면 start_seq 이후만 보이고, 종료하면 다시 못 본다. 유리는 방문 중에만 투명하다', async () => {
    const roomId = R.myAlice;
    dispatch(ctx, { kind: 'human', userId: alice }, { type: 'create_card', roomId, title: '방문 전 카드', body: '' });
    const visitId = await requestHuman('Bob', roomId);

    // 방문자에게 줄 수 없는 grant는 거부
    expect((await post('Alice', `/api/visits/${visitId}/accept`, { permissions: ['comment', 'edit_board'] })).statusCode).toBe(400);
    expect(ctx.repo.getVisit(visitId)!.status).toBe('requested');

    const acc = await post('Alice', `/api/visits/${visitId}/accept`, { permissions: ['chat', 'comment'] });
    expect(acc.statusCode).toBe(200);
    const accepted = types(roomId, 'visit_accepted')[0]!;
    expect(ctx.repo.getVisit(visitId)).toMatchObject({ status: 'active', startSeq: accepted.seq, permissions: ['chat', 'comment'] });
    expect(types(R.dmAliceBob, 'visit_accepted')).toHaveLength(1);
    expect(await clarity('Bob', roomId)).toBe('clear');

    await post('Alice', `/api/rooms/${roomId}/messages`, { text: '어서 와', clientId: 'a1' });
    const snap = (await get('Bob', `/api/rooms/${roomId}/snapshot`)).json() as RoomSnapshot;
    expect(snap.events.every((e) => e.seq >= accepted.seq)).toBe(true);
    expect(snap.events.some((e) => e.type === 'message' && e.text === '어서 와')).toBe(true);
    expect(snap.events.some((e) => e.type === 'card_created')).toBe(false); // start_seq 이전
    expect(snap.visits.map((v) => v.id)).toEqual([visitId]);

    // 허용된 것만: 메시지 가능, 카드 생성 불가
    expect((await post('Bob', `/api/rooms/${roomId}/messages`, { text: '안녕하세요', clientId: 'b1' })).statusCode).toBe(200);
    expect((await post('Bob', `/api/rooms/${roomId}/cards`, { title: 'x' })).statusCode).toBe(403);

    // 방문자 본인이 종료
    const end = await post('Bob', `/api/visits/${visitId}/end`);
    expect(end.statusCode).toBe(200);
    expect(ctx.repo.getVisit(visitId)).toMatchObject({ status: 'ended' });
    expect(ctx.repo.getVisit(visitId)!.endSeq).toBe(types(roomId, 'visit_ended')[0]!.seq);
    expect(types(roomId, 'visit_ended')[0]).toMatchObject({ reason: 'visitor_left' });
    expect(types(R.dmAliceBob, 'visit_ended')).toHaveLength(1);

    expect((await get('Bob', `/api/rooms/${roomId}/snapshot`)).statusCode).toBe(403);
    expect((await post('Bob', `/api/rooms/${roomId}/messages`, { text: 'again', clientId: 'b2' })).statusCode).toBe(403);
    expect(await clarity('Bob', roomId)).toBe('frosted');
    // 이미 끝난 방문은 다시 끝낼 수 없다
    expect((await post('Bob', `/api/visits/${visitId}/end`)).statusCode).toBe(409);
    // 종료 뒤에는 새로 요청할 수 있다
    expect((await post('Bob', `/api/rooms/${roomId}/visits`, { kind: 'human' })).statusCode).toBe(200);
  });

  it('호스트가 종료하면 host_ended. 남은 사람은 끝낼 수 없다', async () => {
    const visitId = await requestHuman('Bob', R.myAlice);
    await post('Alice', `/api/visits/${visitId}/accept`, { permissions: ['comment'] });
    expect(ctx.store.listAll(R.myAlice).some((e) => e.type === 'visit_accepted')).toBe(true);
    const roomState = ctx.repo.getVisit(visitId)!;
    expect(roomState.status).toBe('active');
    await post('Alice', `/api/visits/${visitId}/end`);
    expect(types(R.myAlice, 'visit_ended')[0]).toMatchObject({ reason: 'host_ended' });
  });

  it('거절하면 declined가 되고 DM·호스트 Room에 기록되며 이후 수락할 수 없다', async () => {
    const visitId = await requestHuman('Bob', R.myAlice);
    const res = await post('Alice', `/api/visits/${visitId}/decline`);
    expect(res.statusCode).toBe(200);
    expect(ctx.repo.getVisit(visitId)).toMatchObject({ status: 'declined' });
    expect(types(R.myAlice, 'visit_declined')).toHaveLength(1);
    expect(types(R.dmAliceBob, 'visit_declined')).toHaveLength(1);
    expect((await post('Alice', `/api/visits/${visitId}/accept`, { permissions: [] })).statusCode).toBe(409);
    expect((await get('Bob', `/api/rooms/${R.myAlice}/snapshot`)).statusCode).toBe(403);
  });

  it('자기 Room·My Room이 아닌 Room·제3자의 종료는 거부된다', async () => {
    expect((await post('Alice', `/api/rooms/${R.myAlice}/visits`, { kind: 'human' })).statusCode).toBe(400);
    expect((await post('Alice', `/api/rooms/${R.friends}/visits`, { kind: 'human' })).statusCode).toBe(400);
    const visitId = await requestHuman('Bob', R.myAlice);
    await post('Alice', `/api/visits/${visitId}/accept`, { permissions: ['comment'] });
    const dana = ctx.repo.getUser(SEED.users.dana)!;
    expect(dana.kind).toBe('seed');
    expect(() => endVisit(ctx, { kind: 'human', userId: SEED.users.dana }, visitId)).toThrow(/끝낼 수 없습니다/);
  });
});

describe('Agent 방문', () => {
  const mandate = { text: '토요일 오후, 3만원, 확정은 내 승인', allowedActions: ['chat', 'comment', 'propose_edit'] };

  it('요청 → 수락 시 agent_departed(출발 Room)·agent_arrived(호스트 Room)가 기록되고 위치가 갱신된다', async () => {
    const sent = await post('Alice', `/api/rooms/${R.myBob}/visits/agent`, { mandate });
    expect(sent.statusCode).toBe(200);
    const visitId = (sent.json() as { visitId: string }).visitId;
    expect(types(R.dmAliceBob, 'visit_requested')).toMatchObject([{ visitorKind: 'agent', visitorAgentId: SEED.agents.alice, mandate }]);
    // 위임 범위는 호스트(Bob)와 소유자(Alice)가 볼 수 있는 DM·호스트 Room 요청 이벤트에 실린다
    expect(types(R.myBob, 'visit_requested')).toMatchObject([{ mandate }]);
    expect((await get('Alice', '/api/world')).json()).toMatchObject({ myAgent: { mode: 'accompanied', location: null } });
    // 한 Agent는 한 번에 한 방문
    expect((await post('Alice', `/api/rooms/${R.myBob}/visits/agent`, { mandate })).statusCode).toBe(409);
    // 방문 Agent에게 줄 수 없는 위임·grant
    expect(
      (await post('Alice', `/api/rooms/${R.myMom}/visits/agent`, { mandate: { ...mandate, allowedActions: ['edit_board'] } })).statusCode,
    ).toBe(400); // edit_board는 위임할 수 없다
    expect((await post('Bob', `/api/visits/${visitId}/accept`, { permissions: ['chat', 'edit_board'] })).statusCode).toBe(400);

    expect((await post('Bob', `/api/visits/${visitId}/accept`, { permissions: ['chat', 'comment'] })).statusCode).toBe(200);
    expect(types(R.myAlice, 'agent_departed')).toMatchObject([{ agentId: SEED.agents.alice, toRoomId: R.myBob, actorKind: 'system' }]);
    expect(types(R.myBob, 'agent_arrived')).toMatchObject([{ agentId: SEED.agents.alice, fromRoomId: R.myAlice }]);

    // 방문 Agent의 권한: grant ∩ mandate, edit_board·remember 없음
    const subj = resolveSubject(ctx, ctx.repo.getRoom(R.myBob)!, { kind: 'agent', agentId: SEED.agents.alice });
    expect(subj).toMatchObject({ kind: 'agent', mode: 'visiting' });

    const w = (await get('Alice', '/api/world')).json() as WorldResponse;
    expect(w.myAgent).toMatchObject({ mode: 'visiting', location: R.myBob, label: 'Bob의 Room 방문 중' });
    // Bob의 Room은 Agent만 있는 상태
    expect(w.rooms.find((r) => r.id === R.myBob)!.preview.ambience).toBe('agentOnly');
    // Agent 방문 중에는 소유자에게 'agent 시야'(옅은 서리), 사람 방문의 clear와는 다르다. detail은 없다
    const bobRoom = w.rooms.find((r) => r.id === R.myBob)!;
    expect(bobRoom.preview.glass).toBe('agent');
    expect(bobRoom.preview.detail).toBeNull();
  });

  it('스냅샷: 수락된 방문 Agent의 표시 정보만 호스트에게 포함된다(요청 중에는 제외, 비공개 필드 없음)', async () => {
    const visitId = (await post('Alice', `/api/rooms/${R.myBob}/visits/agent`, { mandate })).json().visitId as string;
    const ids = async () => ((await get('Bob', `/api/rooms/${R.myBob}/snapshot`)).json() as RoomSnapshot).agents.map((a) => a.id);
    expect(await ids()).not.toContain(SEED.agents.alice);

    await post('Bob', `/api/visits/${visitId}/accept`, { permissions: ['chat', 'comment'] });
    const snap = (await get('Bob', `/api/rooms/${R.myBob}/snapshot`)).json() as RoomSnapshot;
    const visitor = snap.agents.find((a) => a.id === SEED.agents.alice)!;
    expect(visitor).toEqual({
      id: SEED.agents.alice,
      kind: 'personal',
      ownerId: alice,
      name: ctx.repo.getAgent(SEED.agents.alice)!.name,
      personaPublic: ctx.repo.getAgent(SEED.agents.alice)!.personaPublic,
      variant: ctx.repo.getAgent(SEED.agents.alice)!.variant,
    });
    expect(snap.agents.filter((a) => a.id === SEED.agents.alice)).toHaveLength(1);
    expect(JSON.stringify(snap.agents)).not.toContain(mandate.text);

    // 방문이 끝나도 타임라인에 남은 표시 정보는 유지된다
    endVisit(ctx, { kind: 'agent', agentId: SEED.agents.alice }, visitId, { takeout: '끝', report: 'r' });
    expect(await ids()).toContain(SEED.agents.alice);
  });

  it('endVisit: 공개 takeout은 호스트 Room에, 보고는 출발 Room에 소유자만 보는 private로 남는다', async () => {
    const visitId = (await post('Alice', `/api/rooms/${R.myBob}/visits/agent`, { mandate })).json().visitId as string;
    await post('Bob', `/api/visits/${visitId}/accept`, { permissions: ['chat', 'comment'] });

    // 소유자(Alice)는 사람 방문자가 아니므로 Bob의 Room을 볼 수 없다
    expect((await get('Alice', `/api/rooms/${R.myBob}/snapshot`)).statusCode).toBe(403);

    // 다른 Agent는 끝낼 수 없다
    expect(() => endVisit(ctx, { kind: 'agent', agentId: SEED.agents.bob }, visitId)).toThrow(/끝낼 수 없습니다/);
    const out = endVisit(ctx, { kind: 'agent', agentId: SEED.agents.alice }, visitId, {
      takeout: '토요일 오후 3시가 좋다고 합니다.',
      report: 'Bob이 토요일 3시를 제안, 예산 언급 없음.',
    });
    expect(out.events.map((e) => e.type)).toEqual(['visit_takeout', 'approval_requested', 'visit_ended', 'visit_ended', 'agent_returned', 'visit_report']);
    expect(ctx.repo.getVisit(visitId)).toMatchObject({ status: 'ended' });
    expect(types(R.myBob, 'visit_takeout')[0]).toMatchObject({ text: '토요일 오후 3시가 좋다고 합니다.', actorKind: 'agent', actorId: SEED.agents.alice });
    expect(types(R.myBob, 'visit_ended')[0]).toMatchObject({ reason: 'agent_ended' });

    const report = types(R.myAlice, 'visit_report')[0]!;
    expect(report.visibility).toBe(`private:${alice}`);
    expect(types(R.myAlice, 'agent_returned')).toHaveLength(1);
    // 보고는 Alice에게만 보인다
    const mine = ctx.store.listVisible(alice, R.myAlice).some((e) => e.type === 'visit_report');
    const others = ctx.store.listVisible(bob, R.myAlice).some((e) => e.type === 'visit_report');
    expect([mine, others]).toEqual([true, false]);
    expect(((await get('Alice', '/api/world')).json() as WorldResponse).myAgent).toMatchObject({ mode: 'accompanied' });
  });
});
