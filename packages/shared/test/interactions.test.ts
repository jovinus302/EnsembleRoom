import { describe, expect, it } from 'vitest';
import { activeLinks, episodeFlow, EventPayloadSchema, indexInteractions, pickPreviewInteraction } from '../src';
import { makeLog } from './helpers';

const isAgentId = (id: string) => id.startsWith('ag_') || id.startsWith('ra_');
const A = { actorKind: 'agent' as const };
const RA = { actorKind: 'room_agent' as const, actorId: 'ra_team' };
const SYS = { actorKind: 'system' as const, actorId: null };

/** Alice -> Room Agent 호출 -> ask_agents([bob, dana]) -> 답 -> collect -> 승인 */
function teamScenario(opts: { danaAnswers?: boolean; collected?: boolean; resolved?: boolean } = {}) {
  const { danaAnswers = true, collected = true, resolved = false } = opts;
  const { events, push } = makeLog('room1');
  push({ type: 'message', text: '금요일 회고 당겨도 될까?' }); // 1 human
  push({ type: 'agent_turn_started', agentId: 'ra_team', turnId: 't1', trigger: { seq: 1, reason: 'room_agent_call' } }, { ...RA, turnId: 't1' }); // 2
  push({ type: 'message', text: '일정 괜찮을까요?', recipients: ['ag_bob', 'ag_dana'] }, { ...RA, turnId: 't1' }); // 3 ask
  push({ type: 'agent_turn_ended', agentId: 'ra_team', turnId: 't1', result: 'acted' }, { ...RA, turnId: 't1' }); // 4
  push({ type: 'agent_turn_started', agentId: 'ag_bob', turnId: 't2', trigger: { seq: 3, reason: 'a2a_ask' } }, { ...A, actorId: 'ag_bob', turnId: 't2' }); // 5
  push({ type: 'message', text: '좋아요', to: 'ra_team', replyTo: 3 }, { ...A, actorId: 'ag_bob', turnId: 't2' }); // 6 answer
  push({ type: 'agent_turn_ended', agentId: 'ag_bob', turnId: 't2', result: 'acted' }, { ...A, actorId: 'ag_bob', turnId: 't2' }); // 7
  push({ type: 'agent_turn_started', agentId: 'ag_dana', turnId: 't3', trigger: { seq: 3, reason: 'a2a_ask' } }, { ...A, actorId: 'ag_dana', turnId: 't3' }); // 8
  if (danaAnswers) {
    push({ type: 'message', text: '괜찮아요', to: 'ra_team', replyTo: 3 }, { ...A, actorId: 'ag_dana', turnId: 't3' }); // 9
    push({ type: 'agent_turn_ended', agentId: 'ag_dana', turnId: 't3', result: 'acted' }, { ...A, actorId: 'ag_dana', turnId: 't3' }); // 10
  }
  if (collected) {
    push({ type: 'agent_turn_started', agentId: 'ra_team', turnId: 't4', trigger: { seq: 3, reason: 'a2a_collect' } }, { ...RA, turnId: 't4' }); // 11
    push({ type: 'message', text: '정리하면 가능해요', replyTo: 3 }, { ...RA, turnId: 't4' }); // 12
    push({ type: 'approval_requested', approvalId: 'ap1', approvers: ['alice', 'bob'], kind: 'edit', summary: '14시 반' }, { ...RA, turnId: 't4' }); // 13
  }
  if (resolved) push({ type: 'approval_resolved', approvalId: 'ap1', outcome: 'approved' }, SYS);
  return events;
}

describe('message 스키마', () => {
  it('recipients 1~3, replyTo 양의 정수만 허용한다', () => {
    expect(EventPayloadSchema.safeParse({ type: 'message', text: 'q', recipients: ['a'], replyTo: 3 }).success).toBe(true);
    expect(EventPayloadSchema.safeParse({ type: 'message', text: 'q', recipients: [] }).success).toBe(false);
    expect(EventPayloadSchema.safeParse({ type: 'message', text: 'q', recipients: ['a', 'b', 'c', 'd'] }).success).toBe(false);
    expect(EventPayloadSchema.safeParse({ type: 'message', text: 'q', replyTo: 0 }).success).toBe(false);
  });
});

describe('indexInteractions 분류', () => {
  it('h2a_direct / h2a_delegate', () => {
    const { events, push } = makeLog();
    push({ type: 'message', text: 'hi', to: 'ag_alice' }); // 1
    push({ type: 'message', text: '그냥 말', to: 'bob' }); // 2
    push({ type: 'member_left', userId: 'alice', implicit: false, agentId: 'ag_alice', mandate: { text: '위임', allowedActions: ['chat'] } }); // 3
    push({ type: 'member_left', userId: 'bob', implicit: true }); // 4
    push({ type: 'visit_requested', visitId: 'v1', visitorKind: 'agent', visitorUserId: 'alice', visitorAgentId: 'ag_alice', mandate: { text: 'm', allowedActions: ['chat'] } }); // 5
    const ix = indexInteractions(events, { isAgentId });
    expect(ix.list.map((i) => [i.seq, i.kind])).toEqual([
      [1, 'h2a_direct'],
      [3, 'h2a_delegate'],
      [5, 'h2a_delegate'],
    ]);
    expect(ix.bySeq.get(3)!.toIds).toEqual(['ag_alice']);
    expect(ix.bySeq.get(1)!.rootSeq).toBe(1);
  });

  it('a2a_ask / answer / result / approval 과 스레드', () => {
    const ix = indexInteractions(teamScenario(), { isAgentId });
    expect(ix.list.map((i) => [i.seq, i.kind])).toEqual([
      [3, 'a2a_ask'],
      [6, 'a2a_answer'],
      [9, 'a2a_answer'],
      [12, 'a2a_result'],
      [13, 'a2h_approval'],
    ]);
    const ask = ix.bySeq.get(3)!;
    expect(ask.toIds).toEqual(['ag_bob', 'ag_dana']);
    expect(ask.rootSeq).toBe(1);
    expect(ix.bySeq.get(6)).toMatchObject({ fromId: 'ag_bob', toIds: ['ra_team'], threadSeq: 3 });
    expect(ix.bySeq.get(13)).toMatchObject({ approvalId: 'ap1', toIds: ['alice', 'bob'], pending: true, threadSeq: 3, rootSeq: 1 });
    const th = ix.threads.get(3)!;
    expect(th.answers).toHaveLength(2);
    expect(th.results).toHaveLength(1);
    expect(th.approvals).toHaveLength(1);
    expect(th.open).toBe(false);
    expect(ask.waitingFor).toEqual([]);
  });

  it('waitingFor: 답도 종료도 없는 수신자만, pass 종료는 정산으로 센다', () => {
    const open = indexInteractions(teamScenario({ danaAnswers: false, collected: false }), { isAgentId });
    expect(open.bySeq.get(3)!.waitingFor).toEqual(['ag_dana']);
    expect(open.threads.get(3)!.open).toBe(true);
    expect(open.bySeq.get(3)!.pending).toBe(true);

    const events = teamScenario({ danaAnswers: false, collected: false });
    events.push({
      type: 'agent_turn_ended',
      agentId: 'ag_dana',
      turnId: 't3',
      result: 'pass',
      passReason: 'nothing_to_add',
      roomId: 'room1',
      seq: events.length + 1,
      ts: 2_000_000_000_000,
      actorKind: 'agent',
      actorId: 'ag_dana',
      visibility: 'room',
    } as never);
    const settled = indexInteractions(events, { isAgentId });
    expect(settled.bySeq.get(3)!.waitingFor).toEqual([]);
  });

  it('승인 해소 후 pending 해제', () => {
    const ix = indexInteractions(teamScenario({ resolved: true }), { isAgentId });
    expect(ix.bySeq.get(13)!.pending).toBe(false);
  });

  it('a2h_ask / 레거시 ask / rejoin·visit report', () => {
    const { events, push } = makeLog();
    push({ type: 'message', text: '밥 먹었어?', to: 'bob' }, { ...A, actorId: 'ag_alice' }); // 1
    push({ type: 'message', text: 'ping', to: 'ag_bob' }, { ...A, actorId: 'ag_alice' }); // 2
    push({ type: 'member_rejoined', userId: 'alice', missedCount: 2 }, SYS); // 3
    push({ type: 'member_rejoined', userId: 'bob', missedCount: 0 }, SYS); // 4
    push({ type: 'visit_report', visitId: 'v1', summary: 's' }, { ...A, actorId: 'ag_alice' }); // 5
    push({ type: 'message', text: '잡담' }, { ...A, actorId: 'ag_alice' }); // 6
    const ix = indexInteractions(events, { isAgentId });
    expect(ix.list.map((i) => [i.seq, i.kind])).toEqual([
      [1, 'a2h_ask'],
      [2, 'a2a_ask'],
      [3, 'a2h_report'],
      [5, 'a2h_report'],
    ]);
    expect(ix.bySeq.get(2)!.legacy).toBe(true);
    expect(ix.threads.size).toBe(0);
    expect(ix.bySeq.get(3)!.toIds).toEqual(['alice']);
  });

  it('collect 턴에서 소유자에게 하는 말은 a2h_report, 답에서 넘긴 승인은 스레드에 연결', () => {
    const { events, push } = makeLog();
    push({ type: 'message', text: '조율해 줘', to: 'ag_alice' }); // 1
    push({ type: 'agent_turn_started', agentId: 'ag_alice', turnId: 't1', trigger: { seq: 1, reason: 'addressed' } }, { ...A, actorId: 'ag_alice', turnId: 't1' }); // 2
    push({ type: 'message', text: '물어요', recipients: ['ag_bob'] }, { ...A, actorId: 'ag_alice', turnId: 't1' }); // 3
    push({ type: 'agent_turn_started', agentId: 'ag_bob', turnId: 't2', trigger: { seq: 3, reason: 'a2a_ask' } }, { ...A, actorId: 'ag_bob', turnId: 't2' }); // 4
    push({ type: 'message', text: '확인 중', to: 'ag_alice', replyTo: 3 }, { ...A, actorId: 'ag_bob', turnId: 't2' }); // 5
    push({ type: 'approval_requested', approvalId: 'ap1', approvers: ['bob'], kind: 'decision', summary: '7시?' }, { ...A, actorId: 'ag_bob', turnId: 't2' }); // 6
    push({ type: 'agent_turn_started', agentId: 'ag_alice', turnId: 't3', trigger: { seq: 3, reason: 'a2a_collect' } }, { ...A, actorId: 'ag_alice', turnId: 't3' }); // 7
    push({ type: 'message', text: 'Alice님 보고', to: 'alice', replyTo: 3 }, { ...A, actorId: 'ag_alice', turnId: 't3' }); // 8
    const ix = indexInteractions(events, { isAgentId });
    expect(ix.list.map((i) => [i.seq, i.kind])).toEqual([
      [1, 'h2a_direct'],
      [3, 'a2a_ask'],
      [5, 'a2a_answer'],
      [6, 'a2h_approval'],
      [8, 'a2h_report'],
    ]);
    expect(ix.bySeq.get(6)!.threadSeq).toBe(3);
    expect(ix.bySeq.get(8)).toMatchObject({ threadSeq: 3, toIds: ['alice'], rootSeq: 1 });
    expect(ix.threads.get(3)!.results).toHaveLength(0);
  });

  it('rootSeq: approval_resolved 후속 턴은 승인 요청의 루트로 올라가고, 순환은 null', () => {
    const { events, push } = makeLog();
    push({ type: 'message', text: '정해 줘', to: 'ag_bob' }); // 1
    push({ type: 'agent_turn_started', agentId: 'ag_bob', turnId: 't1', trigger: { seq: 1, reason: 'addressed' } }, { ...A, actorId: 'ag_bob', turnId: 't1' }); // 2
    push({ type: 'approval_requested', approvalId: 'ap1', approvers: ['bob'], kind: 'decision', summary: 's' }, { ...A, actorId: 'ag_bob', turnId: 't1' }); // 3
    push({ type: 'approval_resolved', approvalId: 'ap1', outcome: 'approved' }, SYS); // 4
    push({ type: 'agent_turn_started', agentId: 'ag_bob', turnId: 't2', trigger: { seq: 4, reason: 'approval_resolved' } }, { ...A, actorId: 'ag_bob', turnId: 't2' }); // 5
    push({ type: 'approval_requested', approvalId: 'ap2', approvers: ['alice'], kind: 'edit', summary: 's2' }, { ...A, actorId: 'ag_bob', turnId: 't2' }); // 6
    expect(indexInteractions(events, { isAgentId }).bySeq.get(6)!.rootSeq).toBe(1);

    const loop = makeLog();
    // seq1: 턴 시작이 자기 자신(seq1)을 트리거로 가리킴 -> 사람에 닿지 못한다
    loop.push({ type: 'agent_turn_started', agentId: 'ag_x', turnId: 'tx', trigger: { seq: 1, reason: 'agent_chain' } }, { ...A, actorId: 'ag_x', turnId: 'tx' });
    loop.push({ type: 'message', text: 'x', to: 'ag_y' }, { ...A, actorId: 'ag_x', turnId: 'tx' });
    expect(indexInteractions(loop.events, { isAgentId }).bySeq.get(2)!.rootSeq).toBeNull();
  });
});

describe('activeLinks', () => {
  const base = teamScenario();
  const ts = (seq: number) => base.find((e) => e.seq === seq)!.ts;

  it('열린 스레드는 pending, 닫힌 뒤에는 마지막 답부터 window 동안만', () => {
    const open = indexInteractions(teamScenario({ danaAnswers: false, collected: false }), { isAgentId });
    const links = activeLinks(open, ts(8) + 60_000).filter((l) => l.channel === 'a2a' && !l.reverse);
    expect(links.map((l) => [l.fromId, l.toId, l.pending])).toEqual([
      ['ra_team', 'ag_bob', true],
      ['ra_team', 'ag_dana', true],
    ]);

    const closed = indexInteractions(base, { isAgentId });
    const lastTs = ts(12);
    expect(activeLinks(closed, lastTs + 1000).some((l) => l.channel === 'a2a' && !l.reverse && !l.pending)).toBe(true);
    expect(activeLinks(closed, lastTs + 8000).filter((l) => l.channel === 'a2a')).toEqual([]);
  });

  it('답은 reverse, window 경과 뒤 사라진다. 대기 중인 승인은 해소될 때까지 유지', () => {
    const ix = indexInteractions(base, { isAgentId });
    const ans = activeLinks(ix, ts(9) + 1000).filter((l) => l.reverse);
    expect(ans.map((l) => [l.fromId, l.toId])).toContainEqual(['ra_team', 'ag_dana']);
    const far = activeLinks(ix, ts(13) + 3_600_000);
    expect(far.filter((l) => l.channel === 'a2a')).toEqual([]);
    expect(far.filter((l) => l.channel === 'a2h').map((l) => [l.toId, l.pending])).toEqual([
      ['alice', true],
      ['bob', true],
    ]);
    const done = indexInteractions(teamScenario({ resolved: true }), { isAgentId });
    expect(activeLinks(done, ts(13) + 3_600_000)).toEqual([]);
  });

  it('h2a_direct는 4초 동안만', () => {
    const { events, push } = makeLog();
    push({ type: 'message', text: 'hi', to: 'ag_alice' });
    const ix = indexInteractions(events, { isAgentId });
    const t = events[0]!.ts;
    expect(activeLinks(ix, t + 3000)).toHaveLength(1);
    expect(activeLinks(ix, t + 5000)).toHaveLength(0);
    expect(activeLinks(ix, t + 5000, { windowMs: 8000 })).toHaveLength(0);
  });

  it('replaying: 시간 감쇠 없이 pending + 마지막 상호작용 1개만 남긴다', () => {
    const ix = indexInteractions(base, { isAgentId });
    const links = activeLinks(ix, ts(13) + 86_400_000, { replaying: true });
    expect(links.filter((l) => l.pending).map((l) => l.toId)).toEqual(['alice', 'bob']);

    const { events, push } = makeLog();
    push({ type: 'message', text: 'a', to: 'ag_alice' });
    push({ type: 'message', text: 'b', to: 'ag_bob' });
    const r = activeLinks(indexInteractions(events, { isAgentId }), 9e12, { replaying: true });
    expect(r.map((l) => l.seq)).toEqual([2]);
  });
});

describe('episodeFlow', () => {
  it('단계 순서: ask -> 승인, 답·정리는 ask 단계에 흡수', () => {
    const ix = indexInteractions(teamScenario(), { isAgentId });
    const flow = episodeFlow(ix)!;
    expect(flow.rootSeq).toBe(1);
    expect(flow.rootActorId).toBe('alice');
    expect(flow.steps.map((s) => [s.kind, s.channel, s.pending])).toEqual([
      ['a2a_ask', 'a2a', false],
      ['a2h_approval', 'a2h', true],
    ]);
    expect(flow.steps[1]!.toIds).toEqual(['alice', 'bob']);
    expect(episodeFlow(ix, 999)).toBeNull();
  });

  it('직접 지시로 시작하면 h2a 단계가 맨 앞, 상호작용이 없으면 null', () => {
    const { events, push } = makeLog();
    push({ type: 'message', text: '잡담' });
    expect(episodeFlow(indexInteractions(events, { isAgentId }))).toBeNull();
    push({ type: 'message', text: '해 줘', to: 'ag_alice' });
    const flow = episodeFlow(indexInteractions(events, { isAgentId }))!;
    expect(flow.steps.map((s) => s.kind)).toEqual(['h2a_direct']);
    expect(flow.rootSeq).toBe(2);
  });
});

describe('pickPreviewInteraction', () => {
  it('열린 질문이 있으면 pending, 모두 끝나면 20초 안의 마지막 상호작용, 그 뒤엔 null', () => {
    const open = indexInteractions(teamScenario({ danaAnswers: false, collected: false }), { isAgentId });
    expect(pickPreviewInteraction(open, 1_700_000_000_000 + 30000)).toMatchObject({ channel: 'a2a', pending: true, fromId: 'ra_team' });
    const done = indexInteractions(teamScenario({ resolved: true }), { isAgentId });
    const last = Math.max(...done.list.map((i) => i.ts));
    expect(pickPreviewInteraction(done, last + 1000)).toMatchObject({ pending: false });
    expect(pickPreviewInteraction(done, last + 60000)).toBeNull();
  });
  it('미해소 승인이 최근 a2a보다 우선하고 h2a는 무시한다', () => {
    const ix = indexInteractions(teamScenario({ resolved: false }), { isAgentId });
    expect(pickPreviewInteraction(ix, 1_700_000_000_000 + 30000)).toMatchObject({ channel: 'a2h', pending: true });
    expect(pickPreviewInteraction(indexInteractions([], { isAgentId }), 0)).toBeNull();
  });
});
