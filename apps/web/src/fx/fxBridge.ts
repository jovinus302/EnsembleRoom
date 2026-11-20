import type { RoomEvent, RoomPreview } from '@ensemble/shared';
import { useSession } from '../store/session';
import { useWorld } from '../store/worldStore';
import { emit } from './fxStore';

/**
 * 서버 확정 사건 → fxStore.emit. ws.ts가 부른다. 스냅샷·재접속 따라잡기는 이 경로를 타지 않으므로
 * 과거 이벤트가 한꺼번에 터지지 않는다(WS로 막 도착한 라이브 이벤트만 연출된다).
 */

const charId = (kind: string, id: string | null): string | null => (id ? (kind === 'human' ? `h:${id}` : id) : null);

function userColor(id: string): string | undefined {
  return useWorld.getState().users[id]?.color;
}

function myRoomOf(userId: string): string | null {
  for (const r of Object.values(useWorld.getState().rooms)) if (r.kind === 'my' && r.ownerId === userId) return r.id;
  return null;
}

/** 내가 주인(My)이거나 구성원(Our)인 Room: 내게는 유리가 늘 맑다 */
function isMemberRoom(room: { kind: string; ownerId?: string | null; memberIds: string[] } | undefined, me: string | null): boolean {
  if (!room || !me) return false;
  return room.kind === 'my' ? room.ownerId === me : room.memberIds.includes(me);
}

export function fxFromRoomEvent(e: RoomEvent): void {
  const me = useSession.getState().user?.id ?? null;
  const rooms = useWorld.getState().rooms;
  const room = rooms[e.roomId];
  const actor = charId(e.actorKind, e.actorId);
  const mine = e.actorKind === 'human' && e.actorId === me;
  switch (e.type) {
    case 'message':
      // 내가 보낸 것은 send_local이 같은 clientId로 이미 재생했다(key 중복 제거)
      emit('message', {
        roomId: e.roomId,
        actorId: actor,
        targetId: e.to ? (rooms[e.roomId]?.memberIds.includes(e.to) ? `h:${e.to}` : e.to) : null,
        key: e.clientId ?? `m${e.roomId}:${e.seq}`,
        mine,
        color: e.actorId ? userColor(e.actorId) : undefined,
      });
      break;
    case 'agent_turn_started':
      emit('agent_called', { roomId: e.roomId, actorId: actor, key: `call:${e.turnId ?? e.seq}`, mine });
      break;
    case 'approval_requested':
      emit('approval_requested', { roomId: e.roomId, actorId: actor, key: `ap:${e.roomId}`, involvesMe: !!me && e.approvers.includes(me), text: e.summary });
      break;
    case 'approval_resolved':
      emit('approval_resolved', { roomId: e.roomId, outcome: e.outcome, key: `apr:${e.approvalId}`, mine });
      break;
    case 'agreement_formed':
      emit('agreement', {
        roomId: e.roomId,
        colors: e.memberIds.map((m) => userColor(m)).filter((c): c is string => !!c),
        key: `agree:${e.cardId}`,
        involvesMe: !!me && e.memberIds.includes(me),
      });
      break;
    case 'memory_retained':
      emit('memory', { roomId: e.roomId, actorId: actor, key: `mem:${e.itemId}`, mine });
      break;
    case 'visit_requested': {
      if (room?.kind === 'dm') break; // 같은 요청이 호스트 Room에도 기록된다
      const from = myRoomOf(e.visitorUserId);
      emit('visit_request', { roomId: e.roomId, fromRoomId: from, toRoomId: e.roomId, color: userColor(e.visitorUserId), key: `vr:${e.visitId}`, mine: e.visitorUserId === me });
      break;
    }
    case 'visit_accepted':
      if (room?.kind === 'dm' || isMemberRoom(room, me)) break; // 내 Room의 유리는 맑은 채 그대로라 서리 와이프(흰 띠)가 지나가면 번쩍임일 뿐이다
      emit('visit_accept', { roomId: e.roomId, toRoomId: e.roomId, key: `glass:${e.roomId}:clear` });
      break;
    case 'visit_ended':
      if (room?.kind === 'dm' || isMemberRoom(room, me)) break;
      emit('visit_end', { roomId: e.roomId, key: `glass:${e.roomId}:frosted` });
      break;
    case 'member_left': {
      emit('leave', {
        roomId: e.roomId,
        actorId: `h:${e.userId}`,
        targetId: e.agentId ?? null,
        color: userColor(e.userId),
        key: `left:${e.roomId}:${e.userId}:${e.seq}`,
        mine: e.userId === me,
      });
      break;
    }
    case 'member_rejoined':
      emit('rejoin', { roomId: e.roomId, actorId: `h:${e.userId}`, color: userColor(e.userId), count: e.missedCount, key: `rejoin:${e.roomId}:${e.userId}:${e.seq}`, mine: e.userId === me });
      break;
    case 'agent_departed':
      emit('agent_depart', { roomId: e.roomId, actorId: e.agentId, fromRoomId: e.roomId, toRoomId: e.toRoomId, key: `dep:${e.visitId}`, mine });
      break;
    case 'agent_arrived':
      emit('agent_arrive', { roomId: e.roomId, actorId: e.agentId, fromRoomId: e.fromRoomId, toRoomId: e.roomId, key: `arr:${e.visitId}`, mine });
      break;
    case 'agent_returned':
      emit('agent_return', { roomId: e.roomId, actorId: e.agentId, key: `ret:${e.visitId}`, mine });
      break;
    case 'agent_paused':
      emit('agent_paused', { roomId: e.roomId, actorId: e.agentId, key: `pause:${e.roomId}:${e.seq}` });
      break;
    default:
      break;
  }
}

/** 구독하지 않은 Room의 변화는 world_preview로만 온다: 유리(방문 수락·종료)·승인 대기·안 읽음 증가를 감지한다 */
export function fxFromPreviewChange(prev: RoomPreview | undefined, next: RoomPreview): void {
  if (!prev) return;
  const roomId = next.roomId;
  // 서리가 걷히거나(frosted→clear/agent) 다시 끼는(→frosted) 전환만 와이프 연출. clear↔agent는 같은 방문 안의 농도 변화라 연출을 새로 내지 않는다
  if (prev.glass !== next.glass && (prev.glass === 'frosted') !== (next.glass === 'frosted')) {
    emit(next.glass === 'frosted' ? 'visit_end' : 'visit_accept', { roomId, toRoomId: roomId, key: `glass:${roomId}:${next.glass === 'frosted' ? 'frosted' : 'clear'}` });
  }
  const pa = prev.detail?.pendingApprovals ?? 0;
  const na = next.detail?.pendingApprovals ?? 0;
  if (na > pa) emit('approval_requested', { roomId, key: `ap:${roomId}`, involvesMe: true });
  else if (na < pa) emit('approval_resolved', { roomId, outcome: 'approved', key: `apr:${roomId}:${na}` });
  const pu = prev.detail?.unread ?? 0;
  const nu = next.detail?.unread ?? 0;
  if (nu > pu) emit('message', { roomId, actorId: null, key: `unread:${roomId}:${nu}` });
}
