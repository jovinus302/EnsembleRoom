import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MetricsResponse } from '@ensemble/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/context';
import { computeCounters } from '../src/domain/metrics';
import { SEED, auth, loginAs, makeApp } from './helpers';

const { alice, bob } = SEED.users;
const R = SEED.rooms;
const A = SEED.agents;

let ctx: AppContext;
let app: FastifyInstance;
let tk: Record<string, string>;

const get = async (name: string, url = '/api/metrics') => app.inject({ method: 'GET', url, headers: auth(tk[name]!) });
const metrics = async (name: string, url?: string) => (await get(name, url)).json() as MetricsResponse;

beforeEach(async () => {
  ({ ctx, app } = await makeApp());
  tk = { Alice: await loginAs(app, 'Alice'), Bob: await loginAs(app, 'Bob') };
});
afterEach(() => ctx.agents.stop());

describe('지표 API', () => {
  it('토큰 없이는 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/metrics' })).statusCode).toBe(401);
  });

  it('이벤트가 없으면 비율은 null, 합계는 0이다', () => {
    const c = computeCounters([]);
    expect(c.visits.acceptRate).toBeNull();
    expect(c.approvals.avgResolveMs).toBeNull();
    expect(c.agentTurns.started).toBe(0);
  });

  it('승인 요청·해소 수와 평균 소요, 방문·Leave·재합류를 이벤트에서 센다', () => {
    const base = { roomId: R.friends, actorKind: 'human' as const, actorId: alice };
    const t0 = ctx.store.append({ ...base, type: 'approval_requested', approvalId: 'ap1', approvers: [alice], kind: 'edit', summary: 's' });
    ctx.store.append({ ...base, type: 'approval_resolved', approvalId: 'ap1', outcome: 'edited' });
    ctx.store.append({ ...base, type: 'approval_requested', approvalId: 'ap2', approvers: [alice], kind: 'decision', summary: 's' });
    ctx.store.append({ ...base, type: 'member_left', userId: alice, implicit: false, mandate: { text: '대리', allowedActions: [] } });
    ctx.store.append({ ...base, type: 'member_rejoined', userId: alice, missedCount: 5 });
    ctx.store.append({ ...base, type: 'agreement_formed', cardId: 'c1', memberIds: [alice, bob] });
    expect(t0.ts).toBeGreaterThan(0);

    const m = computeCounters(ctx.store.listAll(R.friends));
    expect(m.approvals).toMatchObject({ requested: 2, resolved: 1, pending: 1, edited: 1, editedRate: 1, byKind: { edit: 1, decision: 1 } });
    expect(m.approvals.avgResolveMs).not.toBeNull();
    expect(m.presence).toMatchObject({ leavesExplicit: 1, leavesWithMandate: 1, mandateRate: 1, rejoins: 1, rejoinRate: 1, missedChanges: 5 });
    expect(m.agreements).toBe(1);
  });

  it('방문: 수락이 요청보다 많아지지 않는다(DM 미러 중복, 요청 이벤트를 못 보는 방문자)', () => {
    const base = { actorKind: 'human' as const, actorId: bob };
    const ev = [
      { ...base, roomId: R.dmAliceBob, type: 'visit_requested' as const, visitId: 'v1', visitorKind: 'human' as const, visitorUserId: bob },
      { ...base, roomId: R.dmAliceBob, type: 'visit_accepted' as const, visitId: 'v1', permissions: ['chat' as const] },
      { ...base, roomId: R.myAlice, type: 'visit_accepted' as const, visitId: 'v1', permissions: ['chat' as const] },
      // 요청 이벤트가 보이지 않는 방문(DM 없음): 수락만 보인다
      { ...base, roomId: R.myAlice, type: 'visit_accepted' as const, visitId: 'v2', permissions: ['chat' as const] },
    ].map((e) => ctx.store.append(e));
    const v = computeCounters(ev).visits;
    expect(v.requested).toBe(2);
    expect(v.accepted).toBe(2);
    expect(v.acceptRate).toBe(1);
    expect(v.humanRequested + v.agentSent).toBe(v.requested);
  });

  it('REST: 구성원은 Room 지표를 받고 합계에 반영된다', async () => {
    ctx.store.append({ roomId: R.friends, actorKind: 'human', actorId: alice, type: 'member_entered', userId: alice, role: 'member' });
    ctx.store.append({ roomId: R.friends, actorKind: 'human', actorId: alice, type: 'member_rejoined', userId: alice, missedCount: 2 });
    const m = await metrics('Alice', `/api/metrics?roomId=${R.friends}`);
    expect(m.perRoom).toHaveLength(1);
    expect(m.perRoom[0]).toMatchObject({ roomId: R.friends, presence: { missedChanges: 2 } });
    expect(m.rooms.repeatUse).toBe(1);
    expect(m.totals.presence.rejoins).toBe(1);
  });
});

describe('지표 API 가시성', () => {
  it('남의 my Room은 roomId로 조회하면 403, 전체 합계에는 그 내용이 들어오지 않는다', async () => {
    ctx.store.append({ roomId: R.myAlice, actorKind: 'human', actorId: alice, type: 'member_entered', userId: alice, role: 'owner' });
    ctx.store.append({ roomId: R.myAlice, actorKind: 'agent', actorId: A.alice, type: 'agent_turn_started', agentId: A.alice, turnId: 't1', trigger: { seq: 1, reason: 'x' } });
    expect((await get('Bob', `/api/metrics?roomId=${R.myAlice}`)).statusCode).toBe(403);
    expect((await get('Bob', '/api/metrics?roomId=nope')).statusCode).toBe(404);

    const bobView = await metrics('Bob');
    expect(bobView.perRoom.find((r) => r.roomId === R.myAlice)).toBeUndefined();
    const aliceView = await metrics('Alice');
    expect(aliceView.perRoom.find((r) => r.roomId === R.myAlice)?.agentTurns.started).toBe(1);
    expect(aliceView.totals.agentTurns.started).toBeGreaterThan(bobView.totals.agentTurns.started);
  });

  it('private 이벤트(비공개 기억)는 소유자에게만 센다', async () => {
    ctx.store.append({
      roomId: R.friends,
      actorKind: 'agent',
      actorId: A.alice,
      visibility: `private:${alice}`,
      type: 'memory_retained',
      itemId: 'm1',
      ns: `agent:${A.alice}:private`,
      kind: 'fact',
    });
    expect((await metrics('Alice')).totals.memoryRetained).toBe(1);
    expect((await metrics('Bob')).totals.memoryRetained).toBe(0);
  });
});
