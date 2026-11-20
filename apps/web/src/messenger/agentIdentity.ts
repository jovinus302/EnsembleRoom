import { PALETTE, type AgentDto, type RoomEvent, type UserDto } from '@ensemble/shared';

/** 색 규칙(계획 8.3): Personal Agent = 소유자 색, Room Agent = 라임 고정, 시스템 = 민트, 모르면 중립 회색 */
export const FALLBACK_COLOR = '#a0aec4';
export const ROOM_AGENT_COLOR = PALETTE.roomAgentLime;
export const SYSTEM_COLOR = PALETTE.agentMint;

export interface AgentIdentity {
  name: string;
  color: string;
  kind: 'agent' | 'room_agent';
  variant: string | null;
  ownerId: string | null;
}

export type AgentResolver = (agentId: string | null | undefined, hint?: 'agent' | 'room_agent') => AgentIdentity;

/**
 * Agent id → 표시 정보. snapshot.agents(상주 Agent + 진행 중/종료된 방문 Agent)를 우선한다.
 * 스냅샷에 아직 없는 Agent(방문 직후 갱신 전)만 방문 이벤트(visitorAgentId → visitorUserId)로 소유자를 추정한다.
 */
export function makeAgentResolver(
  users: Record<string, UserDto>,
  agents: readonly AgentDto[],
  events: readonly RoomEvent[],
  me?: { agent: AgentDto | null },
): AgentResolver {
  const visitorOwner = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'visit_requested' && e.visitorAgentId) visitorOwner.set(e.visitorAgentId, e.visitorUserId);
  }
  return (agentId, hint) => {
    const a = agents.find((x) => x.id === agentId) ?? (me?.agent && me.agent.id === agentId ? me.agent : undefined);
    if (hint === 'room_agent' || a?.kind === 'room') {
      return { name: a?.name ?? 'Room Agent', color: ROOM_AGENT_COLOR, kind: 'room_agent', variant: a?.variant ?? null, ownerId: null };
    }
    const ownerId = a?.ownerId ?? (agentId ? visitorOwner.get(agentId) : undefined) ?? null;
    const owner = ownerId ? users[ownerId] : undefined;
    return {
      name: a?.name ?? (owner ? `${owner.name}의 Agent` : 'Agent'),
      color: owner?.color ?? FALLBACK_COLOR,
      kind: 'agent',
      variant: a?.variant ?? null,
      ownerId,
    };
  };
}
