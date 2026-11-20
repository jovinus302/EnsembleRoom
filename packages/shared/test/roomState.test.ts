import { describe, expect, it } from 'vitest';
import {
  AMBIENCE_INTENSITY,
  AMBIENCE_STAGES,
  buildRoomState,
  initialRoomState,
  pendingApprovalsFor,
  reduceRoomState,
  roomAmbience,
  visibleCards,
  type EventPayload,
  type Mandate,
} from '../src';
import { makeLog, type LogOpts } from './helpers';

const mandate: Mandate = { text: '토요일 오후, 3만원, 확정은 내 승인', allowedActions: ['chat', 'comment', 'propose_edit'] };

function build(steps: [EventPayload, LogOpts?][], roomId = 'room-alice') {
  const log = makeLog(roomId);
  for (const [p, o] of steps) log.push(p, o);
  return { events: log.events, state: buildRoomState(roomId, log.events) };
}

const enter = (userId: string, role: 'owner' | 'member' | 'visitor' = 'member'): [EventPayload] => [
  { type: 'member_entered', userId, role },
];
const leaveWithAgent = (userId: string, agentId: string): [EventPayload] => [
  { type: 'member_left', userId, implicit: false, mandate, agentId },
];
const requestApproval = (id = 'a1'): [EventPayload, LogOpts] => [
  { type: 'approval_requested', approvalId: id, approvers: ['alice', 'bob'], kind: 'decision', summary: '토요일 3시' },
  { actorKind: 'room_agent', actorId: 'ra' },
];

describe('roomAmbience: 조명 4단계', () => {
  it('아무도 없으면 empty', () => {
    const { state } = build([[{ type: 'room_created' }]]);
    expect(roomAmbience(state)).toEqual({ base: 'empty', attention: false, stage: 'empty' });
  });

  it('사람이 있으면 occupied', () => {
    const { state } = build([enter('alice', 'owner')]);
    expect(roomAmbience(state)).toMatchObject({ base: 'occupied', stage: 'occupied' });
  });

  it('소유자가 mandate와 함께 떠나면 Agent만 남아 agentOnly', () => {
    const { state } = build([enter('alice', 'owner'), leaveWithAgent('alice', 'agent-alice')]);
    expect(state.presentUserIds).toEqual([]);
    expect(state.presentAgentIds).toEqual(['agent-alice']);
    expect(roomAmbience(state)).toMatchObject({ base: 'agentOnly', stage: 'agentOnly' });
  });

  it('mandate 없이 떠나면(암묵적 퇴장 등) empty', () => {
    const { state } = build([enter('alice', 'owner'), [{ type: 'member_left', userId: 'alice', implicit: true }]]);
    expect(roomAmbience(state).stage).toBe('empty');
  });

  it('Our Room에서 Alice가 떠나도 Bob이 있으면 occupied이고 Alice의 Agent는 대리 참여를 이어간다', () => {
    const { state } = build([enter('alice'), enter('bob'), leaveWithAgent('alice', 'agent-alice')], 'room-friends');
    expect(state.presentUserIds).toEqual(['bob']);
    expect(state.presentAgentIds).toEqual(['agent-alice']);
    expect(roomAmbience(state).base).toBe('occupied');
  });

  it('승인 대기면 attention (base는 유지되고 오렌지 보조광이 얹힌다), 해소되면 원래대로', () => {
    const waiting = build([enter('alice'), enter('bob'), requestApproval()]).state;
    expect(roomAmbience(waiting)).toEqual({ base: 'occupied', attention: true, stage: 'attention' });

    const emptyWaiting = build([requestApproval()]).state;
    expect(roomAmbience(emptyWaiting)).toEqual({ base: 'empty', attention: true, stage: 'attention' });

    const resolved = build([
      enter('alice'),
      requestApproval(),
      [{ type: 'approval_resolved', approvalId: 'a1', outcome: 'approved' }, { actorKind: 'system', actorId: null }],
    ]).state;
    expect(roomAmbience(resolved)).toEqual({ base: 'occupied', attention: false, stage: 'occupied' });
  });

  it('방문 Agent가 도착하면 호스트 Room은 agentOnly, 돌아가면 empty (호스트가 없을 때)', () => {
    const arrived = build([[{ type: 'agent_arrived', agentId: 'agent-alice', visitId: 'v2', fromRoomId: 'room-alice' }, { actorKind: 'agent', actorId: 'agent-alice' }]], 'room-bob');
    expect(roomAmbience(arrived.state).base).toBe('agentOnly');
    const returned = build(
      [
        [{ type: 'agent_arrived', agentId: 'agent-alice', visitId: 'v2', fromRoomId: 'room-alice' }, { actorKind: 'agent', actorId: 'agent-alice' }],
        [{ type: 'agent_returned', agentId: 'agent-alice', visitId: 'v2' }, { actorKind: 'agent', actorId: 'agent-alice' }],
      ],
      'room-bob',
    );
    expect(roomAmbience(returned.state).base).toBe('empty');
  });

  it('Agent가 방문하러 출발하면 출발 Room은 empty (Alice 캡슐이 empty로 바뀐다, 계획 11절)', () => {
    const { state } = build([
      enter('alice', 'owner'),
      leaveWithAgent('alice', 'agent-alice'),
      [{ type: 'agent_departed', agentId: 'agent-alice', visitId: 'v2', toRoomId: 'room-bob' }, { actorKind: 'agent', actorId: 'agent-alice' }],
    ]);
    expect(roomAmbience(state).stage).toBe('empty');
  });

  it('Rejoin하면 occupied로 점등되고 대리 Agent는 빠진다', () => {
    const { state } = build([
      enter('alice', 'owner'),
      leaveWithAgent('alice', 'agent-alice'),
      [{ type: 'member_rejoined', userId: 'alice', missedCount: 2 }],
    ]);
    expect(state.presentAgentIds).toEqual([]);
    expect(roomAmbience(state).stage).toBe('occupied');
    expect(state.members.alice).toMatchObject({ present: true, digestPending: true, mandate: null, leftAtSeq: null });
  });

  it('사람 방문자가 있으면 occupied, 방문이 끝나면 빠진다', () => {
    const { state, events } = build(
      [
        [{ type: 'visit_requested', visitId: 'v1', visitorKind: 'human', visitorUserId: 'bob' }, { actorId: 'bob' }],
        [{ type: 'visit_accepted', visitId: 'v1', permissions: ['chat', 'comment'] }, { actorId: 'alice' }],
      ],
      'room-alice',
    );
    expect(roomAmbience(state).stage).toBe('occupied');
    const ended = reduceRoomState(state, {
      ...events[0]!,
      type: 'visit_ended',
      visitId: 'v1',
      reason: 'host_ended',
      seq: 3,
    } as never);
    expect(ended.visits.v1).toMatchObject({ status: 'ended', endSeq: 3 });
    expect(roomAmbience(ended).stage).toBe('empty');
  });

  it('방문 Agent는 visit_ended로 호스트 Room을 떠난다 (agent_returned는 호스트에게 보이지 않는다)', () => {
    const { state, events } = build(
      [
        [{ type: 'visit_requested', visitId: 'v2', visitorKind: 'agent', visitorUserId: 'alice', visitorAgentId: 'agent-alice' }, { actorId: 'alice' }],
        [{ type: 'visit_accepted', visitId: 'v2', permissions: ['chat'] }, { actorId: 'bob' }],
        [{ type: 'agent_arrived', visitId: 'v2', agentId: 'agent-alice', fromRoomId: 'room-alice' }, { actorKind: 'system', actorId: null }],
      ],
      'room-bob',
    );
    expect(state.presentAgentIds).toContain('agent-alice');
    const ended = reduceRoomState(state, { ...events[0]!, type: 'visit_ended', visitId: 'v2', reason: 'host_ended', seq: 9 } as never);
    expect(ended.presentAgentIds).not.toContain('agent-alice');
  });

  it('단계 목록과 조도 표', () => {
    expect([...AMBIENCE_STAGES]).toEqual(['occupied', 'agentOnly', 'empty', 'attention']);
    expect(AMBIENCE_INTENSITY).toEqual({ occupied: 1, agentOnly: 0.4, empty: 0 });
  });
});

describe('roomState 리듀서', () => {
  it('보드: 생성, 수정(버전), 댓글, 합의, 삭제', () => {
    const { state } = build([
      [{ type: 'card_created', cardId: 'c1', title: '주말', body: '', ownerTag: 'user:alice' }],
      [{ type: 'card_created', cardId: 'c2', title: '식당', body: '', ownerTag: 'ours' }],
      [{ type: 'card_updated', cardId: 'c1', patch: { title: '주말 아이디어' }, version: 2 }],
      [{ type: 'card_updated', cardId: 'c1', patch: { title: '오래된 수정' }, version: 2 }],
      [{ type: 'comment_added', cardId: 'c1', text: '좋아요' }, { actorId: 'bob' }],
      [{ type: 'agreement_formed', cardId: 'c2', memberIds: ['alice', 'bob'] }, { actorKind: 'system', actorId: null }],
      [{ type: 'card_updated', cardId: 'c1', patch: { deleted: true }, version: 3 }],
    ]);
    expect(state.cardOrder).toEqual(['c1', 'c2']);
    expect(state.board.c1).toMatchObject({ title: '주말 아이디어', version: 3, deleted: true });
    expect(state.board.c1!.comments).toEqual([{ seq: 5, actorKind: 'human', actorId: 'bob', text: '좋아요' }]);
    expect(state.board.c2).toMatchObject({ agreed: true, ownerTag: 'ours' });
    expect(visibleCards(state).map((c) => c.cardId)).toEqual(['c2']);
  });

  it('없는 카드에 대한 이벤트는 무시한다 (가시성 필터로 일부가 빠진 로그)', () => {
    const { state } = build([[{ type: 'card_updated', cardId: 'zz', patch: {}, version: 2 }]]);
    expect(state.board).toEqual({});
  });

  it('방문: 요청 → 수락(start_seq) → takeout → 종료, Agent 단계', () => {
    const { state } = build([
      [{ type: 'visit_requested', visitId: 'v2', visitorKind: 'agent', visitorUserId: 'alice', visitorAgentId: 'agent-alice' }],
      [{ type: 'visit_accepted', visitId: 'v2', permissions: ['chat', 'comment'] }, { actorId: 'bob' }],
      [{ type: 'agent_arrived', agentId: 'agent-alice', visitId: 'v2', fromRoomId: 'room-alice' }, { actorKind: 'agent', actorId: 'agent-alice' }],
      [{ type: 'visit_takeout', visitId: 'v2', text: '토요일' }, { actorKind: 'agent', actorId: 'agent-alice' }],
    ]);
    expect(state.visits.v2).toMatchObject({
      status: 'active',
      startSeq: 2,
      agentPhase: 'arrived',
      takeout: '토요일',
      permissions: ['chat', 'comment'],
      visitorAgentId: 'agent-alice',
    });
    // Agent 방문은 사람 presence를 만들지 않는다
    expect(state.presentUserIds).toEqual([]);
  });

  it('방문 거절', () => {
    const { state } = build([
      [{ type: 'visit_requested', visitId: 'v1', visitorKind: 'human', visitorUserId: 'bob' }],
      [{ type: 'visit_declined', visitId: 'v1' }],
    ]);
    expect(state.visits.v1).toMatchObject({ status: 'declined', endSeq: 2 });
    expect(state.presentUserIds).toEqual([]);
  });

  it('승인: 요청 → 투표 → 해소, 내가 투표할 대기 승인', () => {
    const { state } = build([
      enter('alice'),
      requestApproval('a1'),
      [{ type: 'approval_voted', approvalId: 'a1', userId: 'alice', decision: 'approve' }],
    ]);
    expect(state.approvals.a1).toMatchObject({
      status: 'pending',
      approvers: ['alice', 'bob'],
      votes: { alice: 'approve' },
      requestedBy: 'ra',
      requestedByKind: 'room_agent',
    });
    expect(pendingApprovalsFor(state, 'alice')).toEqual([]); // 이미 투표함
    expect(pendingApprovalsFor(state, 'bob').map((a) => a.approvalId)).toEqual(['a1']);
    expect(pendingApprovalsFor(state, 'carol')).toEqual([]); // 승인자가 아님

    const resolved = reduceRoomState(state, {
      ...makeLog().push({ type: 'approval_resolved', approvalId: 'a1', outcome: 'edited' }),
      seq: 99,
    });
    expect(resolved.approvals.a1!.status).toBe('edited');
    expect(pendingApprovalsFor(resolved, 'bob')).toEqual([]);
  });

  it('승인: 선택지/수정안 투표와 확정 값이 ApprovalState에 반영된다', () => {
    const { state } = build([
      requestApproval('a1'),
      [{ type: 'approval_voted', approvalId: 'a1', userId: 'alice', decision: 'approve', option: '토요일' }],
      [{ type: 'approval_voted', approvalId: 'a1', userId: 'bob', decision: 'edit', edited: { cardId: 'c1', title: '수정' } }],
      [{ type: 'approval_resolved', approvalId: 'a1', outcome: 'edited', option: '토요일', applied: { cardId: 'c1', title: '수정' } }],
    ]);
    expect(state.approvals.a1).toMatchObject({
      status: 'edited',
      votes: { alice: 'approve', bob: 'edit' },
      voteOptions: { alice: '토요일' },
      voteEdits: { bob: { cardId: 'c1', title: '수정' } },
      resolvedOption: '토요일',
      appliedProposal: { cardId: 'c1', title: '수정' },
    });
    // 선택 필드가 없으면 키 자체가 생기지 않는다
    const plain = build([requestApproval('a2'), [{ type: 'approval_voted', approvalId: 'a2', userId: 'alice', decision: 'approve' }]]);
    expect(plain.state.approvals.a2).not.toHaveProperty('voteOptions');
    expect(plain.state.approvals.a2).not.toHaveProperty('resolvedOption');
  });

  it('agent_owner_note와 visit_report를 추적한다', () => {
    const { state } = build([
      [{ type: 'agent_owner_note', agentId: 'ag1', note: '비밀 메모' }],
      [{ type: 'visit_requested', visitId: 'v1', visitorKind: 'agent', visitorUserId: 'bob', visitorAgentId: 'ag2' }],
      [{ type: 'visit_report', visitId: 'v1', summary: '다녀왔어요' }],
    ]);
    expect(state.ownerNotes).toEqual([{ seq: 1, agentId: 'ag1', note: '비밀 메모' }]);
    expect(state.visits.v1).toMatchObject({ report: '다녀왔어요', reportSeq: 3 });
    expect(initialRoomState('r').ownerNotes).toBeUndefined();
  });

  it('digest_viewed는 다이제스트 대기를 해제한다', () => {
    const { state } = build([
      enter('alice', 'owner'),
      leaveWithAgent('alice', 'agent-alice'),
      [{ type: 'member_rejoined', userId: 'alice', missedCount: 3 }],
      [{ type: 'digest_viewed', userId: 'alice' }],
    ]);
    expect(state.members.alice!.digestPending).toBe(false);
  });

  it('메시지 수와 lastSeq', () => {
    const { state } = build([[{ type: 'message', text: 'a' }], [{ type: 'message', text: 'b' }]]);
    expect(state).toMatchObject({ messageCount: 2, lastSeq: 2 });
  });

  it('replaySeq: 과거로 되감으면 조명과 보드가 함께 되돌아간다 (타임라인 재생)', () => {
    const { events } = build([
      enter('alice', 'owner'), // 1
      [{ type: 'card_created', cardId: 'c1', title: 't', body: '', ownerTag: 'ours' }], // 2
      leaveWithAgent('alice', 'agent-alice'), // 3
      [{ type: 'agent_departed', agentId: 'agent-alice', visitId: 'v2', toRoomId: 'room-bob' }, { actorKind: 'agent', actorId: 'agent-alice' }], // 4
      requestApproval('a1'), // 5
      [{ type: 'member_rejoined', userId: 'alice', missedCount: 3 }], // 6
    ]);
    const at = (seq: number) => roomAmbience(buildRoomState('room-alice', events, seq)).stage;
    expect(at(0)).toBe('empty');
    expect(at(1)).toBe('occupied');
    expect(at(3)).toBe('agentOnly');
    expect(at(4)).toBe('empty');
    expect(at(5)).toBe('attention');
    expect(at(6)).toBe('attention'); // base occupied + 승인 대기
    expect(roomAmbience(buildRoomState('room-alice', events, 6)).base).toBe('occupied');
    expect(Object.keys(buildRoomState('room-alice', events, 1).board)).toEqual([]);
    expect(Object.keys(buildRoomState('room-alice', events, 2).board)).toEqual(['c1']);
  });

  it('리듀서는 입력 상태를 변경하지 않는다', () => {
    const before = initialRoomState('r');
    const snapshot = JSON.stringify(before);
    const e = makeLog('r').push({ type: 'member_entered', userId: 'alice', role: 'owner' });
    const after = reduceRoomState(before, e);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(after.presentUserIds).toEqual(['alice']);
  });
});
