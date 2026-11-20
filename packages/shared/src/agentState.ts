import type { RoomEvent } from './events';

/**
 * 이벤트 → AgentVisualState (계획 8.5 표와 1:1). 3D, 상태 목록(AgentStatusList), SceneLab이 모두 이 리듀서를 쓴다.
 * 표의 "캐릭터/swarm" 열은 이 상태에서 렌더러가 유도한다. 상태만으로 구분이 안 되는 행은 `recalling`과 `cue`가 맡는다.
 *
 * | 이벤트                                  | 결과                                                         |
 * |-----------------------------------------|--------------------------------------------------------------|
 * | (기본)                                  | idle                                                         |
 * | 다른 행위자의 room 이벤트               | idle + target(그쪽을 봄)                                     |
 * | agent_turn_started                      | thinking                                                     |
 * | agent_step recalling                    | thinking + recalling                                         |
 * | agent_step drafting                     | drafting                                                     |
 * | agent_step talking{target}              | talking + target(agent)                                      |
 * | approval_requested (이 Agent가 요청)    | awaiting + target(승인자 좌석)                               |
 * | agent_turn_ended pass                   | idle + cue nod                                               |
 * | agent_paused                            | paused                                                       |
 * | member_left(소유자, mandate 있음)       | mode representing + target owner_seat                        |
 * | agent_departed                          | mode traveling, location null, target door, cue dissolve     |
 * | agent_arrived                           | mode visiting, location 호스트 Room, cue reassemble          |
 * | visit_takeout (이 Agent가 작성)         | cue hold_card                                                |
 * | agent_returned (+ visit_report)         | handoverPending, cue present_cards, 원래 mode 복귀           |
 * | member_rejoined(missed>0)               | handoverPending, mode accompanied, cue flow_to_owner         |
 * | digest_viewed                           | handoverPending 해제, cue jump                               |
 * | agreement_formed                        | cue agreement (구성원 Agent와 Room Agent)                    |
 */

export const AGENT_ACTIVITIES = ['idle', 'thinking', 'drafting', 'talking', 'awaiting', 'paused'] as const;
export type AgentActivity = (typeof AGENT_ACTIVITIES)[number];

export const AGENT_MODES = ['accompanied', 'representing', 'visiting', 'traveling'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export interface AgentTarget {
  kind: 'user' | 'agent' | 'card' | 'door' | 'owner_seat';
  id: string | null;
}

/** 일회성 연출. `seq`가 바뀔 때 한 번 재생한다. 다음 cue로 교체될 때까지 남아 있다. */
export const AGENT_CUE_KINDS = [
  'nod',
  'scatter',
  'jump',
  'agreement',
  'dissolve',
  'reassemble',
  'hold_card',
  'present_cards',
  'flow_to_owner',
] as const;
export type AgentCueKind = (typeof AGENT_CUE_KINDS)[number];

export interface AgentVisualState {
  activity: AgentActivity;
  mode: AgentMode;
  /** 지금 있는 roomId. 이동 중이면 null */
  location: string | null;
  target: AgentTarget | null;
  /** 방문 보고·Rejoin 다이제스트를 소유자에게 아직 못 넘김 */
  handoverPending: boolean;
  /** thinking 중 기억 선반에서 입자를 끌어오는 단계 */
  recalling: boolean;
  /** awaiting 중인 승인 id */
  approvalId: string | null;
  /** 소유자가 Leave해서 자리를 비움 */
  ownerAway: boolean;
  turnId: string | null;
  cue: { kind: AgentCueKind; seq: number } | null;
}

/** 리듀서가 이 Agent를 식별하는 정보 */
export interface AgentRef {
  agentId: string;
  /** Personal Agent의 소유자. Room Agent는 null */
  ownerUserId: string | null;
  /** 평소 있는 Room (My Room 또는 Our Room) */
  homeRoomId: string | null;
}

export function initialAgentState(ref: AgentRef): AgentVisualState {
  return {
    activity: 'idle',
    mode: 'accompanied',
    location: ref.homeRoomId,
    target: null,
    handoverPending: false,
    recalling: false,
    approvalId: null,
    ownerAway: false,
    turnId: null,
    cue: null,
  };
}

/** 사람 행위자 이벤트: 연쇄 상한으로 paused 된 Agent를 깨운다 */
const CONTENT_EVENTS = new Set(['message', 'card_created', 'card_updated', 'comment_added', 'card_pointed']);

export function reduceAgentState(ref: AgentRef, prev: AgentVisualState, e: RoomEvent): AgentVisualState {
  let s = prev;
  const set = (patch: Partial<AgentVisualState>) => {
    s = { ...s, ...patch };
  };
  const isOwner = (userId: string) => ref.ownerUserId !== null && ref.ownerUserId === userId;
  const cue = (kind: AgentCueKind) => ({ kind, seq: e.seq });

  // 다른 행위자의 room 이벤트: 사람이면 paused 해제, idle이면 그쪽을 본다
  if (CONTENT_EVENTS.has(e.type) && e.actorId !== ref.agentId) {
    if (e.actorKind === 'human' && s.activity === 'paused') set({ activity: 'idle' });
    if (s.activity === 'idle' && s.mode !== 'traveling' && (e.actorKind === 'human' || e.actorKind === 'agent' || e.actorKind === 'room_agent')) {
      set({ target: { kind: e.actorKind === 'human' ? 'user' : 'agent', id: e.actorId } });
    }
    return s;
  }

  switch (e.type) {
    case 'agent_turn_started':
      if (e.agentId === ref.agentId) set({ activity: 'thinking', recalling: false, turnId: e.turnId, target: null });
      break;

    case 'agent_step':
      if (e.agentId !== ref.agentId) break;
      switch (e.kind) {
        case 'reading':
          set({ activity: 'thinking', recalling: false });
          break;
        case 'recalling':
          set({ activity: 'thinking', recalling: true });
          break;
        case 'drafting':
          set({ activity: 'drafting', recalling: false });
          break;
        case 'talking':
          set({ activity: 'talking', recalling: false, target: e.target ? { kind: 'agent', id: e.target } : s.target });
          break;
      }
      break;

    case 'agent_turn_ended':
      if (e.agentId !== ref.agentId) break;
      // 승인 대기 중이면 턴이 끝나도 awaiting 유지
      set({
        activity: s.approvalId ? 'awaiting' : 'idle',
        recalling: false,
        turnId: null,
        target: s.approvalId ? s.target : null,
      });
      if (e.result === 'pass') set({ cue: cue('nod') });
      else if (e.result === 'error') set({ cue: cue('scatter') });
      break;

    case 'agent_paused':
      if (e.agentId === ref.agentId) set({ activity: 'paused', recalling: false });
      break;

    case 'approval_requested':
      if (e.actorId === ref.agentId && (e.actorKind === 'agent' || e.actorKind === 'room_agent')) {
        set({ activity: 'awaiting', approvalId: e.approvalId, target: { kind: 'user', id: e.approvers[0] ?? null } });
      }
      break;

    case 'approval_resolved':
      if (s.approvalId === e.approvalId) {
        set({ approvalId: null, activity: s.activity === 'awaiting' ? 'idle' : s.activity, target: null });
      }
      break;

    case 'member_entered':
      if (isOwner(e.userId)) {
        set({ ownerAway: false, mode: s.mode === 'representing' ? 'accompanied' : s.mode });
      }
      break;

    case 'member_left':
      if (isOwner(e.userId)) {
        set({ ownerAway: true });
        if (e.mandate && s.mode === 'accompanied') {
          set({ mode: 'representing', target: { kind: 'owner_seat', id: e.userId } });
        }
      }
      break;

    case 'member_rejoined':
      if (isOwner(e.userId)) {
        set({
          ownerAway: false,
          mode: s.mode === 'representing' ? 'accompanied' : s.mode,
          target: s.target?.kind === 'owner_seat' ? null : s.target,
        });
        if (e.missedCount > 0) set({ handoverPending: true, cue: cue('flow_to_owner') });
      }
      break;

    case 'digest_viewed':
      if (isOwner(e.userId) && s.handoverPending) set({ handoverPending: false, cue: cue('jump') });
      break;

    case 'agent_departed':
      if (e.agentId === ref.agentId) {
        set({ mode: 'traveling', location: null, target: { kind: 'door', id: null }, cue: cue('dissolve') });
      }
      break;

    case 'agent_arrived':
      if (e.agentId === ref.agentId) {
        set({ mode: 'visiting', location: e.roomId, target: { kind: 'door', id: null }, cue: cue('reassemble') });
      }
      break;

    case 'visit_ended':
      // 호스트 Room 로그에는 agent_returned가 없다: 방문 중이던 Agent는 여기서 떠난 것으로 본다 (복귀 튜브 연출)
      if (s.mode === 'visiting' && s.location === e.roomId) {
        set({ mode: 'traveling', location: null, target: { kind: 'door', id: null }, cue: cue('dissolve') });
      }
      break;

    case 'visit_takeout':
      if (e.actorId === ref.agentId && s.mode === 'visiting') set({ cue: cue('hold_card') });
      break;

    case 'agent_returned':
      if (e.agentId === ref.agentId) {
        set({
          mode: s.ownerAway ? 'representing' : 'accompanied',
          location: e.roomId,
          target: null,
          handoverPending: true,
          cue: cue('present_cards'),
        });
      }
      break;

    case 'agreement_formed':
      if ((ref.ownerUserId === null || e.memberIds.includes(ref.ownerUserId)) && s.mode !== 'traveling' && s.mode !== 'visiting') {
        set({ cue: cue('agreement') });
      }
      break;

    default:
      break;
  }
  return s;
}

/** 이 Agent의 상태를 로그에서 재구성한다. `upToSeq`까지만 (타임라인 재생) */
export function buildAgentState(ref: AgentRef, events: readonly RoomEvent[], upToSeq?: number): AgentVisualState {
  let state = initialAgentState(ref);
  for (const e of events) {
    if (upToSeq !== undefined && e.seq > upToSeq) break;
    state = reduceAgentState(ref, state, e);
  }
  return state;
}

export function buildAgentStates(
  refs: readonly AgentRef[],
  events: readonly RoomEvent[],
  upToSeq?: number,
): Record<string, AgentVisualState> {
  const out: Record<string, AgentVisualState> = {};
  for (const ref of refs) out[ref.agentId] = buildAgentState(ref, events, upToSeq);
  return out;
}
