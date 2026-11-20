import type { Mandate } from '@ensemble/shared';
import type { AppContext } from '../context';
import { DomainError } from '../errors';
import { dispatch, type DispatchResult } from './actions';
import { lastLeaveOf, roomStateOf } from './rooms';

/**
 * 영속 presence (member_entered / member_left / member_rejoined 이벤트). hub의 WS 구독 집합과는 별개다.
 *
 * 입장 규칙
 * - Room을 실제로 열었을 때 member_entered를 기록한다: WS 구독(자동) 또는 `POST /api/rooms/:id/enter`.
 * - 이미 있으면 아무것도 하지 않는다. 암묵적 퇴장 뒤 돌아오면 member_rejoined로 기록한다.
 * - 명시적 Leave 뒤에는 자동으로 돌아오지 않는다. Rejoin을 해야 한다(대리 참여가 조용히 끝나지 않게).
 * - DM과 방문자(사람 방문은 visit_accepted/visit_ended가 입퇴장이다)는 해당 없다.
 *
 * 암묵적 퇴장: 그 Room의 마지막 WS 구독이 끊긴 뒤 `implicitLeaveMs`(기본 30초)가 지나면
 * member_left{implicit:true}를 기록한다(mandate 없음 → Agent는 대리 참여하지 않는다). 재구독하면 타이머를 취소한다.
 */

export const DEFAULT_IMPLICIT_LEAVE_MS = 30_000;

export const enterRoom = (ctx: AppContext, userId: string, roomId: string): DispatchResult =>
  dispatch(ctx, { kind: 'human', userId }, { type: 'enter_room', roomId });

export const leaveRoom = (ctx: AppContext, userId: string, roomId: string, mandate?: Mandate): DispatchResult =>
  dispatch(ctx, { kind: 'human', userId }, { type: 'leave_room', roomId, mandate });

export const rejoinRoom = (ctx: AppContext, userId: string, roomId: string): DispatchResult =>
  dispatch(ctx, { kind: 'human', userId }, { type: 'rejoin_room', roomId });

export const viewDigest = (ctx: AppContext, userId: string, roomId: string): DispatchResult =>
  dispatch(ctx, { kind: 'human', userId }, { type: 'view_digest', roomId });

/** hub가 알려 주는 구독 변화. 같은 사용자의 소켓이 여러 개여도 첫 구독·마지막 해제에만 호출된다. */
export interface PresenceListener {
  onJoin(userId: string, roomId: string): void;
  onLeave(userId: string, roomId: string): void;
  dispose(): void;
}

export class PresenceManager implements PresenceListener {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly ctx: AppContext) {}

  private get delayMs(): number {
    return this.ctx.config.implicitLeaveMs ?? DEFAULT_IMPLICIT_LEAVE_MS;
  }
  private key = (userId: string, roomId: string) => `${userId}|${roomId}`;

  onJoin(userId: string, roomId: string): void {
    this.cancel(userId, roomId);
    try {
      this.autoEnter(userId, roomId);
    } catch (err) {
      if (!(err instanceof DomainError)) console.error('[presence] auto enter failed', err);
    }
  }

  onLeave(userId: string, roomId: string): void {
    this.cancel(userId, roomId);
    const t = setTimeout(() => {
      this.timers.delete(this.key(userId, roomId));
      this.implicitLeave(userId, roomId);
    }, this.delayMs);
    t.unref?.();
    this.timers.set(this.key(userId, roomId), t);
  }

  /** 대기 중인 타이머 수 (테스트용) */
  get pending(): number {
    return this.timers.size;
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private cancel(userId: string, roomId: string): void {
    const k = this.key(userId, roomId);
    const t = this.timers.get(k);
    if (t) {
      clearTimeout(t);
      this.timers.delete(k);
    }
  }

  /** 구독 시 자동 입장: 소유자·Our 구성원만. 방문자와 DM은 건너뛴다. */
  private autoEnter(userId: string, roomId: string): void {
    const { repo } = this.ctx;
    const room = repo.getRoom(roomId);
    if (!room || room.kind === 'dm') return;
    const isParticipant = room.kind === 'my' ? room.ownerId === userId : repo.isMember(roomId, userId);
    if (!isParticipant) return;
    const m = roomStateOf(this.ctx, roomId).members[userId];
    if (m?.present) return;
    if (m && !lastLeaveOf(this.ctx, roomId, userId)?.implicit) return; // 명시적 Leave: Rejoin을 기다린다
    enterRoom(this.ctx, userId, roomId);
  }

  private implicitLeave(userId: string, roomId: string): void {
    // 타이머가 도는 사이 재접속했다면(취소가 늦은 경우) 아무것도 하지 않는다.
    if (this.ctx.hub.connectedUserIds(roomId).includes(userId)) return;
    try {
      dispatch(this.ctx, { kind: 'system' }, { type: 'implicit_leave', roomId, userId });
    } catch (err) {
      console.error('[presence] implicit leave failed', err);
    }
  }
}
