import { randomUUID } from 'node:crypto';
import {
  VISITING_AGENT_FORBIDDEN,
  VISITOR_GRANTABLE,
  isPrivateNamespace,
  parseNamespace,
  privateTo,
  writableNamespace,
  type RoomEvent,
  type Visibility,
} from '@ensemble/shared';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { namespaceContextFor } from '../memory/nsContext';
import type { Action, ActionHandler, EventDraft, HandlerEnv } from './actions';
import { requestTakeoutApproval } from './approvals';
import { lastLeaveOf, missedChangeCount, roomStateOf } from './rooms';

/**
 * presence · 방문 · 메모리 쓰기 핸들러. actions.ts의 HANDLERS에 합쳐진다.
 * 이 파일은 actions.ts를 타입으로만 참조한다(런타임 순환 없음).
 */

type A<K extends Action['type']> = Extract<Action, { type: K }>;

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

/* ------------------------------ presence ------------------------------ */

/** 사람 구성원(소유자 또는 Our 구성원)만 통과시키고 userId를 돌려준다. 방문자는 Visit 종료를 써야 한다. */
function presenceUser(env: HandlerEnv): string {
  const { actor, subject } = env;
  if (actor.kind !== 'human') throw forbidden('humans_only', '사람만 할 수 있습니다');
  if (!subject || subject.kind !== 'human') throw forbidden('not_in_room', '이 Room에 접근할 수 없습니다');
  if (subject.relation === 'visitor') throw forbidden('visitor_use_visit_end', '방문자는 방문 종료로 나갑니다');
  return actor.userId;
}

function memberStateOf(env: HandlerEnv, userId: string) {
  return roomStateOf(env.ctx, env.room.id).members[userId];
}

/** member_left의 seq를 left_at_seq에, 다이제스트가 필요 없는 재합류·digest_viewed는 해제로 반영한다. */
function presenceAfter(env: HandlerEnv, _a: Action, events: RoomEvent[]): void {
  for (const e of events) {
    if (e.roomId !== env.room.id) continue;
    if (e.type === 'member_left') env.ctx.repo.setLeftAt(e.userId, e.roomId, e.seq);
    else if (e.type === 'member_rejoined' && e.missedCount === 0) env.ctx.repo.setLeftAt(e.userId, e.roomId, null);
    else if (e.type === 'digest_viewed') env.ctx.repo.setLeftAt(e.userId, e.roomId, null);
  }
}

function rejoinEvents(env: HandlerEnv, userId: string, leftAtSeq: number | null): EventDraft[] {
  const missedCount = missedChangeCount(env.ctx, userId, env.room.id, leftAtSeq);
  return [{ type: 'member_rejoined', userId, missedCount }];
}

const enterRoom: ActionHandler<A<'enter_room'>> = {
  capability: null,
  authorize(env) {
    presenceUser(env);
  },
  apply(env) {
    if (env.room.kind === 'dm') return { events: [] }; // DM에는 입장·조명이 없다
    const userId = (env.actor as { userId: string }).userId;
    const m = memberStateOf(env, userId);
    if (m?.present) return { events: [] };
    if (m) {
      // 자리를 비운 상태: 암묵적 퇴장이었다면 돌아온 것으로 보고, 명시적 Leave였다면 Rejoin을 요구한다.
      const left = lastLeaveOf(env.ctx, env.room.id, userId);
      if (!left?.implicit) throw conflict('left_use_rejoin', 'Leave한 Room은 Rejoin으로 돌아와야 합니다');
      return { events: rejoinEvents(env, userId, m.leftAtSeq) };
    }
    return { events: [{ type: 'member_entered', userId, role: env.room.kind === 'my' ? 'owner' : 'member' }] };
  },
  afterAppend: presenceAfter,
};

const leaveRoom: ActionHandler<A<'leave_room'>> = {
  capability: null,
  authorize(env, a) {
    const userId = presenceUser(env);
    if (env.room.kind === 'dm') throw badRequest('no_presence_in_dm', 'DM에는 Leave가 없습니다');
    const m = memberStateOf(env, userId);
    if (m && !m.present) throw conflict('already_left', '이미 나간 Room입니다');
    if (a.mandate && !env.ctx.repo.getAgentByOwner(userId)) throw badRequest('no_agent', '대리 참여할 Agent가 없습니다');
  },
  apply(env, a) {
    const userId = (env.actor as { userId: string }).userId;
    const agent = a.mandate ? env.ctx.repo.getAgentByOwner(userId) : undefined;
    return {
      events: [
        {
          type: 'member_left',
          userId,
          implicit: false,
          ...(a.mandate && agent ? { mandate: a.mandate, agentId: agent.id } : {}),
        },
      ],
    };
  },
  afterAppend: presenceAfter,
};

const rejoinRoom: ActionHandler<A<'rejoin_room'>> = {
  capability: null,
  authorize(env) {
    const userId = presenceUser(env);
    const m = memberStateOf(env, userId);
    if (!m || m.present) throw conflict('not_away', '자리를 비운 상태가 아닙니다');
  },
  apply(env) {
    const userId = (env.actor as { userId: string }).userId;
    const m = memberStateOf(env, userId)!;
    return { events: rejoinEvents(env, userId, m.leftAtSeq) };
  },
  afterAppend: presenceAfter,
};

const viewDigest: ActionHandler<A<'view_digest'>> = {
  capability: null,
  authorize(env) {
    presenceUser(env);
  },
  apply(env) {
    const userId = (env.actor as { userId: string }).userId;
    if (!memberStateOf(env, userId)?.digestPending) return { events: [] };
    return { events: [{ type: 'digest_viewed', userId }] };
  },
  afterAppend: presenceAfter,
};

/** 구독이 끊긴 채 타이머가 지난 사용자의 암묵적 퇴장. system만 쓴다(mandate 없음 → Agent는 대리 참여하지 않는다). */
const implicitLeave: ActionHandler<A<'implicit_leave'>> = {
  capability: null,
  authorize(env) {
    if (env.actor.kind !== 'system') throw forbidden('system_only');
  },
  apply(env, a) {
    if (env.room.kind === 'dm') return { events: [] };
    const m = memberStateOf(env, a.userId);
    if (!m?.present) return { events: [] };
    return { events: [{ type: 'member_left', userId: a.userId, implicit: true }] };
  },
  afterAppend: presenceAfter,
};

/* ------------------------------ 방문 ------------------------------ */

function visitIn(env: HandlerEnv, visitId: string) {
  const v = env.ctx.repo.getVisit(visitId);
  if (!v || v.hostRoomId !== env.room.id) throw notFound('visit_not_found', '존재하지 않는 방문');
  return v;
}

function requireHost(env: HandlerEnv): string {
  const { actor, subject } = env;
  if (actor.kind !== 'human') throw forbidden('humans_only', '사람만 할 수 있습니다');
  if (!subject || subject.kind !== 'human' || subject.relation !== 'owner') throw forbidden('not_host', '호스트만 할 수 있습니다');
  return actor.userId;
}

const dmMirror = (dmRoomId: string | null, ev: EventDraft): EventDraft[] => (dmRoomId ? [{ ...ev, roomId: dmRoomId }] : []);

const requestVisit: ActionHandler<A<'request_visit'>> = {
  capability: null,
  allowOutsider: true,
  authorize(env, a) {
    const { actor, room, ctx } = env;
    if (actor.kind !== 'human') throw forbidden('humans_only', '사람만 요청할 수 있습니다');
    if (room.kind !== 'my' || !room.ownerId) throw badRequest('not_a_my_room', 'My Room에만 방문할 수 있습니다');
    if (room.ownerId === actor.userId) throw badRequest('cannot_visit_self', '내 Room에는 방문하지 않습니다');
    if (a.kind === 'human') {
      if (ctx.repo.findOpenHumanVisit(actor.userId, room.id)) throw conflict('visit_exists', '이미 요청했거나 방문 중입니다');
      return;
    }
    const agent = ctx.repo.getAgentByOwner(actor.userId);
    if (!agent) throw badRequest('no_agent', '보낼 Agent가 없습니다');
    if (!a.mandate) throw badRequest('mandate_required', 'Agent를 보내려면 위임 범위가 필요합니다');
    if (a.mandate.allowedActions.some((c) => VISITING_AGENT_FORBIDDEN.includes(c))) {
      throw badRequest('forbidden_mandate_action', '방문 Agent에게는 보드 편집·기억 저장을 위임할 수 없습니다');
    }
    if (ctx.repo.findOpenAgentVisit(agent.id)) throw conflict('agent_busy', '이 Agent는 이미 방문 중이거나 요청 중입니다');
  },
  apply(env, a) {
    const { actor, room, ctx } = env;
    const userId = (actor as { userId: string }).userId;
    const agent = a.kind === 'agent' ? ctx.repo.getAgentByOwner(userId) : undefined;
    const dm = ctx.repo.findDmRoom(userId, room.ownerId!);
    const visitId = newId('visit');
    ctx.repo.insertVisit({
      id: visitId,
      hostRoomId: room.id,
      visitorKind: a.kind,
      visitorUserId: userId,
      visitorAgentId: agent?.id ?? null,
      mandate: a.kind === 'agent' ? (a.mandate ?? null) : null,
      requestedInDmRoomId: dm?.id ?? null,
    });
    const ev: EventDraft = {
      type: 'visit_requested',
      visitId,
      visitorKind: a.kind,
      visitorUserId: userId,
      ...(agent ? { visitorAgentId: agent.id } : {}),
      ...(a.kind === 'agent' && a.mandate ? { mandate: a.mandate } : {}),
    };
    return { events: [ev, ...dmMirror(dm?.id ?? null, ev)], data: { visitId } };
  },
};

const acceptVisit: ActionHandler<A<'accept_visit'>> = {
  capability: null,
  authorize(env, a) {
    requireHost(env);
    const v = visitIn(env, a.visitId);
    if (v.status !== 'requested') throw conflict('visit_not_pending', '대기 중인 요청이 아닙니다');
    if (v.visitorKind === 'human') {
      if (!a.permissions.every((c) => VISITOR_GRANTABLE.includes(c))) {
        throw badRequest('permission_not_grantable', '방문자에게는 chat·comment·propose_edit만 줄 수 있습니다');
      }
    } else if (a.permissions.some((c) => VISITING_AGENT_FORBIDDEN.includes(c))) {
      throw badRequest('permission_not_grantable', '방문 Agent에게는 edit_board·remember를 줄 수 없습니다');
    }
  },
  apply(env, a) {
    const { ctx, room } = env;
    const v = visitIn(env, a.visitId);
    const permissions = [...new Set(a.permissions)];
    ctx.repo.setVisitState(v.id, 'active', permissions);
    const ev: EventDraft = { type: 'visit_accepted', visitId: v.id, permissions };
    const events: EventDraft[] = [ev, ...dmMirror(v.requestedInDmRoomId, ev)];
    if (v.visitorKind === 'agent' && v.visitorAgentId) {
      const home = ctx.repo.getMyRoomByOwner(v.visitorUserId);
      if (home) {
        events.push({ type: 'agent_departed', agentId: v.visitorAgentId, visitId: v.id, toRoomId: room.id, roomId: home.id, asSystem: true });
        events.push({ type: 'agent_arrived', agentId: v.visitorAgentId, visitId: v.id, fromRoomId: home.id, asSystem: true });
      }
    }
    return { events };
  },
  /** 수락 이벤트의 seq가 방문자 가시성의 시작점(start_seq)이다. */
  afterAppend(env, a, events) {
    const accepted = events.find((e) => e.type === 'visit_accepted' && e.roomId === env.room.id);
    if (accepted) env.ctx.repo.setVisitStartSeq(a.visitId, accepted.seq);
  },
};

const declineVisit: ActionHandler<A<'decline_visit'>> = {
  capability: null,
  authorize(env, a) {
    requireHost(env);
    if (visitIn(env, a.visitId).status !== 'requested') throw conflict('visit_not_pending', '대기 중인 요청이 아닙니다');
  },
  apply(env, a) {
    const v = visitIn(env, a.visitId);
    env.ctx.repo.setVisitState(v.id, 'declined');
    const ev: EventDraft = { type: 'visit_declined', visitId: v.id };
    return { events: [ev, ...dmMirror(v.requestedInDmRoomId, ev)] };
  },
  afterAppend(env, a, events) {
    const e = events.find((x) => x.type === 'visit_declined' && x.roomId === env.room.id);
    if (e) env.ctx.repo.setVisitEndSeq(a.visitId, e.seq);
  },
};

const AGENT_END_REASONS: readonly string[] = ['agent_ended', 'turn_limit', 'timeout'];

const endVisit: ActionHandler<A<'end_visit'>> = {
  capability: null,
  allowOutsider: true,
  authorize(env, a) {
    const { actor, room } = env;
    const v = visitIn(env, a.visitId);
    if (v.status !== 'active') throw conflict('visit_not_active', '진행 중인 방문이 아닙니다');
    switch (actor.kind) {
      case 'system':
        break;
      case 'human':
        if (actor.userId === room.ownerId) {
          if (a.reason !== 'host_ended') throw badRequest('invalid_reason', '호스트의 종료 사유는 host_ended입니다');
        } else if (actor.userId === v.visitorUserId) {
          if (a.reason !== 'visitor_left') throw badRequest('invalid_reason', '방문자의 종료 사유는 visitor_left입니다');
        } else throw forbidden('not_your_visit', '이 방문을 끝낼 수 없습니다');
        break;
      case 'agent':
        if (v.visitorKind !== 'agent' || actor.agentId !== v.visitorAgentId) throw forbidden('not_your_visit', '이 방문을 끝낼 수 없습니다');
        if (!AGENT_END_REASONS.includes(a.reason)) throw badRequest('invalid_reason', 'Agent의 종료 사유가 올바르지 않습니다');
        break;
      default:
        throw forbidden('not_your_visit', '이 방문을 끝낼 수 없습니다');
    }
    if ((a.takeout || a.report) && v.visitorKind !== 'agent') {
      throw badRequest('takeout_only_agent_visit', 'takeout·보고는 Agent 방문에만 있습니다');
    }
  },
  apply(env, a) {
    const { ctx } = env;
    const v = visitIn(env, a.visitId);
    ctx.repo.setVisitState(v.id, 'ended');
    const events: EventDraft[] = [];
    // 방문 후 가지고 나오는 것은 공개 takeout뿐이다(계획 7절). 호스트 Room에 공개 기록된다.
    if (a.takeout?.trim()) {
      events.push({ type: 'visit_takeout', visitId: v.id, text: a.takeout.trim() });
      // 소유자 쪽으로 가져가는 것은 호스트가 승인한 범위뿐이다: 승인 요청(kind takeout)으로 올린다.
      if (v.visitorKind === 'agent') events.push(...requestTakeoutApproval(env, v, a.takeout.trim()));
    }
    const ended: EventDraft = { type: 'visit_ended', visitId: v.id, reason: a.reason };
    events.push(ended, ...dmMirror(v.requestedInDmRoomId, ended));
    if (v.visitorKind === 'agent' && v.visitorAgentId) {
      const home = ctx.repo.getMyRoomByOwner(v.visitorUserId);
      if (home) {
        events.push({ type: 'agent_returned', agentId: v.visitorAgentId, visitId: v.id, roomId: home.id, asSystem: true });
        if (a.report?.trim()) {
          // 출발 Room에 소유자만 보는 보고로 저장한다. 소유자가 원하면 private 기억으로 승격한다(S10).
          events.push({
            type: 'visit_report',
            visitId: v.id,
            summary: a.report.trim(),
            roomId: home.id,
            asSystem: true,
            visibility: privateTo(v.visitorUserId),
          });
        }
      }
    }
    return { events };
  },
  afterAppend(env, a, events) {
    const e = events.find((x) => x.type === 'visit_ended' && x.roomId === env.room.id);
    if (e) env.ctx.repo.setVisitEndSeq(a.visitId, e.seq);
  },
};

/* ------------------------------ 메모리 ------------------------------ */

/**
 * 기억 저장. ns는 호출자가 정할 수 없다: Agent는 gateway가 계산한 `writableNamespace`와 같아야 하고,
 * 사람은 자기 Agent의 private·for:Room뿐이며, system은 그 Room의 room ns뿐이다. 여기서 한 번 더 서버 진실로 검증한다.
 */
const retainMemory: ActionHandler<A<'retain_memory'>> = {
  capability: null,
  authorize(env, a) {
    const { ctx, actor, room } = env;
    if (!a.text.trim()) throw badRequest('empty_text');
    const p = parseNamespace(a.ns);
    if (!p) throw badRequest('invalid_namespace');
    switch (actor.kind) {
      case 'agent': {
        if (!env.caps.includes('remember')) throw forbidden('missing_capability', '권한 없음: remember');
        const ns = writableNamespace(namespaceContextFor(ctx, actor.agentId, room.id));
        if (ns === null || ns !== a.ns) throw forbidden('namespace_not_writable', '이 상황에서 쓸 수 없는 기억 공간입니다');
        break;
      }
      case 'human': {
        if (p.kind !== 'private' && p.kind !== 'for') throw forbidden('namespace_not_writable', '개인 기억만 직접 쓸 수 있습니다');
        const agent = ctx.repo.getAgent(p.agentId);
        if (!agent || agent.ownerId !== actor.userId) throw forbidden('not_your_memory', '내 Agent의 기억이 아닙니다');
        if (p.kind === 'for') {
          if (room.id !== p.roomId || room.kind !== 'our' || !ctx.repo.isMember(room.id, actor.userId)) {
            throw forbidden('namespace_not_writable', '내가 속한 Our Room에만 공유할 수 있습니다');
          }
        } else if (room.kind !== 'my' || room.ownerId !== actor.userId) {
          throw badRequest('wrong_room', 'private 기억은 내 Room에 기록합니다');
        }
        break;
      }
      case 'system':
        if (p.kind !== 'room' || p.roomId !== room.id) throw forbidden('namespace_not_writable');
        break;
      default:
        throw forbidden('namespace_not_writable', 'Room Agent는 기억을 직접 쓰지 않습니다');
    }
  },
  apply(env, a) {
    const { ctx, actor, room } = env;
    const p = parseNamespace(a.ns)!;
    const createdBy = actor.kind === 'human' ? actor.userId : actor.kind === 'agent' ? actor.agentId : 'system';
    const sourceRoomId =
      a.sourceRoomId !== undefined ? a.sourceRoomId : actor.kind === 'human' && p.kind === 'private' ? null : room.id;
    const item = ctx.memory.commit(a.ns, { kind: a.kind, text: a.text.trim(), sourceRoomId, createdBy });
    let visibility: Visibility = 'room';
    if (isPrivateNamespace(a.ns) && (p.kind === 'private' || p.kind === 'for')) {
      const owner = ctx.repo.getAgent(p.agentId)?.ownerId;
      if (owner) visibility = privateTo(owner);
    }
    return { events: [{ type: 'memory_retained', itemId: item.id, ns: a.ns, kind: a.kind, visibility }], data: { itemId: item.id } };
  },
};

export const LIFECYCLE_HANDLERS: {
  enter_room: ActionHandler<A<'enter_room'>>;
  leave_room: ActionHandler<A<'leave_room'>>;
  rejoin_room: ActionHandler<A<'rejoin_room'>>;
  view_digest: ActionHandler<A<'view_digest'>>;
  implicit_leave: ActionHandler<A<'implicit_leave'>>;
  request_visit: ActionHandler<A<'request_visit'>>;
  accept_visit: ActionHandler<A<'accept_visit'>>;
  decline_visit: ActionHandler<A<'decline_visit'>>;
  end_visit: ActionHandler<A<'end_visit'>>;
  retain_memory: ActionHandler<A<'retain_memory'>>;
} = {
  enter_room: enterRoom,
  leave_room: leaveRoom,
  rejoin_room: rejoinRoom,
  view_digest: viewDigest,
  implicit_leave: implicitLeave,
  request_visit: requestVisit,
  accept_visit: acceptVisit,
  decline_visit: declineVisit,
  end_visit: endVisit,
  retain_memory: retainMemory,
};
