import { randomUUID } from 'node:crypto';
import {
  AnswerBlockSchema,
  MAX_BLOCKS_PER_MESSAGE,
  effectiveCapabilities,
  type AnswerBlock,
  type BoardToolInitInput,
  type BoardToolOpInput,
  type CardPatch,
  type Capability,
  type EventPayload,
  type Mandate,
  type MemoryKind,
  type OwnerTag,
  type PermissionSubject,
  type RoomEvent,
  type VisitEndReason,
  type Visibility,
  type VoteDecision,
} from '@ensemble/shared';
import type { AppContext } from '../context';
import type { RoomRow } from '../db/repo';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { APPROVAL_REQUEST_HANDLERS } from './approvalRequests';
import { APPROVAL_HANDLERS } from './approvals';
import { BOARD_TOOL_HANDLERS } from './boardTools';
import { LIFECYCLE_HANDLERS } from './lifecycleHandlers';
import { requireRoom, resolveSubject, type ActorCtx } from './rooms';

/**
 * 모든 쓰기의 단일 입구 (계획 6절). 사람·Agent가 같은 `dispatch(ctx, actor, action)`를 쓴다.
 *   authorize(구성원·capability를 서버 진실로 재계산) → apply(투영 테이블 갱신) → append(이벤트), 한 트랜잭션.
 *
 * 액션 종류 추가 방법 (S6 이후 단계):
 *   1. 아래 `Action` 유니온에 `{ type: '...', roomId, ... }`를 추가한다.
 *   2. `HANDLERS`에 같은 키의 핸들러를 추가한다(타입이 강제한다). 필요한 capability, 추가 검사(authorize), apply를 쓴다.
 *   3. apply는 투영 테이블(repo)을 갱신하고 append할 이벤트 초안들을 돌려준다. 이벤트는 dispatch가 붙인다.
 */

export type Action =
  | { type: 'send_message'; roomId: string; text: string; to?: string; clientId?: string; memoryRefs?: string[]; recipients?: string[]; replyTo?: number; blocks?: AnswerBlock[] }
  | { type: 'create_card'; roomId: string; title: string; body: string; ownerTag?: OwnerTag }
  | { type: 'update_card'; roomId: string; cardId: string; patch: CardPatch; baseVersion: number }
  | { type: 'add_comment'; roomId: string; cardId: string; text: string }
  | { type: 'point_card'; roomId: string; cardId: string; agentId: string }
  | { type: 'mark_seen'; roomId: string; seq: number }
  // 보드 도구 (domain/boardTools.ts). init·op는 입력 형태(id·seed 없음)
  | { type: 'create_board_tool'; roomId: string; title: string; init: BoardToolInitInput }
  | { type: 'update_board_tool'; roomId: string; toolId: string; op: BoardToolOpInput }
  | { type: 'remove_board_tool'; roomId: string; toolId: string }
  // 커버 이미지 상태: 서버 시스템(media/covers.ts)만. REST·Agent 도구로는 만들 수 없다
  | { type: 'set_board_tool_cover'; roomId: string; toolId: string; status: 'pending' | 'ready' | 'failed'; assetId?: string }
  // presence (domain/presence.ts)
  | { type: 'enter_room'; roomId: string }
  | { type: 'leave_room'; roomId: string; mandate?: Mandate }
  | { type: 'rejoin_room'; roomId: string }
  | { type: 'view_digest'; roomId: string }
  | { type: 'implicit_leave'; roomId: string; userId: string }
  // 방문 (domain/visits.ts). roomId는 항상 호스트 Room
  | { type: 'request_visit'; roomId: string; kind: 'human' | 'agent'; mandate?: Mandate }
  | { type: 'accept_visit'; roomId: string; visitId: string; permissions: Capability[] }
  | { type: 'decline_visit'; roomId: string; visitId: string }
  | { type: 'end_visit'; roomId: string; visitId: string; reason: VisitEndReason; takeout?: string; report?: string }
  // 승인 요청 (domain/approvalRequests.ts). 승인자는 서버가 정한다. 투표·해소는 domain/approvals.ts.
  | { type: 'propose_edit'; roomId: string; cardId?: string; title?: string; body?: string; rationale?: string }
  | { type: 'request_approval'; roomId: string; question: string; options: string[]; rationale?: string }
  // 승인 투표·해소 (domain/approvals.ts). roomId는 승인이 속한 Room
  | { type: 'vote_approval'; roomId: string; approvalId: string; decision: VoteDecision; option?: string; edited?: Record<string, unknown> }
  // 메모리 (memory/gateway.ts). ns는 gateway가 서버 진실로 정해 넘기고, 핸들러가 다시 검증한다.
  | { type: 'retain_memory'; roomId: string; ns: string; kind: MemoryKind; text: string; sourceRoomId?: string | null };

export type ActionType = Action['type'];

/**
 * append할 이벤트 초안. roomId·actor·turnId는 dispatch가 채운다.
 * - `roomId`: 다른 Room에도 같은 트랜잭션으로 기록할 때(예: 방문 요청을 DM에도) 지정한다.
 * - `asSystem`: 행위자를 system으로 기록한다(예: 수락이 일으킨 agent_departed).
 */
export type EventDraft = EventPayload & { visibility?: Visibility; roomId?: string; asSystem?: boolean };

export interface HandlerEnv {
  ctx: AppContext;
  actor: ActorCtx;
  room: RoomRow;
  /** system 행위자면 null */
  subject: PermissionSubject | null;
  caps: readonly Capability[];
}

export interface HandlerResult {
  events: EventDraft[];
  data?: Record<string, unknown>;
}

export interface ActionHandler<A extends Action> {
  /** 필요한 capability. null이면 Room 접근만 요구한다. */
  capability: Capability | null;
  /** 추가 도메인 검사. 위반 시 DomainError를 던진다. */
  authorize?(env: HandlerEnv, action: A): void;
  apply(env: HandlerEnv, action: A): HandlerResult;
  /** true면 Room 구성원이 아니어도(subject 없음) authorize까지 간다. 이때 권한 판단은 전적으로 authorize의 몫이다. */
  allowOutsider?: boolean;
  /** 이벤트가 append된 직후(같은 트랜잭션) 호출한다. 투영 테이블에 seq를 기록할 때 쓴다. */
  afterAppend?(env: HandlerEnv, action: A, events: RoomEvent[]): void;
}

export interface DispatchResult {
  events: RoomEvent[];
  /** 마지막으로 append된 이벤트의 seq. 이벤트가 없는 액션이면 null */
  seq: number | null;
  data: Record<string, unknown>;
}

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

/* ------------------------------ 검사 도우미 ------------------------------ */

/** 사람·Agent·Room Agent 중 실제로 존재하는 id인가 */
function entityExists(ctx: AppContext, id: string): boolean {
  return !!(ctx.repo.getAgent(id) ?? ctx.repo.getRoomAgent(id) ?? ctx.repo.getUser(id));
}
function agentExists(ctx: AppContext, id: string): boolean {
  return !!(ctx.repo.getAgent(id) ?? ctx.repo.getRoomAgent(id));
}

function liveCard(env: HandlerEnv, cardId: string) {
  const card = env.ctx.repo.getCard(env.room.id, cardId);
  if (!card || card.deleted) throw notFound('card_not_found', '존재하지 않는 카드');
  return card;
}

/** 새 카드의 ownerTag를 정한다. 사람은 자기 것이나 우리 것만, Agent는 자기 것만 */
export function resolveOwnerTag(env: HandlerEnv, requested: OwnerTag | undefined): OwnerTag {
  const { actor, room } = env;
  const own: OwnerTag | null =
    actor.kind === 'human'
      ? `user:${actor.userId}`
      : actor.kind === 'agent'
        ? `agent:${actor.agentId}`
        : actor.kind === 'room_agent'
          ? 'ours'
          : null;
  const dflt: OwnerTag = room.kind === 'our' ? 'ours' : (own ?? 'ours');
  const tag = requested ?? dflt;
  if (tag === 'ours') {
    if (room.kind !== 'our') throw badRequest('invalid_owner_tag', "'ours'는 Our Room에서만 쓸 수 있습니다");
    return tag;
  }
  if (actor.kind !== 'system' && tag !== own) throw forbidden('owner_tag_mismatch', '남의 이름으로 카드를 만들 수 없습니다');
  return tag;
}

/* ------------------------------ 핸들러 ------------------------------ */

const sendMessage: ActionHandler<Extract<Action, { type: 'send_message' }>> = {
  capability: 'chat',
  authorize(env, a) {
    const { ctx } = env;
    if (!a.text.trim()) throw badRequest('empty_message');
    if (a.to !== undefined && !entityExists(ctx, a.to)) throw badRequest('unknown_recipient', `존재하지 않는 수신자: ${a.to}`);
    // A2A 필드(recipients, replyTo)는 Agent(서버의 ask_agents 도구·답 턴)만 쓴다. 사람은 보낼 수 없다.
    if (a.recipients !== undefined || a.replyTo !== undefined) {
      if (env.actor.kind !== 'agent' && env.actor.kind !== 'room_agent') throw forbidden('agent_only_field', 'recipients·replyTo는 Agent만 쓸 수 있습니다');
    }
    // 답변 카드(blocks)도 Agent 전용. 내용은 서버가 정규화한 것만 온다
    if (a.blocks !== undefined) {
      if (env.actor.kind !== 'agent' && env.actor.kind !== 'room_agent') throw forbidden('agent_only_field', 'blocks는 Agent만 쓸 수 있습니다');
      if (!AnswerBlockSchema.array().max(MAX_BLOCKS_PER_MESSAGE).safeParse(a.blocks).success) throw badRequest('invalid_blocks', '답변 카드 형식이 올바르지 않습니다');
    }
    if (a.recipients !== undefined) {
      if (a.recipients.length < 1 || a.recipients.length > 3) throw badRequest('invalid_recipients', '수신 Agent는 1~3명이어야 합니다');
      if (new Set(a.recipients).size !== a.recipients.length) throw badRequest('invalid_recipients', '수신 Agent가 중복되었습니다');
      for (const r of a.recipients) if (!agentExists(ctx, r)) throw badRequest('unknown_recipient', `존재하지 않는 Agent: ${r}`);
    }
    if (a.replyTo !== undefined && (!Number.isInteger(a.replyTo) || a.replyTo < 1 || a.replyTo > ctx.store.lastSeq(env.room.id))) {
      throw badRequest('invalid_reply_to', '이 Room에 없는 seq입니다');
    }
  },
  apply(_env, a) {
    return {
      events: [
        {
          type: 'message',
          text: a.text,
          to: a.to,
          memoryRefs: a.memoryRefs,
          clientId: a.clientId,
          ...(a.recipients ? { recipients: a.recipients } : {}),
          ...(a.replyTo !== undefined ? { replyTo: a.replyTo } : {}),
          ...(a.blocks?.length ? { blocks: a.blocks } : {}),
        },
      ],
    };
  },
};

const createCard: ActionHandler<Extract<Action, { type: 'create_card' }>> = {
  capability: 'edit_board',
  authorize(_env, a) {
    if (!a.title.trim()) throw badRequest('empty_title');
  },
  apply(env, a) {
    const cardId = newId('c');
    const ownerTag = resolveOwnerTag(env, a.ownerTag);
    env.ctx.repo.insertCard({ roomId: env.room.id, cardId, title: a.title, body: a.body, ownerTag });
    return { events: [{ type: 'card_created', cardId, title: a.title, body: a.body, ownerTag }], data: { cardId } };
  },
};

const updateCard: ActionHandler<Extract<Action, { type: 'update_card' }>> = {
  capability: 'edit_board',
  authorize(env, a) {
    const card = liveCard(env, a.cardId);
    // 합의된 카드는 decision 승인을 거쳐야 수정할 수 있다(승인 흐름은 S10). 그 전까지 직접 수정은 막는다.
    if (card.agreed && env.room.kind === 'our') {
      throw forbidden('needs_decision_approval', '합의된 카드는 승인을 거쳐야 수정할 수 있습니다');
    }
    const p = a.patch;
    if (p.title === undefined && p.body === undefined && p.deleted === undefined) throw badRequest('empty_patch');
    if (p.title !== undefined && !p.title.trim()) throw badRequest('empty_title');
  },
  apply(env, a) {
    const card = liveCard(env, a.cardId);
    if (card.version !== a.baseVersion) {
      throw conflict('version_conflict', '다른 사람이 먼저 수정했습니다', { card });
    }
    const version = card.version + 1;
    env.ctx.repo.updateCard(env.room.id, a.cardId, {
      title: a.patch.title ?? card.title,
      body: a.patch.body ?? card.body,
      deleted: a.patch.deleted ?? card.deleted,
      version,
    });
    return { events: [{ type: 'card_updated', cardId: a.cardId, patch: a.patch, version }], data: { cardId: a.cardId, version } };
  },
};

const addComment: ActionHandler<Extract<Action, { type: 'add_comment' }>> = {
  capability: 'comment',
  authorize(env, a) {
    liveCard(env, a.cardId);
    if (!a.text.trim()) throw badRequest('empty_comment');
  },
  apply(_env, a) {
    return { events: [{ type: 'comment_added', cardId: a.cardId, text: a.text }] };
  },
};

const pointCard: ActionHandler<Extract<Action, { type: 'point_card' }>> = {
  capability: 'chat',
  authorize(env, a) {
    liveCard(env, a.cardId);
    if (!agentExists(env.ctx, a.agentId)) throw badRequest('unknown_agent', `존재하지 않는 Agent: ${a.agentId}`);
  },
  apply(_env, a) {
    return { events: [{ type: 'card_pointed', cardId: a.cardId, toAgentId: a.agentId }] };
  },
};

/** 이벤트가 아니라 read_cursors 갱신. 사람만 할 수 있다. */
const markSeen: ActionHandler<Extract<Action, { type: 'mark_seen' }>> = {
  capability: null,
  authorize(env) {
    if (env.actor.kind !== 'human') throw forbidden('humans_only', '읽음 표시는 사람만 할 수 있습니다');
  },
  apply(env, a) {
    const userId = (env.actor as { userId: string }).userId;
    env.ctx.repo.setSeen(userId, env.room.id, Math.min(a.seq, env.ctx.store.lastSeq(env.room.id)));
    return { events: [] };
  },
};

const HANDLERS: { [K in ActionType]: ActionHandler<Extract<Action, { type: K }>> } = {
  ...LIFECYCLE_HANDLERS,
  ...APPROVAL_REQUEST_HANDLERS,
  ...APPROVAL_HANDLERS,
  ...BOARD_TOOL_HANDLERS,
  send_message: sendMessage,
  create_card: createCard,
  update_card: updateCard,
  add_comment: addComment,
  point_card: pointCard,
  mark_seen: markSeen,
};

/* ------------------------------ dispatch ------------------------------ */

function actorFields(actor: ActorCtx) {
  switch (actor.kind) {
    case 'human':
      return { actorKind: 'human' as const, actorId: actor.userId, turnId: null };
    case 'agent':
      return { actorKind: 'agent' as const, actorId: actor.agentId, turnId: actor.turnId ?? null };
    case 'room_agent':
      return { actorKind: 'room_agent' as const, actorId: actor.roomAgentId, turnId: actor.turnId ?? null };
    case 'system':
      return { actorKind: 'system' as const, actorId: null, turnId: null };
  }
}

/**
 * 권한 위반은 403(ForbiddenError), 존재하지 않는 Room·카드는 404, 낡은 버전은 409.
 * Agent 턴에서 호출하는 쪽(S8 runTurn)은 DomainError를 잡아 `agent_turn_ended{error}`를 기록한다.
 */
export function dispatch(ctx: AppContext, actor: ActorCtx, action: Action): DispatchResult {
  return ctx.db.tx(() => {
    const room = requireRoom(ctx, action.roomId);
    const handler = HANDLERS[action.type] as ActionHandler<Action>;

    // 직전에 서버 진실로 권한을 다시 계산한다. 클라이언트·Agent가 주장한 값은 쓰지 않는다.
    const subject = resolveSubject(ctx, room, actor);
    let caps: readonly Capability[] = [];
    if (actor.kind !== 'system') {
      if (!subject && !handler.allowOutsider) throw forbidden('not_in_room', '이 Room에 접근할 수 없습니다');
      if (subject) {
        caps = effectiveCapabilities(subject);
        if (handler.capability && !caps.includes(handler.capability)) {
          throw forbidden('missing_capability', `권한 없음: ${handler.capability}`);
        }
      }
    }

    const env: HandlerEnv = { ctx, actor, room, subject, caps };
    handler.authorize?.(env, action);
    const out = handler.apply(env, action);

    const fields = actorFields(actor);
    const systemFields = actorFields({ kind: 'system' });
    const events = out.events.map(({ roomId, asSystem, ...payload }) =>
      ctx.store.append({
        ...payload,
        roomId: roomId ?? room.id,
        ...(asSystem ? systemFields : fields),
      } as Parameters<typeof ctx.store.append>[0]),
    );
    handler.afterAppend?.(env, action, events);
    return { events, seq: events.length ? events[events.length - 1]!.seq : null, data: out.data ?? {} };
  });
}
