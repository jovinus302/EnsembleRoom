import type { Capability } from './permissions';
import { applyBoardToolOp, createBoardTool, type BoardTool } from './boardTools';
import type {
  ActorKind,
  ApprovalKind,
  ApprovalOutcome,
  EditProposal,
  Mandate,
  MemberRole,
  OwnerTag,
  RoomEvent,
  VisitStatus,
  VisitorKind,
  VoteDecision,
} from './events';

/**
 * 한 Room의 이벤트 로그를 리듀싱한 결과(계획 4~8절). 서버 스냅샷, 웹 스토어, 타임라인 재생이 모두 이 함수를 쓴다.
 * 상태는 JSON 직렬화 가능한 평범한 객체이고, 리듀서는 입력을 변경하지 않는다.
 */

export interface BoardCard {
  cardId: string;
  title: string;
  body: string;
  ownerTag: OwnerTag;
  version: number;
  /** agreement_formed 이후 true (금빛 핀) */
  agreed: boolean;
  deleted: boolean;
  comments: { seq: number; actorKind: ActorKind; actorId: string | null; text: string }[];
}

export interface MemberState {
  userId: string;
  role: MemberRole;
  /** 지금 Room 안에 있는가 */
  present: boolean;
  /** 마지막 Leave 시점의 seq. 돌아오면 null */
  leftAtSeq: number | null;
  /** Leave 때 준 위임. 대리 참여 중일 때만 값이 있다 */
  mandate: Mandate | null;
  /** 이 구성원의 Agent (member_left에 실려 온 값) */
  agentId: string | null;
  /** Rejoin 뒤 다이제스트를 아직 보지 않음 */
  digestPending: boolean;
}

/** Agent 방문의 진행 단계 (출발 Room/호스트 Room 어느 쪽 로그에서든 같은 의미) */
export type VisitAgentPhase = 'none' | 'departed' | 'arrived' | 'returned';

export interface VisitState {
  visitId: string;
  visitorKind: VisitorKind;
  visitorUserId: string;
  visitorAgentId: string | null;
  /** Agent 방문의 위임 범위(visit_requested에 실려 온 값). 사람 방문은 null */
  mandate: Mandate | null;
  status: VisitStatus;
  permissions: Capability[];
  /** visit_accepted 이벤트의 seq (방문자 가시성의 시작점) */
  startSeq: number | null;
  endSeq: number | null;
  agentPhase: VisitAgentPhase;
  takeout: string | null;
  report: string | null;
  /** visit_report 이벤트의 seq (선택, 보고가 온 뒤에만) */
  reportSeq?: number;
}

export type ApprovalStatus = 'pending' | ApprovalOutcome;

export interface ApprovalState {
  approvalId: string;
  approvers: string[];
  kind: ApprovalKind;
  summary: string;
  publicRationale: string | null;
  status: ApprovalStatus;
  votes: Record<string, VoteDecision>;
  /** request_approval의 선택지 (S8 추가) */
  options?: string[];
  /** propose_edit의 수정안 (S8 추가) */
  proposal?: EditProposal;
  requestedSeq: number;
  /** 요청한 행위자 (보통 Agent id) */
  requestedBy: string | null;
  requestedByKind: ActorKind;
  /** approval_voted의 선택지 투표: userId → option (선택, 값이 있을 때만) */
  voteOptions?: Record<string, string>;
  /** approval_voted의 수정안 투표(decision 'edit'): userId → 수정본 */
  voteEdits?: Record<string, EditProposal>;
  /** approval_resolved의 확정 선택지 (decision형) */
  resolvedOption?: string;
  /** approval_resolved의 실제 반영 수정안 (edit형) */
  appliedProposal?: EditProposal;
}

/** Agent가 소유자에게만 남긴 메모 (받은 이벤트만 반영: 가시성은 canSeeEvent가 이미 걸러냈다) */
export interface OwnerNote {
  seq: number;
  agentId: string;
  note: string;
}

export interface RoomState {
  roomId: string;
  lastSeq: number;
  members: Record<string, MemberState>;
  board: Record<string, BoardCard>;
  /** 카드 생성 순서 */
  cardOrder: string[];
  /** 보드 도구 (사다리·정산표·여행 계획) */
  boardTools: Record<string, BoardTool>;
  /** 도구 생성 순서 */
  toolOrder: string[];
  visits: Record<string, VisitState>;
  approvals: Record<string, ApprovalState>;
  /** 지금 Room 안에 있는 사람 (방문자 포함) */
  presentUserIds: string[];
  /** 지금 Room 안에 있는 Agent: 대리 참여 중인 구성원 Agent와 방문 중인 Agent. 동행 Agent는 세지 않는다 */
  presentAgentIds: string[];
  messageCount: number;
  /** agent_owner_note 목록 (선택, 노트가 있을 때만) */
  ownerNotes?: OwnerNote[];
}

export function initialRoomState(roomId: string): RoomState {
  return {
    roomId,
    lastSeq: 0,
    members: {},
    board: {},
    cardOrder: [],
    boardTools: {},
    toolOrder: [],
    visits: {},
    approvals: {},
    presentUserIds: [],
    presentAgentIds: [],
    messageCount: 0,
  };
}

const add = (xs: readonly string[], x: string) => (xs.includes(x) ? [...xs] : [...xs, x]);
const remove = (xs: readonly string[], x: string) => xs.filter((y) => y !== x);

function patchVisit(state: RoomState, visitId: string, patch: Partial<VisitState>): RoomState {
  const v = state.visits[visitId];
  if (!v) return state;
  return { ...state, visits: { ...state.visits, [visitId]: { ...v, ...patch } } };
}

function patchMember(state: RoomState, userId: string, patch: Partial<MemberState>): RoomState {
  const m = state.members[userId];
  if (!m) return state;
  return { ...state, members: { ...state.members, [userId]: { ...m, ...patch } } };
}

function patchCard(state: RoomState, cardId: string, f: (c: BoardCard) => BoardCard): RoomState {
  const c = state.board[cardId];
  if (!c) return state;
  return { ...state, board: { ...state.board, [cardId]: f(c) } };
}

export function reduceRoomState(prev: RoomState, e: RoomEvent): RoomState {
  const s: RoomState = { ...prev, lastSeq: Math.max(prev.lastSeq, e.seq) };

  switch (e.type) {
    case 'member_entered': {
      const old = s.members[e.userId];
      const member: MemberState = {
        userId: e.userId,
        role: e.role,
        present: true,
        leftAtSeq: null,
        mandate: null,
        agentId: old?.agentId ?? null,
        digestPending: old?.digestPending ?? false,
      };
      return {
        ...s,
        members: { ...s.members, [e.userId]: member },
        presentUserIds: add(s.presentUserIds, e.userId),
        presentAgentIds: old?.agentId ? remove(s.presentAgentIds, old.agentId) : s.presentAgentIds,
      };
    }

    case 'member_left': {
      const old = s.members[e.userId];
      const representing = e.mandate !== undefined && e.agentId !== undefined;
      const member: MemberState = {
        userId: e.userId,
        role: old?.role ?? 'member',
        present: false,
        leftAtSeq: e.seq,
        mandate: e.mandate ?? null,
        agentId: e.agentId ?? old?.agentId ?? null,
        digestPending: old?.digestPending ?? false,
      };
      return {
        ...s,
        members: { ...s.members, [e.userId]: member },
        presentUserIds: remove(s.presentUserIds, e.userId),
        presentAgentIds: representing ? add(s.presentAgentIds, e.agentId!) : s.presentAgentIds,
      };
    }

    case 'member_rejoined': {
      const old = s.members[e.userId];
      const member: MemberState = {
        userId: e.userId,
        role: old?.role ?? 'member',
        present: true,
        leftAtSeq: null,
        mandate: null,
        agentId: old?.agentId ?? null,
        digestPending: e.missedCount > 0,
      };
      return {
        ...s,
        members: { ...s.members, [e.userId]: member },
        presentUserIds: add(s.presentUserIds, e.userId),
        presentAgentIds: old?.agentId ? remove(s.presentAgentIds, old.agentId) : s.presentAgentIds,
      };
    }

    case 'digest_viewed':
      return patchMember(s, e.userId, { digestPending: false });

    case 'visit_requested': {
      const visit: VisitState = {
        visitId: e.visitId,
        visitorKind: e.visitorKind,
        visitorUserId: e.visitorUserId,
        visitorAgentId: e.visitorAgentId ?? null,
        mandate: e.mandate ?? null,
        status: 'requested',
        permissions: [],
        startSeq: null,
        endSeq: null,
        agentPhase: 'none',
        takeout: null,
        report: null,
      };
      return { ...s, visits: { ...s.visits, [e.visitId]: visit } };
    }

    case 'visit_accepted': {
      const next = patchVisit(s, e.visitId, { status: 'active', permissions: [...e.permissions], startSeq: e.seq });
      const v = next.visits[e.visitId];
      // 사람 방문은 수락 즉시 입장한 것으로 본다(member_entered{visitor}가 따로 오면 같은 결과)
      if (v && v.visitorKind === 'human') {
        return { ...next, presentUserIds: add(next.presentUserIds, v.visitorUserId) };
      }
      return next;
    }

    case 'visit_declined':
      return patchVisit(s, e.visitId, { status: 'declined', endSeq: e.seq });

    case 'agent_departed': {
      const next = patchVisit(s, e.visitId, { agentPhase: 'departed' });
      return { ...next, presentAgentIds: remove(next.presentAgentIds, e.agentId) };
    }

    case 'agent_arrived': {
      const next = patchVisit(s, e.visitId, { agentPhase: 'arrived' });
      return { ...next, presentAgentIds: add(next.presentAgentIds, e.agentId) };
    }

    case 'visit_takeout':
      return patchVisit(s, e.visitId, { takeout: e.text });

    case 'visit_ended': {
      const v = s.visits[e.visitId];
      const next = patchVisit(s, e.visitId, { status: 'ended', endSeq: e.seq });
      if (v && v.visitorKind === 'human') {
        return { ...next, presentUserIds: remove(next.presentUserIds, v.visitorUserId) };
      }
      // 방문 Agent는 방문이 끝나면 호스트 Room을 떠난다. agent_returned는 방문자의 홈 Room에 기록돼
      // 호스트에게는 보이지 않으므로 호스트 쪽 상태는 visit_ended로 정리한다.
      if (v && v.visitorAgentId) {
        return { ...next, presentAgentIds: remove(next.presentAgentIds, v.visitorAgentId) };
      }
      return next;
    }

    case 'agent_returned': {
      const next = patchVisit(s, e.visitId, { agentPhase: 'returned' });
      return { ...next, presentAgentIds: remove(next.presentAgentIds, e.agentId) };
    }

    case 'visit_report':
      return patchVisit(s, e.visitId, { report: e.summary, reportSeq: e.seq });

    case 'agent_owner_note':
      return { ...s, ownerNotes: [...(s.ownerNotes ?? []), { seq: e.seq, agentId: e.agentId, note: e.note }] };

    case 'message':
      return { ...s, messageCount: s.messageCount + 1 };

    case 'card_created': {
      if (s.board[e.cardId]) return s;
      const card: BoardCard = {
        cardId: e.cardId,
        title: e.title,
        body: e.body,
        ownerTag: e.ownerTag,
        version: 1,
        agreed: false,
        deleted: false,
        comments: [],
      };
      return { ...s, board: { ...s.board, [e.cardId]: card }, cardOrder: [...s.cardOrder, e.cardId] };
    }

    case 'card_updated':
      return patchCard(s, e.cardId, (c) =>
        e.version <= c.version
          ? c
          : {
              ...c,
              title: e.patch.title ?? c.title,
              body: e.patch.body ?? c.body,
              deleted: e.patch.deleted ?? c.deleted,
              version: e.version,
            },
      );

    case 'comment_added':
      return patchCard(s, e.cardId, (c) => ({
        ...c,
        comments: [...c.comments, { seq: e.seq, actorKind: e.actorKind, actorId: e.actorId, text: e.text }],
      }));

    case 'agreement_formed':
      return patchCard(s, e.cardId, (c) => ({ ...c, agreed: true }));

    case 'board_tool_created': {
      if (s.boardTools[e.toolId]) return s;
      const tool = createBoardTool({
        toolId: e.toolId,
        title: e.title,
        ownerTag: e.ownerTag,
        init: e.init,
        seq: e.seq,
        actorKind: e.actorKind,
        actorId: e.actorId,
      });
      return { ...s, boardTools: { ...s.boardTools, [e.toolId]: tool }, toolOrder: [...s.toolOrder, e.toolId] };
    }

    case 'board_tool_updated': {
      const tool = s.boardTools[e.toolId];
      if (!tool || tool.removed) return s;
      const next = applyBoardToolOp(tool, e.op, { seq: e.seq, actor: { kind: e.actorKind, id: e.actorId } });
      if (next === tool) return s;
      return { ...s, boardTools: { ...s.boardTools, [e.toolId]: next } };
    }

    case 'board_tool_removed': {
      const tool = s.boardTools[e.toolId];
      if (!tool || tool.removed) return s;
      return { ...s, boardTools: { ...s.boardTools, [e.toolId]: { ...tool, removed: true, updatedSeq: e.seq } } };
    }

    case 'approval_requested': {
      const approval: ApprovalState = {
        approvalId: e.approvalId,
        approvers: [...e.approvers],
        kind: e.kind,
        summary: e.summary,
        publicRationale: e.publicRationale ?? null,
        ...(e.options ? { options: [...e.options] } : {}),
        ...(e.proposal ? { proposal: { ...e.proposal } } : {}),
        status: 'pending',
        votes: {},
        requestedSeq: e.seq,
        requestedBy: e.actorId,
        requestedByKind: e.actorKind,
      };
      return { ...s, approvals: { ...s.approvals, [e.approvalId]: approval } };
    }

    case 'approval_voted': {
      const a = s.approvals[e.approvalId];
      if (!a) return s;
      return {
        ...s,
        approvals: {
          ...s.approvals,
          [e.approvalId]: {
            ...a,
            votes: { ...a.votes, [e.userId]: e.decision },
            ...(e.option !== undefined ? { voteOptions: { ...a.voteOptions, [e.userId]: e.option } } : {}),
            ...(e.edited ? { voteEdits: { ...a.voteEdits, [e.userId]: { ...e.edited } } } : {}),
          },
        },
      };
    }

    case 'approval_resolved': {
      const a = s.approvals[e.approvalId];
      if (!a) return s;
      return {
        ...s,
        approvals: {
          ...s.approvals,
          [e.approvalId]: {
            ...a,
            status: e.outcome,
            ...(e.option !== undefined ? { resolvedOption: e.option } : {}),
            ...(e.applied ? { appliedProposal: { ...e.applied } } : {}),
          },
        },
      };
    }

    // 상태에 영향이 없는 이벤트: Agent 턴 계열(agentState가 다룸), card_pointed, memory_retained, room_created
    default:
      return s;
  }
}

/** 이벤트 로그를 처음부터 리듀싱한다. `upToSeq`를 주면 그 seq까지만 (타임라인 재생 replaySeq) */
export function buildRoomState(roomId: string, events: readonly RoomEvent[], upToSeq?: number): RoomState {
  let state = initialRoomState(roomId);
  for (const e of events) {
    if (upToSeq !== undefined && e.seq > upToSeq) break;
    state = reduceRoomState(state, e);
  }
  return state;
}

export function pendingApprovals(state: RoomState): ApprovalState[] {
  return Object.values(state.approvals).filter((a) => a.status === 'pending');
}

/** 이 사용자가 투표해야 하는(아직 안 한) 대기 승인 */
export function pendingApprovalsFor(state: RoomState, userId: string): ApprovalState[] {
  return pendingApprovals(state).filter((a) => a.approvers.includes(userId) && a.votes[userId] === undefined);
}

export function visibleCards(state: RoomState): BoardCard[] {
  return state.cardOrder.map((id) => state.board[id]!).filter((c) => !c.deleted);
}

export function visibleBoardTools(state: RoomState): BoardTool[] {
  return state.toolOrder.map((id) => state.boardTools[id]!).filter((t) => !t.removed);
}

/* ------------------------------------------------------------------ */
/* 조명 단계 (계획 8.3 표)                                               */
/* ------------------------------------------------------------------ */

/** 사람이 있음 / 사람 없이 Agent만(대리 참여·방문) / 아무도 없음 / 승인 대기(오렌지 보조광 추가) */
export const AMBIENCE_STAGES = ['occupied', 'agentOnly', 'empty', 'attention'] as const;
export type AmbienceStage = (typeof AMBIENCE_STAGES)[number];
export type AmbienceBase = Exclude<AmbienceStage, 'attention'>;

export interface RoomAmbience {
  /** 기본 조명 단계 */
  base: AmbienceBase;
  /** 승인 대기 → 오렌지 보조광을 base 위에 더한다 */
  attention: boolean;
  /** 렌더러·미리보기가 쓰는 단일 단계. attention이면 'attention', 아니면 base */
  stage: AmbienceStage;
}

export function roomAmbience(state: RoomState): RoomAmbience {
  const base: AmbienceBase =
    state.presentUserIds.length > 0 ? 'occupied' : state.presentAgentIds.length > 0 ? 'agentOnly' : 'empty';
  const attention = pendingApprovals(state).length > 0;
  return { base, attention, stage: attention ? 'attention' : base };
}

/** 단계별 조도 비율(실내 전구·스탠드). 렌더러가 쓰는 표 */
export const AMBIENCE_INTENSITY: Readonly<Record<AmbienceBase, number>> = {
  occupied: 1,
  agentOnly: 0.4,
  empty: 0,
};
