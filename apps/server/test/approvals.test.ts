import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAgentState, nsPrivate, nsVisit, type ApprovalListResponse, type RoomEvent, type VoteResponse } from '@ensemble/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/context';
import { dispatch } from '../src/domain/actions';
import { endVisit } from '../src/domain/visits';
import { SEED, auth, loginAs, makeApp } from './helpers';

const { alice, bob } = SEED.users;
const A = SEED.agents;
const R = SEED.rooms;
const RA = SEED.roomAgents;

let ctx: AppContext;
let app: FastifyInstance;
let tk: Record<string, string>;

const post = (name: string, url: string, payload: object = {}) =>
  app.inject({ method: 'POST', url, headers: auth(tk[name]!), payload });
const get = (name: string, url: string) => app.inject({ method: 'GET', url, headers: auth(tk[name]!) });
const types = (roomId: string, ...t: string[]) => ctx.store.listAll(roomId).filter((e) => t.includes(e.type));
const vote = (name: string, approvalId: string, body: object) => post(name, `/api/approvals/${approvalId}/vote`, body);
const pendingFor = async (name: string) => ((await get(name, '/api/approvals?mine=pending')).json() as ApprovalListResponse).approvals;

beforeEach(async () => {
  ({ ctx, app } = await makeApp());
  tk = { Alice: await loginAs(app, 'Alice'), Bob: await loginAs(app, 'Bob') };
});
afterEach(() => ctx.agents.stop());

/** 친구들 Room: Alice의 Agent가 카드 수정을 제안한다 (승인자는 소유자를 뺀 사람 구성원 = Bob) */
function proposeInFriends(cardId: string | undefined, title?: string, body?: string): string {
  const r = dispatch(ctx, { kind: 'agent', agentId: A.alice }, { type: 'propose_edit', roomId: R.friends, cardId, title, body, rationale: '더 명확해서' });
  return r.data.approvalId as string;
}
const makeCard = (title = '주말 계획', body = '초안') =>
  dispatch(ctx, { kind: 'human', userId: alice }, { type: 'create_card', roomId: R.friends, title, body }).data.cardId as string;

describe('edit 승인: 권한·중복·적용', () => {
  it('승인자만 투표할 수 있고, approve하면 보드 카드에 적용되며, 중복은 409', async () => {
    const cardId = makeCard();
    const approvalId = proposeInFriends(cardId, undefined, '수정본');

    // 미해결 승인 목록: 승인자(Bob)에게만 보인다
    expect((await pendingFor('Bob')).map((a) => a.approvalId)).toEqual([approvalId]);
    expect(await pendingFor('Alice')).toEqual([]);

    // 요청자의 소유자(Alice)는 승인자가 아니다
    const denied = await vote('Alice', approvalId, { decision: 'approve' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('not_approver');
    expect(ctx.repo.getCard(R.friends, cardId)!.body).toBe('초안');

    const ok = await vote('Bob', approvalId, { decision: 'approve' });
    expect(ok.statusCode).toBe(200);
    const out = ok.json() as VoteResponse;
    expect(out.status).toBe('approved');
    expect(out.approval).toMatchObject({ approvalId, status: 'approved', kind: 'edit' });
    expect(types(R.friends, 'approval_voted', 'approval_resolved', 'card_updated').map((e) => e.type)).toEqual([
      'approval_voted',
      'approval_resolved',
      'card_updated',
    ]);
    expect(ctx.repo.getCard(R.friends, cardId)).toMatchObject({ body: '수정본', version: 2 });
    expect(await pendingFor('Bob')).toEqual([]);

    // 이미 해소됨
    const dup = await vote('Bob', approvalId, { decision: 'approve' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('already_resolved');
  });

  it('/resolve는 vote와 같은 계약이다', async () => {
    const cardId = makeCard();
    const approvalId = proposeInFriends(cardId, '새 제목');
    const res = await post('Bob', `/api/approvals/${approvalId}/resolve`, { decision: 'approve' });
    expect(res.statusCode).toBe(200);
    expect(ctx.repo.getCard(R.friends, cardId)!.title).toBe('새 제목');
  });

  it('알 수 없는 승인 id는 404', async () => {
    expect((await vote('Bob', 'appr_nope', { decision: 'approve' })).statusCode).toBe(404);
    expect((await get('Bob', '/api/approvals/appr_nope')).statusCode).toBe(404);
  });

  it('새 카드 제안은 approve하면 카드가 만들어진다(ours), reject하면 아무 일도 없다', async () => {
    const a1 = proposeInFriends(undefined, '새 카드', '내용');
    const a2 = proposeInFriends(undefined, '거절될 카드', '내용');
    await vote('Bob', a1, { decision: 'approve' });
    await vote('Bob', a2, { decision: 'reject' });
    const created = types(R.friends, 'card_created').filter((e) => e.type === 'card_created' && e.title === '새 카드');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ ownerTag: 'ours', actorKind: 'system' });
    expect(types(R.friends, 'card_created').some((e) => e.type === 'card_created' && e.title === '거절될 카드')).toBe(false);
    const resolved = types(R.friends, 'approval_resolved');
    expect(resolved.map((e) => e.type === 'approval_resolved' && e.outcome)).toEqual(['approved', 'rejected']);
  });

  it("승인자가 'edit'로 수정안을 내면 수정본이 반영되고 edited로 해소된다", async () => {
    const cardId = makeCard();
    const approvalId = proposeInFriends(cardId, undefined, 'AI 초안');
    expect((await vote('Bob', approvalId, { decision: 'edit', edited: {} })).statusCode).toBe(400);
    const res = await vote('Bob', approvalId, { decision: 'edit', edited: { body: 'Bob이 고친 내용' } });
    expect(res.json().status).toBe('edited');
    expect(ctx.repo.getCard(R.friends, cardId)!.body).toBe('Bob이 고친 내용');
    expect(types(R.friends, 'approval_resolved')[0]).toMatchObject({ outcome: 'edited', applied: { cardId, body: 'Bob이 고친 내용' } });
  });

  it('합의된 카드를 고치는 제안은 승인해도 적용되지 않고(409) 승인은 대기로 남는다', async () => {
    const cardId = makeCard();
    ctx.repo.setCardAgreed(R.friends, cardId);
    const approvalId = proposeInFriends(cardId, '몰래 바꾸기');
    const res = await vote('Bob', approvalId, { decision: 'approve' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('needs_decision_approval');
    expect(ctx.repo.getApproval(approvalId)!.status).toBe('pending');
    expect(ctx.repo.getCard(R.friends, cardId)!.title).toBe('주말 계획');
    // 거절은 할 수 있다
    expect((await vote('Bob', approvalId, { decision: 'reject' })).json().status).toBe('rejected');
  });
});

describe('decision 승인: 2인 승인과 합의', () => {
  const ask = () =>
    dispatch(ctx, { kind: 'room_agent', roomAgentId: RA.friends }, {
      type: 'request_approval',
      roomId: R.friends,
      question: '모임 요일은?',
      options: ['토요일', '일요일'],
    }).data.approvalId as string;

  it('승인자 전원이 같은 선택지를 승인하면 합의 카드·agreement_formed·room 기억이 생긴다', async () => {
    const approvalId = ask();
    expect(types(R.friends, 'approval_requested')[0]).toMatchObject({ approvers: [alice, bob], kind: 'decision' });

    // 선택지 없이 approve는 400
    expect((await vote('Alice', approvalId, { decision: 'approve' })).statusCode).toBe(400);
    expect((await vote('Alice', approvalId, { decision: 'approve', option: '월요일' })).statusCode).toBe(400);

    const first = await vote('Alice', approvalId, { decision: 'approve', option: '토요일' });
    expect(first.json().status).toBe('pending');
    expect(types(R.friends, 'agreement_formed')).toHaveLength(0);
    // 같은 사람 중복 투표
    const dup = await vote('Alice', approvalId, { decision: 'approve', option: '토요일' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('already_voted');
    // 다른 선택지
    const mismatch = await vote('Bob', approvalId, { decision: 'approve', option: '일요일' });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().code).toBe('option_mismatch');
    // Alice는 이미 투표했으므로 목록에서 빠지고 Bob에게는 남는다
    expect(await pendingFor('Alice')).toEqual([]);
    expect((await pendingFor('Bob')).map((a) => a.approvalId)).toEqual([approvalId]);

    const second = await vote('Bob', approvalId, { decision: 'approve', option: '토요일' });
    expect(second.json()).toMatchObject({ status: 'approved', approval: { resolvedOption: '토요일' } });

    expect(types(R.friends, 'approval_resolved')[0]).toMatchObject({ outcome: 'approved', option: '토요일' });
    const agreed = types(R.friends, 'agreement_formed')[0] as Extract<RoomEvent, { type: 'agreement_formed' }>;
    expect(agreed.memberIds.sort()).toEqual([alice, bob].sort());
    const card = ctx.repo.getCard(R.friends, agreed.cardId)!;
    expect(card).toMatchObject({ agreed: true, ownerTag: 'ours', body: '토요일' });
    expect(ctx.repo.listMemoryItems(`room:${R.friends}`).some((m) => m.kind === 'agreement' && m.text.includes('토요일'))).toBe(true);
    // 합의된 카드는 직접 수정할 수 없다
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${R.friends}/cards/${agreed.cardId}`,
      headers: auth(tk.Alice!),
      payload: { patch: { title: '바꿈' }, baseVersion: card.version },
    });
    expect(patch.statusCode).toBe(403);
  });

  it('한 명이라도 거절하면 즉시 rejected이고 합의는 생기지 않는다', async () => {
    const approvalId = ask();
    await vote('Alice', approvalId, { decision: 'approve', option: '토요일' });
    const r = await vote('Bob', approvalId, { decision: 'reject' });
    expect(r.json().status).toBe('rejected');
    expect(types(R.friends, 'agreement_formed')).toHaveLength(0);
    // 해소 뒤에는 더 투표할 수 없다
    expect((await vote('Alice', approvalId, { decision: 'reject' })).statusCode).toBe(409);
  });

  it("decision에는 'edit'를 쓸 수 없다", async () => {
    const approvalId = ask();
    const r = await vote('Bob', approvalId, { decision: 'edit', edited: { title: 'x' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('edit_not_supported');
  });
});

describe('decision 해소 후 Agent 재개', () => {
  it('awaiting이던 Agent가 승인 후 깨어나 결과를 이어서 처리하고 awaiting이 풀린다', async () => {
    ctx.agents.start();
    dispatch(ctx, { kind: 'human', userId: alice }, { type: 'send_message', roomId: R.myAlice, text: '이 일정 확정해줘', to: A.alice });
    await ctx.agents.drain();

    const req = types(R.myAlice, 'approval_requested')[0] as Extract<RoomEvent, { type: 'approval_requested' }>;
    expect(req).toMatchObject({ kind: 'decision', approvers: [alice], options: ['확정', '보류'] });
    const ref = { agentId: A.alice, ownerUserId: alice, homeRoomId: R.myAlice };
    expect(buildAgentState(ref, ctx.store.listAll(R.myAlice)).activity).toBe('awaiting');
    const turnsBefore = types(R.myAlice, 'agent_turn_started').length;

    const res = await vote('Alice', req.approvalId, { decision: 'approve', option: '확정' });
    expect(res.json().status).toBe('approved');
    await ctx.agents.drain();

    const started = types(R.myAlice, 'agent_turn_started');
    expect(started).toHaveLength(turnsBefore + 1);
    expect(started.at(-1)).toMatchObject({ trigger: { reason: 'approval_resolved' } });
    const msgs = types(R.myAlice, 'message').filter((e) => e.type === 'message' && e.actorId === A.alice);
    expect(msgs.at(-1)).toMatchObject({ text: expect.stringContaining('"확정"') });
    expect(buildAgentState(ref, ctx.store.listAll(R.myAlice)).activity).toBe('idle');
  });

  it('거절돼도 Agent는 깨어나 보류를 알린다', async () => {
    ctx.agents.start();
    dispatch(ctx, { kind: 'human', userId: alice }, { type: 'send_message', roomId: R.myAlice, text: '이 일정 확정해줘', to: A.alice });
    await ctx.agents.drain();
    const req = types(R.myAlice, 'approval_requested')[0] as Extract<RoomEvent, { type: 'approval_requested' }>;
    await vote('Alice', req.approvalId, { decision: 'reject' });
    await ctx.agents.drain();
    const msgs = types(R.myAlice, 'message').filter((e) => e.type === 'message' && e.actorId === A.alice);
    expect(msgs.at(-1)).toMatchObject({ text: expect.stringContaining('승인되지 않았어요') });
  });
});

describe('Agent 방문 takeout / report', () => {
  const mandate = { text: '토요일 오후 일정 이야기만', allowedActions: ['chat' as const, 'comment' as const] };
  const TAKEOUT = '토요일 오후 3시가 좋다고 합니다.';
  const REPORT = '내부 보고: Bob이 예산에 민감해 보임.';

  async function visitAndEnd(): Promise<{ visitId: string; approvalId: string }> {
    const visitId = (await post('Alice', `/api/rooms/${R.myBob}/visits/agent`, { mandate })).json().visitId as string;
    await post('Bob', `/api/visits/${visitId}/accept`, { permissions: ['chat', 'comment'] });
    endVisit(ctx, { kind: 'agent', agentId: A.alice }, visitId, { takeout: TAKEOUT, report: REPORT });
    const req = types(R.myBob, 'approval_requested')[0] as Extract<RoomEvent, { type: 'approval_requested' }>;
    return { visitId, approvalId: req.approvalId };
  }

  it('종료 직후 takeout은 visit 네임스페이스에만 있고 소유자 쪽에는 없다. 호스트가 승인해야 옮겨진다', async () => {
    const { visitId, approvalId } = await visitAndEnd();
    expect(types(R.myBob, 'approval_requested')[0]).toMatchObject({ kind: 'takeout', approvers: [bob], actorKind: 'system' });

    const staged = ctx.repo.listMemoryItems(nsVisit(visitId));
    expect(staged.map((m) => m.text)).toEqual([TAKEOUT]);
    expect(ctx.repo.listMemoryItems(nsPrivate(A.alice))).not.toContainEqual(expect.objectContaining({ text: TAKEOUT }));
    // Alice(보낸 소유자)는 호스트의 승인에 개입할 수 없고, 존재도 보이지 않는다
    expect((await vote('Alice', approvalId, { decision: 'approve' })).statusCode).toBe(404);
    // 승인 전에는 Alice의 Agent가 어느 Room에서 recall해도 후보 항목이 없다
    for (const room of [R.myAlice, R.friends, R.team]) {
      expect(ctx.memory.recallForTurn(A.alice, room).items.map((m) => m.text)).not.toContain(TAKEOUT);
    }

    expect((await pendingFor('Bob')).map((a) => a.approvalId)).toEqual([approvalId]);
    const ok = await vote('Bob', approvalId, { decision: 'approve' });
    expect(ok.json().status).toBe('approved');

    expect(ctx.repo.listMemoryItems(nsVisit(visitId))).toEqual([]);
    expect(ctx.repo.listMemoryItems(nsPrivate(A.alice)).map((m) => m.text)).toContain(TAKEOUT);
    // 소유자의 My Room에 private:Alice 기억 이벤트가 남고 Bob에게는 보이지 않는다
    const retained = types(R.myAlice, 'memory_retained').filter((e) => e.type === 'memory_retained' && e.ns === nsPrivate(A.alice));
    expect(retained).toHaveLength(1);
    expect(retained[0]!.visibility).toBe(`private:${alice}`);
    expect(ctx.store.listVisible(bob, R.myAlice).some((e) => e.type === 'memory_retained')).toBe(false);
    // Alice가 My Room에 혼자 있으면(private ns 조건) Agent가 이 기억을 recall한다
    dispatch(ctx, { kind: 'human', userId: alice }, { type: 'enter_room', roomId: R.myAlice });
    expect(ctx.memory.recallForTurn(A.alice, R.myAlice).items.map((m) => m.text)).toContain(TAKEOUT);
  });

  it('호스트가 거절하면 takeout은 소유자 쪽으로 가지 않고 폐기된다', async () => {
    const { visitId, approvalId } = await visitAndEnd();
    expect((await vote('Bob', approvalId, { decision: 'reject' })).json().status).toBe('rejected');
    expect(ctx.repo.listMemoryItems(nsVisit(visitId))).toEqual([]);
    expect(ctx.repo.listMemoryItems(nsPrivate(A.alice)).map((m) => m.text)).not.toContain(TAKEOUT);
    expect(types(R.myAlice, 'memory_retained').some((e) => e.type === 'memory_retained' && e.ns === nsPrivate(A.alice))).toBe(false);
  });

  it('report는 소유자에게만 보이고 호스트에게는 어떤 경로로도 보이지 않는다', async () => {
    const { visitId } = await visitAndEnd();
    const all = (roomId: string, viewer: string) => ctx.store.listVisible(viewer, roomId);
    // 이벤트 로그: 출발 Room의 private:Alice
    const report = types(R.myAlice, 'visit_report')[0]!;
    expect(report).toMatchObject({ visibility: `private:${alice}`, summary: REPORT });
    expect(all(R.myAlice, alice).some((e) => e.type === 'visit_report')).toBe(true);
    expect(all(R.myAlice, bob).some((e) => e.type === 'visit_report')).toBe(false);
    // 호스트 Room 어디에도 보고 문구가 없다 (공개 takeout만 있다)
    const hostJson = JSON.stringify(all(R.myBob, bob));
    expect(hostJson).not.toContain(REPORT);
    expect(hostJson).toContain(TAKEOUT);
    // REST: Bob은 Alice의 Room 스냅샷을 열 수 없고, 방문 DTO에도 보고가 없다
    expect((await get('Bob', `/api/rooms/${R.myAlice}/snapshot`)).statusCode).toBe(403);
    const snap = (await get('Bob', `/api/rooms/${R.myBob}/snapshot`)).body;
    expect(snap).not.toContain(REPORT);
    expect(visitId).toBeTruthy();
    // 승인 목록에도 보고는 없다
    expect(JSON.stringify(await pendingFor('Bob'))).not.toContain(REPORT);
  });

  it('takeout이 비어 있으면 승인 요청이 생기지 않는다(report만 소유자에게)', async () => {
    const visitId = (await post('Alice', `/api/rooms/${R.myBob}/visits/agent`, { mandate })).json().visitId as string;
    await post('Bob', `/api/visits/${visitId}/accept`, { permissions: ['chat'] });
    endVisit(ctx, { kind: 'agent', agentId: A.alice }, visitId, { report: REPORT });
    expect(types(R.myBob, 'approval_requested')).toHaveLength(0);
    expect(ctx.repo.listMemoryItems(nsVisit(visitId))).toEqual([]);
  });
});
