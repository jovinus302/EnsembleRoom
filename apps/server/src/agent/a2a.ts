import type { RoomState } from '@ensemble/shared';
import type { AppContext } from '../context';
import { A2A_DEFAULTS } from '../config';
import { lastLeaveOf, resolveSubject, roomStateOf } from '../domain/rooms';
import type { AskableAgent } from './types';

/**
 * A2A(Agent↔Agent) 질문 규칙. 스케줄러·도구·컨텍스트가 함께 쓴다.
 *  - ask_agents는 Our Room에서, 지금 자리에 없는 구성원의 Personal Agent에게만 물을 수 있다.
 *  - Room Agent와 방문 중인 Agent는 대상이 아니다(MVP). 접속 중인 사람에게는 say로 직접 묻는다.
 */

export { A2A_DEFAULTS };

export interface A2ALimits {
  on: boolean;
  maxRounds: number;
  fanoutMax: number;
  maxTurnsPerEpisode: number;
  maxTurnsPerHumanEvent: number;
  maxTurnsPerResolution: number;
}

export function a2aLimitsOf(ctx: AppContext): A2ALimits {
  const c = ctx.config;
  return {
    on: c.agentA2A ?? true,
    maxRounds: c.a2aMaxRounds ?? A2A_DEFAULTS.maxRounds,
    fanoutMax: c.a2aFanoutMax ?? A2A_DEFAULTS.fanoutMax,
    maxTurnsPerEpisode: c.a2aMaxTurnsPerEpisode ?? A2A_DEFAULTS.maxTurnsPerEpisode,
    maxTurnsPerHumanEvent: c.a2aMaxTurnsPerHumanEvent ?? A2A_DEFAULTS.maxTurnsPerHumanEvent,
    maxTurnsPerResolution: c.a2aMaxTurnsPerResolution ?? A2A_DEFAULTS.maxTurnsPerResolution,
  };
}

/**
 * 자동 대리 대상인가: 지금 이 Room에 접속(present)하지 않았고 명시적 Leave도 하지 않은 구성원.
 * 한 번도 들어온 적 없거나 암묵적 퇴장(구독 끊김)만 한 사람이다. 명시적 Leave(위임 있든 없든)는 해당하지 않는다.
 */
export function isAutoAway(ctx: AppContext, roomId: string, userId: string, state: RoomState): boolean {
  const m = state.members[userId];
  if (m?.present || state.presentUserIds.includes(userId)) return false;
  if (!m) return true;
  return !m.mandate && lastLeaveOf(ctx, roomId, userId)?.implicit === true;
}

/** 이 Agent가 지금 이 Room에서 턴을 돌 수 있는가 (다른 방 방문 중이 아니고 Room 접근 가능) */
function runnableHere(ctx: AppContext, roomId: string, agentId: string): boolean {
  const { repo } = ctx;
  const room = repo.getRoom(roomId);
  if (!room || room.kind === 'dm') return false;
  if (!repo.getAgent(agentId)) return false;
  const open = repo.findOpenAgentVisit(agentId);
  if (open?.status === 'active' && open.hostRoomId !== roomId) return false;
  return resolveSubject(ctx, room, { kind: 'agent', agentId }) !== null;
}

/**
 * 물어볼 수 있는 Agent (구성원 순서). 질문자(Personal Agent)의 소유자는 뺀다.
 * 구성원의 Agent가 모두 만족해야 한다:
 *  - 소유자가 지금 present가 아니다: auto-away이거나 위임 있는 Leave(representing). 위임 없이 명시적 Leave한 경우는 제외
 *  - 다른 방을 방문 중이 아니다 / runnable이다
 */
export function askableAgents(ctx: AppContext, roomId: string, askerAgentId: string, state?: RoomState): AskableAgent[] {
  const { repo } = ctx;
  const room = repo.getRoom(roomId);
  if (!room || room.kind !== 'our') return [];
  const askerOwner = repo.getAgent(askerAgentId)?.ownerId ?? null;
  const st = state ?? roomStateOf(ctx, roomId);
  const out: AskableAgent[] = [];
  for (const uid of repo.memberIds(roomId)) {
    if (uid === askerOwner) continue;
    const m = st.members[uid];
    if (m?.present || st.presentUserIds.includes(uid)) continue;
    const away = isAutoAway(ctx, roomId, uid, st) || !!m?.mandate;
    if (!away) continue;
    const agent = repo.getAgentByOwner(uid);
    if (!agent || agent.id === askerAgentId) continue;
    if (!runnableHere(ctx, roomId, agent.id)) continue;
    out.push({ id: agent.id, name: agent.name, ownerId: uid, ownerName: repo.getUser(uid)?.name ?? uid });
  }
  return out;
}
