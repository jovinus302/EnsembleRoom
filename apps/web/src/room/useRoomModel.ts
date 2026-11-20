import { useMemo } from 'react';
import {
  buildAgentStates,
  buildRoomState,
  roomAmbience,
  type AgentDto,
  type AgentRef,
  type AgentVisualState,
  type RoomAmbience,
  type RoomEvent,
  type RoomState,
  type UserDto,
  type WorldRoom,
} from '@ensemble/shared';
import { makeAgentResolver, type AgentResolver } from '../messenger/agentIdentity';
import { useRooms } from '../store/roomStore';
import { useSession } from '../store/session';
import { useWorld } from '../store/worldStore';

const NO_EVENTS: RoomEvent[] = [];
const NO_AGENTS: AgentDto[] = [];
const NO_PRESENCE: string[] = [];

export interface RoomAgentRow {
  agentId: string;
  name: string;
  color: string;
  variant: string | null;
  kind: 'agent' | 'room_agent';
  ownerId: string | null;
  /** 이 Room 로그에서 재구성한 상태 (replaySeq 반영) */
  state: AgentVisualState;
  /** 다른 Room에서 방문 온 Agent */
  visiting: boolean;
}

/**
 * Room 한 곳의 "표시 모델". 이벤트 로그 하나를 `replaySeq`까지 리듀싱한 결과다.
 *
 * 2D 패널(보드, 승인, 작업 과정, Agent 상태)과 이후 3D 월드(S15~S19)가 같은 모델을 읽는다.
 * 그래서 타임라인을 되감으면 DOM과 3D(조명 단계, 유리 투명도, Agent 상태)가 함께 과거로 돌아간다.
 * 3D 쪽은 이 모델을 읽기만 하고 서버를 직접 부르지 않는다.
 */
export interface RoomModel {
  roomId: string;
  room: WorldRoom;
  meId: string;
  users: Record<string, UserDto>;
  loaded: boolean;
  /** 보이는 이벤트 전체 (재생 중이라도 자르지 않음) */
  allEvents: readonly RoomEvent[];
  /** replaySeq까지의 이벤트 */
  events: readonly RoomEvent[];
  lastSeq: number;
  /** null = 지금(라이브), 숫자 = 그 seq 시점을 재생 중 */
  replaySeq: number | null;
  replaying: boolean;
  state: RoomState;
  ambience: RoomAmbience;
  agents: RoomAgentRow[];
  resolveAgent: AgentResolver;
  /** WS presence */
  presence: readonly string[];
}

export function useRoomModel(roomId: string, replaySeq: number | null): RoomModel | null {
  const meId = useSession((s) => s.user!.id);
  const meAgent = useSession((s) => s.agent);
  const users = useWorld((s) => s.users);
  const room = useWorld((s) => s.rooms[roomId]);
  const slice = useRooms((s) => s.rooms[roomId]);
  const allEvents = slice?.events ?? NO_EVENTS;
  const agentDtos = slice?.agents ?? NO_AGENTS;
  const presence = slice?.presence ?? NO_PRESENCE;
  const lastSeq = slice?.lastSeq ?? 0;
  const loaded = slice?.snapshotLoaded ?? false;

  const upTo = replaySeq ?? undefined;
  const events = useMemo(
    () => (replaySeq === null ? allEvents : allEvents.filter((e) => e.seq <= replaySeq)),
    [allEvents, replaySeq],
  );
  const state = useMemo(() => buildRoomState(roomId, allEvents, upTo), [roomId, allEvents, upTo]);
  const ambience = useMemo(() => roomAmbience(state), [state]);
  const resolveAgent = useMemo(
    () => makeAgentResolver(users, agentDtos, allEvents, { agent: meAgent }),
    [users, agentDtos, allEvents, meAgent],
  );

  const agents = useMemo<RoomAgentRow[]>(() => {
    const refs: AgentRef[] = agentDtos.map((a) => ({ agentId: a.id, ownerUserId: a.ownerId, homeRoomId: roomId }));
    const visiting = new Set<string>();
    for (const v of Object.values(state.visits)) {
      if (v.visitorKind === 'agent' && v.visitorAgentId && !refs.some((r) => r.agentId === v.visitorAgentId)) {
        refs.push({ agentId: v.visitorAgentId, ownerUserId: v.visitorUserId, homeRoomId: null });
        visiting.add(v.visitorAgentId);
      }
    }
    const states = buildAgentStates(refs, allEvents, upTo);
    return refs.map((r) => {
      const id = resolveAgent(r.agentId, r.ownerUserId === null ? 'room_agent' : 'agent');
      return {
        agentId: r.agentId,
        name: id.name,
        color: id.color,
        variant: id.variant,
        kind: id.kind,
        ownerId: id.ownerId,
        state: states[r.agentId]!,
        visiting: visiting.has(r.agentId),
      };
    });
  }, [agentDtos, allEvents, upTo, roomId, state.visits, resolveAgent]);

  return useMemo<RoomModel | null>(() => {
    if (!room) return null;
    return {
      roomId,
      room,
      meId,
      users,
      loaded,
      allEvents,
      events,
      lastSeq,
      replaySeq,
      replaying: replaySeq !== null,
      state,
      ambience,
      agents,
      resolveAgent,
      presence,
    };
  }, [room, roomId, meId, users, loaded, allEvents, events, lastSeq, replaySeq, state, ambience, agents, resolveAgent, presence]);
}
