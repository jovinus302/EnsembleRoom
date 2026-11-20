import { z } from 'zod';
import {
  ActivityMessageSchema,
  ActorKindSchema,
  ApprovalKindSchema,
  ApprovalOutcomeSchema,
  CardPatchSchema,
  EditProposalSchema,
  CursorMessageSchema,
  MandateSchema,
  MemoryKindSchema,
  OwnerTagSchema,
  PresenceMessageSchema,
  RoomEventSchema,
  RoomKindSchema,
  VisitStatusSchema,
  VoteDecisionSchema,
} from './events';
import { CapabilitySchema } from './permissions';
import { AMBIENCE_STAGES } from './roomState';
import { GLASS_CLARITIES } from './perspective';
import { ThemeIdSchema, ThemeVariantSchema } from './themes';
import { AGENT_ACTIVITIES, AGENT_MODES } from './agentState';

const id = z.string().min(1);

/* ---------------------------- 공통 ---------------------------- */

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.string(),
  time: z.string(),
  agentMode: z.enum(['claude', 'mock']),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ApiErrorSchema = z.object({ error: z.string(), code: z.string().optional() });
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const UserDtoSchema = z.object({
  id,
  name: z.string(),
  color: z.string(),
  kind: z.enum(['person', 'seed']),
});
export type UserDto = z.infer<typeof UserDtoSchema>;

export const AgentDtoSchema = z.object({
  id,
  /** 'personal' | 'room' */
  kind: z.enum(['personal', 'room']),
  ownerId: id.nullable(),
  name: z.string(),
  personaPublic: z.string(),
  variant: z.string().nullable(),
});
export type AgentDto = z.infer<typeof AgentDtoSchema>;

export const RoomInfoSchema = z.object({
  id,
  kind: RoomKindSchema,
  ownerId: id.nullable(),
  title: z.string(),
  theme: ThemeIdSchema,
  themeVariant: ThemeVariantSchema.nullable(),
  memberIds: z.array(id),
});
export type RoomInfo = z.infer<typeof RoomInfoSchema>;

/* ---------------------------- 세션 ---------------------------- */

export const LoginRequestSchema = z.object({ name: z.string().min(1) });
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export const LoginResponseSchema = z.object({ token: z.string(), user: UserDtoSchema });
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const MeResponseSchema = z.object({ user: UserDtoSchema, agent: AgentDtoSchema.nullable() });
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const UsersResponseSchema = z.object({ users: z.array(UserDtoSchema) });
export type UsersResponse = z.infer<typeof UsersResponseSchema>;

/* ---------------------------- 월드 ---------------------------- */

/** 가장 최근 Agent 이동. seq는 출발 Room 로그의 agent_departed seq, at은 그 이벤트의 ts(ms) */
export const AgentTravelSchema = z.object({
  fromRoomId: id,
  toRoomId: id,
  seq: z.number().int().min(0),
  at: z.number(),
});
export type AgentTravel = z.infer<typeof AgentTravelSchema>;

export const AgentChipSchema = z.object({
  agentId: id,
  name: z.string(),
  activity: z.enum(AGENT_ACTIVITIES),
  mode: z.enum(AGENT_MODES),
  /**
   * 지금 있는 Room. 이동 중이면 null. 방문 중인 Agent는 호스트 Room id —
   * 단 그 방문을 알 자격이 있는 시청자(Agent 소유자·호스트 소유자)에게만 채운다(그 외에는 null).
   */
  location: id.nullable().optional(),
  /** 진행 중 방문 Agent의 가장 최근 이동(출발→호스트). 소유자·호스트 소유자에게만. 이동 자체는 순간적이라 상태 대신 마지막 이동을 싣는다 */
  travel: AgentTravelSchema.nullable().optional(),
});
export type AgentChip = z.infer<typeof AgentChipSchema>;

/** 내 Agent의 현재 위치·상태 (월드 헤더·미리보기용). 예: "Bob의 Room 방문 중" */
export const MyAgentStatusSchema = z.object({
  agentId: id,
  name: z.string(),
  mode: z.enum(AGENT_MODES),
  activity: z.enum(AGENT_ACTIVITIES),
  /** 지금 있는 Room. 이동 중이면 null */
  location: id.nullable(),
  label: z.string(),
  /** 진행 중 방문의 가장 최근 이동(출발→목적지) */
  travel: AgentTravelSchema.nullable().optional(),
});
export type MyAgentStatus = z.infer<typeof MyAgentStatusSchema>;

/** 내용 요약. 남의 캡슐에는 내려보내지 않는다(null) */
export const RoomPreviewDetailSchema = z.object({
  unread: z.number().int().min(0),
  /** 내가 없는 동안 변화 수 */
  missedChanges: z.number().int().min(0),
  agents: z.array(AgentChipSchema),
  pendingApprovals: z.number().int().min(0),
  /** 지금 그 방에 있는 사람(명시적 Leave 제외, 수락된 사람 방문자 포함). ambience와 같은 출처 */
  presentUserIds: z.array(id).optional(),
  /** 내가 명시적으로 Leave한 상태: delegated=Agent 대리 중(위임 있음), plain=위임 없이 자리만 비움. 아니면 null/생략 */
  myLeave: z.enum(['delegated', 'plain']).nullable().optional(),
  /** 지금 진행 중인 A2A/A2H(구성원에게만). 내용 텍스트는 없다. 없으면 null/생략 */
  interaction: z
    .object({
      channel: z.enum(['a2a', 'a2h']),
      fromId: id,
      toIds: z.array(id),
      seq: z.number().int(),
      at: z.number(),
      pending: z.boolean(),
    })
    .nullable()
    .optional(),
});
export type RoomPreviewDetail = z.infer<typeof RoomPreviewDetailSchema>;

export const RoomPreviewSchema = z.object({
  roomId: id,
  /** 이름, 테마, 조명 단계는 누구에게나 보인다 */
  ambience: z.enum(AMBIENCE_STAGES),
  glass: z.enum(GLASS_CLARITIES),
  detail: RoomPreviewDetailSchema.nullable(),
});
export type RoomPreview = z.infer<typeof RoomPreviewSchema>;

export const WorldRoomSchema = RoomInfoSchema.extend({ preview: RoomPreviewSchema });
export type WorldRoom = z.infer<typeof WorldRoomSchema>;

export const WorldResponseSchema = z.object({
  me: UserDtoSchema,
  users: z.array(UserDtoSchema),
  rooms: z.array(WorldRoomSchema),
  /** 내 Agent의 현재 위치·상태 */
  myAgent: MyAgentStatusSchema.nullable().optional(),
});
export type WorldResponse = z.infer<typeof WorldResponseSchema>;

/* ---------------------------- Room 조회 ---------------------------- */

export const VisitDtoSchema = z.object({
  id,
  hostRoomId: id,
  visitorKind: z.enum(['human', 'agent']),
  visitorUserId: id,
  visitorAgentId: id.nullable(),
  status: VisitStatusSchema,
  permissions: z.array(CapabilitySchema),
  mandate: MandateSchema.nullable(),
  startSeq: z.number().int().nullable(),
  endSeq: z.number().int().nullable(),
});
export type VisitDto = z.infer<typeof VisitDtoSchema>;

export const RoomSnapshotSchema = z.object({
  room: RoomInfoSchema,
  agents: z.array(AgentDtoSchema),
  /** 보는 사람에게 보이는 이벤트만 (visibility 필터 적용 후) */
  events: z.array(RoomEventSchema),
  lastSeq: z.number().int().min(0),
  visits: z.array(VisitDtoSchema),
  readCursor: z.object({ lastSeenSeq: z.number().int(), leftAtSeq: z.number().int().nullable() }),
});
export type RoomSnapshot = z.infer<typeof RoomSnapshotSchema>;

/* ---------------------------- Room 쓰기 요청 ---------------------------- */

export const SendMessageRequestSchema = z.object({ text: z.string().min(1), to: id.optional(), clientId: id });
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const CreateCardRequestSchema = z.object({
  title: z.string().min(1),
  body: z.string().default(''),
  ownerTag: OwnerTagSchema.optional(),
});
export type CreateCardRequest = z.input<typeof CreateCardRequestSchema>;

export const PatchCardRequestSchema = z.object({ patch: CardPatchSchema, baseVersion: z.number().int().min(1) });
export type PatchCardRequest = z.infer<typeof PatchCardRequestSchema>;

export const CommentRequestSchema = z.object({ cardId: id, text: z.string().min(1) });
export type CommentRequest = z.infer<typeof CommentRequestSchema>;

export const PointRequestSchema = z.object({ cardId: id, agentId: id });
export type PointRequest = z.infer<typeof PointRequestSchema>;

export const LeaveRequestSchema = z.object({ mandate: MandateSchema.optional() });
export type LeaveRequest = z.infer<typeof LeaveRequestSchema>;

export const SeenRequestSchema = z.object({ seq: z.number().int().min(0) });
export type SeenRequest = z.infer<typeof SeenRequestSchema>;

/** 쓰기 성공 응답: 확정된 seq */
export const AppendResponseSchema = z.object({ seq: z.number().int().min(1) });
export type AppendResponse = z.infer<typeof AppendResponseSchema>;

/* ---------------------------- 방문 · 승인 · 메모리 ---------------------------- */

export const HumanVisitRequestSchema = z.object({ kind: z.literal('human') });
export type HumanVisitRequest = z.infer<typeof HumanVisitRequestSchema>;

export const AgentVisitRequestSchema = z.object({ mandate: MandateSchema });
export type AgentVisitRequest = z.infer<typeof AgentVisitRequestSchema>;

export const AcceptVisitRequestSchema = z.object({ permissions: z.array(CapabilitySchema) });
export type AcceptVisitRequest = z.infer<typeof AcceptVisitRequestSchema>;

export const VoteRequestSchema = z.object({
  decision: VoteDecisionSchema,
  /** decision이 'edit'일 때 수정한 내용 */
  edited: z.record(z.string(), z.unknown()).optional(),
  /** decision형 승인에서 'approve'할 때 고르는 선택지 (S10 추가) */
  option: z.string().min(1).optional(),
});
export type VoteRequest = z.infer<typeof VoteRequestSchema>;

/** 승인 한 건 (S10 추가). `GET /api/approvals`와 vote 응답이 쓴다. */
export const ApprovalItemDtoSchema = z.object({
  roomId: id,
  roomTitle: z.string(),
  approvalId: id,
  kind: ApprovalKindSchema,
  summary: z.string(),
  publicRationale: z.string().nullable(),
  options: z.array(z.string()).optional(),
  proposal: EditProposalSchema.optional(),
  approvers: z.array(id),
  votes: z.record(z.string(), VoteDecisionSchema),
  status: z.enum(['pending', ...ApprovalOutcomeSchema.options]),
  /** 확정된 선택지 (decision형이 승인으로 끝났을 때) */
  resolvedOption: z.string().nullable(),
  requestedSeq: z.number().int(),
  requestedBy: z.string().nullable(),
  requestedByKind: ActorKindSchema,
});
export type ApprovalItemDto = z.infer<typeof ApprovalItemDtoSchema>;

export const ApprovalListResponseSchema = z.object({ approvals: z.array(ApprovalItemDtoSchema) });
export type ApprovalListResponse = z.infer<typeof ApprovalListResponseSchema>;

export const VoteResponseSchema = z.object({
  seq: z.number().int().min(0),
  /** 투표 후 승인 상태. 아직 다른 승인자를 기다리면 'pending' */
  status: z.enum(['pending', ...ApprovalOutcomeSchema.options]),
  approval: ApprovalItemDtoSchema,
});
export type VoteResponse = z.infer<typeof VoteResponseSchema>;

/** Rejoin 다이제스트 (S10 추가). `GET /api/rooms/:id/digest` — 요청자의 가시성 필터가 적용된다. */
export const DigestBoardChangeSchema = z.object({
  cardId: id,
  title: z.string(),
  change: z.enum(['created', 'updated', 'deleted', 'commented', 'agreed']),
});
export type DigestBoardChange = z.infer<typeof DigestBoardChangeSchema>;

export const DigestResponseSchema = z.object({
  roomId: id,
  /** 자리를 비운 시점. 비운 적이 없으면 null (summary도 null) */
  leftAtSeq: z.number().int().nullable(),
  upToSeq: z.number().int().min(0),
  missedCount: z.number().int().min(0),
  summary: z.string().nullable(),
  boardChanges: z.array(DigestBoardChangeSchema),
  pendingApprovals: z.array(ApprovalItemDtoSchema),
});
export type DigestResponse = z.infer<typeof DigestResponseSchema>;

export const MemoryItemDtoSchema = z.object({
  id,
  ns: z.string(),
  kind: MemoryKindSchema,
  text: z.string(),
  sourceRoomId: id.nullable(),
  createdBy: z.string(),
  status: z.enum(['active', 'deleted']),
  createdAt: z.number(),
});
export type MemoryItemDto = z.infer<typeof MemoryItemDtoSchema>;

export const CreateMemoryRequestSchema = z.object({
  ns: z.string().min(1),
  kind: MemoryKindSchema,
  text: z.string().min(1),
});
export type CreateMemoryRequest = z.infer<typeof CreateMemoryRequestSchema>;

/** 항목별 공유 대상 변경: `agent:<내 Agent>:private` 또는 `agent:<내 Agent>:for:<RoomId>` */
export const UpdateMemoryRequestSchema = z.object({ ns: z.string().min(1) });
export type UpdateMemoryRequest = z.infer<typeof UpdateMemoryRequestSchema>;

export const MemoryListResponseSchema = z.object({ items: z.array(MemoryItemDtoSchema) });
export type MemoryListResponse = z.infer<typeof MemoryListResponseSchema>;

/* ---------------------------- WebSocket ---------------------------- */

/** 클라이언트 → 서버 */
export const ClientWsMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), roomId: id }),
  z.object({ type: z.literal('unsubscribe'), roomId: id }),
  z.object({ type: z.literal('subscribe_world') }),
  CursorMessageSchema.omit({ userId: true }),
]);
export type ClientWsMessage = z.infer<typeof ClientWsMessageSchema>;

/** 서버 → 클라이언트. 이벤트는 hub가 구독자별 가시성을 적용한 뒤 보낸다 */
export const ServerWsMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), event: RoomEventSchema }),
  z.object({ type: z.literal('ack'), clientId: id, seq: z.number().int() }),
  ActivityMessageSchema,
  CursorMessageSchema,
  PresenceMessageSchema,
  z.object({
    type: z.literal('world_preview'),
    preview: RoomPreviewSchema,
    /** 내 Agent의 현재 위치·상태 (방문·presence 변화에 따라 갱신) */
    myAgent: MyAgentStatusSchema.nullable().optional(),
  }),
]);
export type ServerWsMessage = z.infer<typeof ServerWsMessageSchema>;

/* ---------------------------- 지표 (S20) ---------------------------- */

/**
 * `GET /api/metrics[?roomId=]` — 이벤트 로그에서 파생한 집계. 요청자가 볼 수 있는 이벤트(canSeeEvent)만 센다.
 * 비율(`*Rate`)은 분모가 0이면 null이다. 소요 시간은 ms.
 */
export const MetricsCountersSchema = z.object({
  agentTurns: z.object({
    started: z.number().int(),
    acted: z.number().int(),
    pass: z.number().int(),
    error: z.number().int(),
    paused: z.number().int(),
  }),
  visits: z.object({
    requested: z.number().int(),
    humanRequested: z.number().int(),
    /** Agent 보내기(visitorKind=agent) 요청 수 */
    agentSent: z.number().int(),
    accepted: z.number().int(),
    declined: z.number().int(),
    ended: z.number().int(),
    /** accepted / requested */
    acceptRate: z.number().nullable(),
    takeouts: z.number().int(),
    /** takeouts / agentSent */
    takeoutRate: z.number().nullable(),
  }),
  presence: z.object({
    entered: z.number().int(),
    leavesExplicit: z.number().int(),
    leavesImplicit: z.number().int(),
    /** 위임(mandate)을 남긴 Leave 수 */
    leavesWithMandate: z.number().int(),
    /** leavesWithMandate / leavesExplicit (Leave 실행률) */
    mandateRate: z.number().nullable(),
    rejoins: z.number().int(),
    /** rejoins / (명시+암묵 Leave) */
    rejoinRate: z.number().nullable(),
    digestViewed: z.number().int(),
    /** member_rejoined.missedCount 합 (부재 중 놓친 변화) */
    missedChanges: z.number().int(),
  }),
  approvals: z.object({
    requested: z.number().int(),
    resolved: z.number().int(),
    pending: z.number().int(),
    approved: z.number().int(),
    edited: z.number().int(),
    rejected: z.number().int(),
    approvedRate: z.number().nullable(),
    editedRate: z.number().nullable(),
    rejectedRate: z.number().nullable(),
    /** 요청 → 해소까지 평균 소요(ms) */
    avgResolveMs: z.number().nullable(),
    byKind: z.record(z.string(), z.number().int()),
  }),
  agreements: z.number().int(),
  memoryRetained: z.number().int(),
});
export type MetricsCounters = z.infer<typeof MetricsCountersSchema>;

export const RoomMetricsSchema = MetricsCountersSchema.extend({
  roomId: id,
  title: z.string(),
  kind: RoomKindSchema,
});
export type RoomMetrics = z.infer<typeof RoomMetricsSchema>;

export const MetricsResponseSchema = z.object({
  generatedAt: z.number(),
  totals: MetricsCountersSchema,
  rooms: z.object({
    /** 보이는 이벤트가 하나라도 있는 Room 수 */
    active: z.number().int(),
    /** 입장·재합류가 2회 이상인 Room 수 (반복 사용) */
    repeatUse: z.number().int(),
    repeatUseRate: z.number().nullable(),
  }),
  perRoom: z.array(RoomMetricsSchema),
});
export type MetricsResponse = z.infer<typeof MetricsResponseSchema>;
