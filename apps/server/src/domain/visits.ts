import type { Capability, Mandate, VisitEndReason } from '@ensemble/shared';
import type { AppContext } from '../context';
import { notFound } from '../errors';
import { dispatch, type DispatchResult } from './actions';
import type { ActorCtx } from './rooms';

/**
 * 방문 흐름 (계획 5·6절). 모든 쓰기는 dispatch를 거친다.
 *
 *   requested ──accept──▶ active ──end──▶ ended
 *       └────decline────▶ declined
 *
 * - 요청은 호스트 Room과 DM Room(있으면) 양쪽에 `visit_requested`로 기록된다. 수락·거절·종료도 양쪽에 남는다.
 * - 사람 방문: 수락 이벤트의 seq가 start_seq이다. 방문자는 start_seq 이후의 호스트 Room 이벤트만, active인 동안만 본다.
 * - Agent 방문: 수락 시 `agent_departed`(출발 Room)·`agent_arrived`(호스트 Room)가 기록된다.
 *   방문 중 Agent의 턴·takeout·report는 S8·S10이 `endVisit`을 호출해 마무리한다.
 */

const hostRoomOf = (ctx: AppContext, visitId: string): string => {
  const v = ctx.repo.getVisit(visitId);
  if (!v) throw notFound('visit_not_found', '존재하지 않는 방문');
  return v.hostRoomId;
};

export interface VisitCreated extends DispatchResult {
  visitId: string;
}

export function requestHumanVisit(ctx: AppContext, userId: string, hostRoomId: string): VisitCreated {
  const r = dispatch(ctx, { kind: 'human', userId }, { type: 'request_visit', roomId: hostRoomId, kind: 'human' });
  return { ...r, visitId: r.data.visitId as string };
}

export function sendAgentVisit(ctx: AppContext, userId: string, hostRoomId: string, mandate: Mandate): VisitCreated {
  const r = dispatch(ctx, { kind: 'human', userId }, { type: 'request_visit', roomId: hostRoomId, kind: 'agent', mandate });
  return { ...r, visitId: r.data.visitId as string };
}

export function acceptVisit(ctx: AppContext, hostUserId: string, visitId: string, permissions: Capability[]): DispatchResult {
  return dispatch(ctx, { kind: 'human', userId: hostUserId }, {
    type: 'accept_visit',
    roomId: hostRoomOf(ctx, visitId),
    visitId,
    permissions,
  });
}

export function declineVisit(ctx: AppContext, hostUserId: string, visitId: string): DispatchResult {
  return dispatch(ctx, { kind: 'human', userId: hostUserId }, { type: 'decline_visit', roomId: hostRoomOf(ctx, visitId), visitId });
}

export interface EndVisitOptions {
  /** 생략하면 행위자로 정한다: 호스트 → host_ended, 방문자(또는 보낸 사람) → visitor_left, Agent → agent_ended */
  reason?: VisitEndReason;
  /** Agent 방문만: 호스트 Room에 공개되는 가지고 나오는 내용 */
  takeout?: string;
  /** Agent 방문만: 출발 Room에 소유자 private로 저장되는 보고 */
  report?: string;
}

/**
 * 방문 종료 (사람 방문 종료, Agent 방문의 end_visit·턴 상한·타임아웃 공용).
 * S8·S10의 Agent 런타임은 `endVisit(ctx, {kind:'agent', agentId}, visitId, {takeout, report})`로 호출한다.
 */
export function endVisit(ctx: AppContext, actor: ActorCtx, visitId: string, opts: EndVisitOptions = {}): DispatchResult {
  const v = ctx.repo.getVisit(visitId);
  if (!v) throw notFound('visit_not_found', '존재하지 않는 방문');
  const host = ctx.repo.getRoom(v.hostRoomId);
  let reason = opts.reason;
  if (!reason) {
    if (actor.kind === 'agent') reason = 'agent_ended';
    else if (actor.kind === 'human' && actor.userId === host?.ownerId) reason = 'host_ended';
    else reason = 'visitor_left';
  }
  return dispatch(ctx, actor, {
    type: 'end_visit',
    roomId: v.hostRoomId,
    visitId,
    reason,
    takeout: opts.takeout,
    report: opts.report,
  });
}
