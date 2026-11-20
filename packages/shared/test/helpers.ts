import type { ActorKind, EventPayload, RoomEvent, Visibility } from '../src';

export interface LogOpts {
  actorKind?: ActorKind;
  actorId?: string | null;
  visibility?: Visibility;
  turnId?: string | null;
}

/** 테스트용 이벤트 로그 빌더. seq는 1부터 자동 증가한다. */
export function makeLog(roomId = 'room1') {
  const events: RoomEvent[] = [];
  const push = (payload: EventPayload, o: LogOpts = {}): RoomEvent => {
    const e = {
      ...payload,
      roomId,
      seq: events.length + 1,
      ts: 1_700_000_000_000 + events.length * 1000,
      actorKind: o.actorKind ?? 'human',
      actorId: o.actorId === undefined ? 'alice' : o.actorId,
      visibility: o.visibility ?? 'room',
      turnId: o.turnId ?? null,
    } as RoomEvent;
    events.push(e);
    return e;
  };
  return { events, push };
}

/** 모든 이벤트 타입의 유효한 샘플 */
export const SAMPLE_PAYLOADS: EventPayload[] = [
  { type: 'room_created', title: '친구들' },
  { type: 'member_entered', userId: 'alice', role: 'owner' },
  {
    type: 'member_left',
    userId: 'alice',
    implicit: false,
    agentId: 'agent-alice',
    mandate: { text: '토요일 오후, 3만원, 확정은 내 승인', allowedActions: ['chat', 'comment', 'propose_edit'] },
  },
  { type: 'member_rejoined', userId: 'alice', missedCount: 3 },
  { type: 'digest_viewed', userId: 'alice' },
  { type: 'visit_requested', visitId: 'v1', visitorKind: 'human', visitorUserId: 'alice' },
  { type: 'visit_accepted', visitId: 'v1', permissions: ['chat', 'comment'] },
  { type: 'visit_declined', visitId: 'v1' },
  { type: 'agent_departed', agentId: 'agent-alice', visitId: 'v2', toRoomId: 'room-bob' },
  { type: 'agent_arrived', agentId: 'agent-alice', visitId: 'v2', fromRoomId: 'room-alice' },
  { type: 'visit_takeout', visitId: 'v2', text: '토요일 오후로 합의' },
  { type: 'visit_ended', visitId: 'v2', reason: 'agent_ended' },
  { type: 'agent_returned', agentId: 'agent-alice', visitId: 'v2' },
  { type: 'visit_report', visitId: 'v2', summary: '요약' },
  { type: 'message', text: '안녕', to: 'agent-alice', memoryRefs: ['m1'], clientId: 'c1' },
  { type: 'card_created', cardId: 'c1', title: '카드', body: '본문', ownerTag: 'user:alice' },
  { type: 'card_updated', cardId: 'c1', patch: { title: '새 제목' }, version: 2 },
  { type: 'comment_added', cardId: 'c1', text: '좋아요' },
  { type: 'card_pointed', cardId: 'c1', toAgentId: 'agent-alice' },
  {
    type: 'board_tool_created',
    toolId: 't_1',
    title: '커피 사다리',
    ownerTag: 'ours',
    init: { kind: 'ladder', participants: ['Alice', 'Bob'], outcomes: ['커피 사기', '꽝'] },
  },
  { type: 'board_tool_updated', toolId: 't_1', op: { op: 'ladder_run', seed: 42 } },
  { type: 'board_tool_removed', toolId: 't_1' },
  { type: 'agent_turn_started', agentId: 'agent-alice', turnId: 't1', trigger: { seq: 5, reason: 'mention' } },
  { type: 'agent_step', agentId: 'agent-alice', turnId: 't1', kind: 'talking', target: 'agent-bob' },
  { type: 'agent_turn_ended', agentId: 'agent-alice', turnId: 't1', result: 'pass', passReason: 'nothing_to_add' },
  { type: 'agent_paused', agentId: 'agent-alice', reason: 'chain_limit' },
  {
    type: 'approval_requested',
    approvalId: 'a1',
    approvers: ['alice', 'bob'],
    kind: 'decision',
    summary: '토요일 3시',
    publicRationale: '두 선호가 갈림',
  },
  { type: 'agent_owner_note', agentId: 'agent-alice', note: '메모' },
  { type: 'approval_voted', approvalId: 'a1', userId: 'alice', decision: 'approve' },
  { type: 'approval_resolved', approvalId: 'a1', outcome: 'approved' },
  { type: 'agreement_formed', cardId: 'c1', memberIds: ['alice', 'bob'] },
  { type: 'memory_retained', itemId: 'm1', ns: 'room:room1', kind: 'agreement' },
];
