import type { NamespaceContext } from '@ensemble/shared';
import type { AppContext } from '../context';
import { notFound } from '../errors';
import { roomStateOf } from '../domain/rooms';

/**
 * 이번 턴의 NamespaceContext를 서버 진실(Room 종류·소유자·이벤트 로그의 presence·방문 상태)로 만든다.
 * 호출자는 어떤 값도 주장할 수 없고 agentId·roomId만 넘긴다.
 * agentId는 Personal Agent id 또는 Room Agent id.
 */
export function namespaceContextFor(ctx: AppContext, agentId: string, roomId: string): NamespaceContext {
  const { repo } = ctx;
  const room = repo.getRoom(roomId);
  if (!room) throw notFound('room_not_found', '존재하지 않는 Room');

  const personal = repo.getAgent(agentId);
  const roomAgent = personal ? undefined : repo.getRoomAgent(agentId);
  if (!personal && !roomAgent) throw notFound('agent_not_found', '존재하지 않는 Agent');

  const state = roomStateOf(ctx, roomId);
  const visits = repo.listVisitsByHost(roomId).filter((v) => v.visitorKind === 'agent' && v.status === 'active');
  const visitorAgentIds = visits.map((v) => v.visitorAgentId).filter((x): x is string => !!x);
  const myVisit = personal ? visits.find((v) => v.visitorAgentId === personal.id) : undefined;

  return {
    agent: personal
      ? { kind: 'personal', agentId: personal.id, ownerId: personal.ownerId }
      : { kind: 'room_agent', roomAgentId: roomAgent!.id },
    room: { id: room.id, kind: room.kind, ownerId: room.ownerId },
    presentUserIds: state.presentUserIds,
    presentVisitorAgentIds: visitorAgentIds,
    visitId: myVisit?.id ?? null,
  };
}
