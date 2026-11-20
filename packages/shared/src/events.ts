import { z } from 'zod';
import { CapabilitySchema } from './permissions';

/* ------------------------------------------------------------------ */
/* 기본 열거형                                                          */
/* ------------------------------------------------------------------ */

export const RoomKindSchema = z.enum(['my', 'our', 'dm']);
export type RoomKind = z.infer<typeof RoomKindSchema>;

export const ActorKindSchema = z.enum(['human', 'agent', 'room_agent', 'system']);
export type ActorKind = z.infer<typeof ActorKindSchema>;

/** 'room' = 방 구성원 규칙, `private:<userId>` = 그 사용자만 */
export type Visibility = 'room' | `private:${string}`;
export const VisibilitySchema = z.custom<Visibility>(
  (v) => v === 'room' || (typeof v === 'string' && /^private:.+$/.test(v)),
  { message: "visibility must be 'room' or 'private:<userId>'" },
);
export const privateTo = (userId: string): Visibility => `private:${userId}`;
/** `private:X`이면 X, 아니면 null */
export function privateOwner(v: Visibility): string | null {
  return v === 'room' ? null : v.slice('private:'.length);
}

export const MemberRoleSchema = z.enum(['owner', 'member', 'visitor']);
export type MemberRole = z.infer<typeof MemberRoleSchema>;

export const VisitorKindSchema = z.enum(['human', 'agent']);
export type VisitorKind = z.infer<typeof VisitorKindSchema>;

export const VisitStatusSchema = z.enum(['requested', 'active', 'ended', 'declined']);
export type VisitStatus = z.infer<typeof VisitStatusSchema>;

export const VisitEndReasonSchema = z.enum(['visitor_left', 'host_ended', 'agent_ended', 'turn_limit', 'timeout']);
export type VisitEndReason = z.infer<typeof VisitEndReasonSchema>;

export const ApprovalKindSchema = z.enum(['edit', 'decision', 'visit', 'takeout']);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const VoteDecisionSchema = z.enum(['approve', 'edit', 'reject']);
export type VoteDecision = z.infer<typeof VoteDecisionSchema>;

export const ApprovalOutcomeSchema = z.enum(['approved', 'edited', 'rejected']);
export type ApprovalOutcome = z.infer<typeof ApprovalOutcomeSchema>;

export const AgentStepKindSchema = z.enum(['reading', 'recalling', 'drafting', 'talking']);
export type AgentStepKind = z.infer<typeof AgentStepKindSchema>;

export const TurnResultSchema = z.enum(['acted', 'pass', 'error']);
export type TurnResult = z.infer<typeof TurnResultSchema>;

export const PassReasonSchema = z.enum(['not_addressed', 'nothing_to_add', 'waiting_for_human', 'outside_mandate']);
export type PassReason = z.infer<typeof PassReasonSchema>;

export const PauseReasonSchema = z.enum(['chain_limit', 'budget', 'visit_turn_limit']);
export type PauseReason = z.infer<typeof PauseReasonSchema>;

export const MemoryKindSchema = z.enum(['fact', 'preference', 'agreement', 'summary']);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

/** 카드 소유 표시: `user:<id>` | `agent:<id>` | `ours` */
export type OwnerTag = 'ours' | `user:${string}` | `agent:${string}`;
export const OwnerTagSchema = z.custom<OwnerTag>(
  (v) => v === 'ours' || (typeof v === 'string' && /^(user|agent):.+$/.test(v)),
  { message: "ownerTag must be 'ours', 'user:<id>' or 'agent:<id>'" },
);

/** Leave(대리 참여)·Agent 방문 때 소유자가 주는 위임 범위 */
export const MandateSchema = z.object({
  /** 사람이 읽는 위임 문구. 예: "토요일 오후, 3만원, 확정은 내 승인" */
  text: z.string().min(1).max(500),
  allowedActions: z.array(CapabilitySchema),
});
export type Mandate = z.infer<typeof MandateSchema>;

export const CardPatchSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  deleted: z.boolean().optional(),
});
export type CardPatch = z.infer<typeof CardPatchSchema>;

/* ------------------------------------------------------------------ */
/* 영속 이벤트 (계획 5절). 모든 이벤트는 `type` 판별자를 가진 flat 객체다.   */
/* ------------------------------------------------------------------ */

const ev = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), ...shape });

const id = z.string().min(1);

// Room / 구성원
const roomCreated = ev('room_created', { title: z.string().optional() });
const memberEntered = ev('member_entered', { userId: id, role: MemberRoleSchema });
/** `agentId`: 소유자의 Agent. `mandate`가 있으면 그 Agent가 대리 참여한다. */
const memberLeft = ev('member_left', {
  userId: id,
  implicit: z.boolean(),
  mandate: MandateSchema.optional(),
  agentId: id.optional(),
});
const memberRejoined = ev('member_rejoined', { userId: id, missedCount: z.number().int().min(0) });
const digestViewed = ev('digest_viewed', { userId: id });

// 방문
const visitRequested = ev('visit_requested', {
  visitId: id,
  visitorKind: VisitorKindSchema,
  visitorUserId: id,
  visitorAgentId: id.optional(),
  /** Agent 방문의 위임 범위. 호스트와 방문자 소유자에게 "위임 범위" 전용 표시로 보인다(사람 방문에는 없다) */
  mandate: MandateSchema.optional(),
});
const visitAccepted = ev('visit_accepted', { visitId: id, permissions: z.array(CapabilitySchema) });
const visitDeclined = ev('visit_declined', { visitId: id });
const agentDeparted = ev('agent_departed', { agentId: id, visitId: id, toRoomId: id });
const agentArrived = ev('agent_arrived', { agentId: id, visitId: id, fromRoomId: id });
const visitTakeout = ev('visit_takeout', { visitId: id, text: z.string() });
const visitEnded = ev('visit_ended', { visitId: id, reason: VisitEndReasonSchema });
const agentReturned = ev('agent_returned', { agentId: id, visitId: id });
const visitReport = ev('visit_report', { visitId: id, summary: z.string() });

// 내용
const message = ev('message', {
  text: z.string(),
  to: id.optional(),
  memoryRefs: z.array(id).optional(),
  clientId: id.optional(),
});
const cardCreated = ev('card_created', {
  cardId: id,
  title: z.string(),
  body: z.string(),
  ownerTag: OwnerTagSchema,
});
const cardUpdated = ev('card_updated', { cardId: id, patch: CardPatchSchema, version: z.number().int().min(1) });
const commentAdded = ev('comment_added', { cardId: id, text: z.string() });
const cardPointed = ev('card_pointed', { cardId: id, toAgentId: id });

// Agent
const agentTurnStarted = ev('agent_turn_started', {
  agentId: id,
  turnId: id,
  trigger: z.object({ seq: z.number().int(), reason: z.string() }),
});
const agentStep = ev('agent_step', {
  agentId: id,
  turnId: id,
  kind: AgentStepKindSchema,
  target: id.optional(),
});
const agentTurnEnded = ev('agent_turn_ended', {
  agentId: id,
  turnId: id,
  result: TurnResultSchema,
  passReason: PassReasonSchema.optional(),
});
const agentPaused = ev('agent_paused', { agentId: id, reason: PauseReasonSchema });

// 승인
/** `propose_edit`가 승인에 실어 보내는 카드 수정안 (S8 추가). `cardId`가 없으면 새 카드 제안이다. */
export const EditProposalSchema = z.object({
  cardId: z.string().min(1).optional(),
  title: z.string().optional(),
  body: z.string().optional(),
});
export type EditProposal = z.infer<typeof EditProposalSchema>;

const approvalRequested = ev('approval_requested', {
  approvalId: id,
  approvers: z.array(id).min(1),
  kind: ApprovalKindSchema,
  summary: z.string(),
  publicRationale: z.string().optional(),
  /** request_approval의 선택지 (2~4개). S8 추가, 선택 필드 */
  options: z.array(z.string()).min(2).max(4).optional(),
  /** propose_edit의 수정안. S8 추가, 선택 필드 */
  proposal: EditProposalSchema.optional(),
});
const approvalVoted = ev('approval_voted', {
  approvalId: id,
  userId: id,
  decision: VoteDecisionSchema,
  /** decision형 승인에서 고른 선택지 (S10 추가, 선택 필드) */
  option: z.string().optional(),
  /** decision이 'edit'일 때 수정한 수정안 (S10 추가, 선택 필드) */
  edited: EditProposalSchema.optional(),
});
const approvalResolved = ev('approval_resolved', {
  approvalId: id,
  outcome: ApprovalOutcomeSchema,
  /** decision형: 확정된 선택지 (S10 추가, 선택 필드) */
  option: z.string().optional(),
  /** edit형: 실제로 보드에 반영된 수정안(edited 결과면 수정본) (S10 추가, 선택 필드) */
  applied: EditProposalSchema.optional(),
});

/** Agent가 소유자에게만 남기는 메모 (S10 추가). visibility는 항상 private:<소유자> */
const agentOwnerNote = ev('agent_owner_note', { agentId: id, note: z.string().min(1) });

// 합의 / 메모리
const agreementFormed = ev('agreement_formed', { cardId: id, memberIds: z.array(id).min(1) });
const memoryRetained = ev('memory_retained', { itemId: id, ns: z.string().min(1), kind: MemoryKindSchema });

export const EventPayloadSchema = z.discriminatedUnion('type', [
  roomCreated,
  memberEntered,
  memberLeft,
  memberRejoined,
  digestViewed,
  visitRequested,
  visitAccepted,
  visitDeclined,
  agentDeparted,
  agentArrived,
  visitTakeout,
  visitEnded,
  agentReturned,
  visitReport,
  message,
  cardCreated,
  cardUpdated,
  commentAdded,
  cardPointed,
  agentTurnStarted,
  agentStep,
  agentTurnEnded,
  agentPaused,
  agentOwnerNote,
  approvalRequested,
  approvalVoted,
  approvalResolved,
  agreementFormed,
  memoryRetained,
]);
export type EventPayload = z.infer<typeof EventPayloadSchema>;
export type EventType = EventPayload['type'];
export type EventOf<T extends EventType> = Extract<EventPayload, { type: T }>;

export const EVENT_TYPES: readonly EventType[] = EventPayloadSchema.options.map((o) => o.shape.type.value);

/** events 테이블 한 행에 대응하는 공통 필드 */
export const EventEnvelopeSchema = z.object({
  roomId: id,
  seq: z.number().int().min(1),
  ts: z.number(),
  actorKind: ActorKindSchema,
  /** human: userId, agent: agentId, room_agent: roomAgentId, system: null */
  actorId: id.nullable(),
  visibility: VisibilitySchema,
  turnId: id.nullable(),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const RoomEventSchema = EventPayloadSchema.and(EventEnvelopeSchema);
/** 저장·전송·리듀서가 다루는 이벤트. `e.type`으로 좁히면 payload 필드가 flat하게 보인다. */
export type RoomEvent = EventPayload & EventEnvelope;

/** append 입력: seq와 ts는 store가 붙인다. visibility 기본 'room', turnId 기본 null */
export type NewRoomEvent = Omit<EventEnvelope, 'seq' | 'ts' | 'visibility' | 'turnId'> & {
  visibility?: Visibility;
  turnId?: string | null;
} & EventPayload;

/** events 테이블 행 모양. payload_json은 `type`을 뺀 나머지 필드다. */
export interface StoredEventRow {
  roomId: string;
  seq: number;
  ts: number;
  actorKind: ActorKind;
  actorId: string | null;
  type: EventType;
  payload: Record<string, unknown>;
  visibility: Visibility;
  turnId: string | null;
}

const ENVELOPE_KEYS = new Set(Object.keys(EventEnvelopeSchema.shape));

export function toStoredRow(event: RoomEvent): StoredEventRow {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (k !== 'type' && !ENVELOPE_KEYS.has(k)) payload[k] = v;
  }
  return {
    roomId: event.roomId,
    seq: event.seq,
    ts: event.ts,
    actorKind: event.actorKind,
    actorId: event.actorId,
    type: event.type,
    payload,
    visibility: event.visibility,
    turnId: event.turnId,
  };
}

/** 저장된 행을 검증해 RoomEvent로 복원한다. 스키마와 맞지 않으면 throw. */
export function fromStoredRow(row: StoredEventRow): RoomEvent {
  return RoomEventSchema.parse({
    ...row.payload,
    type: row.type,
    roomId: row.roomId,
    seq: row.seq,
    ts: row.ts,
    actorKind: row.actorKind,
    actorId: row.actorId,
    visibility: row.visibility,
    turnId: row.turnId,
  });
}

/* ------------------------------------------------------------------ */
/* 가시성 (계획 5절 canSee)                                              */
/* ------------------------------------------------------------------ */

export interface VisitScope {
  visitorUserId: string;
  /** 사람 방문만 해당 */
  visitorKind: VisitorKind;
  status: VisitStatus;
  startSeq: number | null;
}

export interface CanSeeContext {
  viewerId: string;
  roomKind: RoomKind;
  /** my Room 소유자. our/dm은 null */
  ownerId: string | null;
  /** our/dm 구성원 */
  memberIds: readonly string[];
  /** 이 Room에 대한 방문들 */
  visits: readonly VisitScope[];
}

/** 이벤트 한 건을 viewer가 볼 수 있는지. 서버 hub와 스냅샷, 웹 리플레이가 같은 함수를 쓴다. */
export function canSeeEvent(event: Pick<EventEnvelope, 'seq' | 'visibility'>, ctx: CanSeeContext): boolean {
  const owner = privateOwner(event.visibility);
  if (owner !== null) return owner === ctx.viewerId;
  if (ctx.roomKind === 'my') {
    if (ctx.ownerId === ctx.viewerId) return true;
    return ctx.visits.some(
      (v) =>
        v.visitorKind === 'human' &&
        v.visitorUserId === ctx.viewerId &&
        v.status === 'active' &&
        v.startSeq !== null &&
        event.seq >= v.startSeq,
    );
  }
  return ctx.memberIds.includes(ctx.viewerId);
}

/* ------------------------------------------------------------------ */
/* 휘발성 메시지 (영속하지 않는다)                                        */
/* ------------------------------------------------------------------ */

/** 턴 진행 중 휘발성 활동 단계 (S8 추가). 영속 `agent_step`과 달리 개수 제한이 없다. */
export const ACTIVITY_PHASES = ['thinking', 'recalling', 'writing', 'acting'] as const;
export type ActivityPhase = (typeof ACTIVITY_PHASES)[number];

/**
 * `text`는 지금까지 스트리밍된 누적 텍스트(say.text / comment.text)이고 계속 교체된다. 단계만 알릴 때는 빈 문자열.
 * `phase`(S8 추가, 선택): 어떤 단계인가. `final`(S8 추가, 선택): 턴이 끝나 활동 표시를 지워도 된다.
 */
export const ActivityMessageSchema = z.object({
  type: z.literal('activity'),
  roomId: id,
  agentId: id,
  turnId: id,
  text: z.string(),
  tokensPerSec: z.number().min(0),
  phase: z.enum(ACTIVITY_PHASES).optional(),
  final: z.boolean().optional(),
});
export type ActivityMessage = z.infer<typeof ActivityMessageSchema>;

/** 20Hz. roomId가 null이면 해변(월드) 위 */
export const CursorMessageSchema = z.object({
  type: z.literal('cursor'),
  userId: id,
  x: z.number(),
  y: z.number(),
  z: z.number(),
  roomId: id.nullable(),
});
export type CursorMessage = z.infer<typeof CursorMessageSchema>;

export const PresenceMessageSchema = z.object({
  type: z.literal('presence'),
  roomId: id,
  userIds: z.array(id),
});
export type PresenceMessage = z.infer<typeof PresenceMessageSchema>;

export const VolatileMessageSchema = z.discriminatedUnion('type', [
  ActivityMessageSchema,
  CursorMessageSchema,
  PresenceMessageSchema,
]);
export type VolatileMessage = z.infer<typeof VolatileMessageSchema>;
