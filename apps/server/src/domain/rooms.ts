import {
  AGENT_ACTIVITIES,
  buildAgentStates,
  buildRoomState,
  glassClarity,
  indexInteractions,
  pendingApprovalsFor,
  pickPreviewInteraction,
  roomAmbience,
  type AgentChip,
  type AgentTravel,
  type AgentDto,
  type AgentRef,
  type AgentActivity,
  type AgentMode,
  type MyAgentStatus,
  type PermissionSubject,
  type RoomEvent,
  type RoomState,
  type RoomPreview,
  type RoomSnapshot,
  type WorldResponse,
  type WorldRoom,
} from '@ensemble/shared';
import type { AppContext } from '../context';
import { Repo, type RoomRow, type VisitRow } from '../db/repo';
import { forbidden, notFound } from '../errors';

/** 행위자. 사람과 Agent가 같은 dispatch를 쓴다. system은 권한 검사를 건너뛴다(시드·서버 내부). */
export type ActorCtx =
  | { kind: 'human'; userId: string }
  | { kind: 'agent'; agentId: string; turnId?: string | null }
  | { kind: 'room_agent'; roomAgentId: string; turnId?: string | null }
  | { kind: 'system' };

export function requireRoom(ctx: AppContext, roomId: string): RoomRow {
  const room = ctx.repo.getRoom(roomId);
  if (!room) throw notFound('room_not_found', '존재하지 않는 Room');
  return room;
}

/**
 * 행위자의 PermissionSubject를 서버 진실(DB + 이벤트 로그)로 계산한다. null이면 이 Room에 접근할 수 없다.
 * 권한 표(계획 6절)는 shared의 effectiveCapabilities가 계산하고, 여기서는 "누구인가"만 판정한다.
 */
export function resolveSubject(ctx: AppContext, room: RoomRow, actor: ActorCtx): PermissionSubject | null {
  const { repo } = ctx;
  switch (actor.kind) {
    case 'system':
      return null;

    case 'human': {
      if (room.kind === 'my') {
        if (room.ownerId === actor.userId) return { kind: 'human', relation: 'owner', roomKind: 'my' };
        const visit = repo
          .listVisitsByHost(room.id)
          .find((v) => v.visitorKind === 'human' && v.visitorUserId === actor.userId && v.status === 'active');
        return visit
          ? { kind: 'human', relation: 'visitor', visit: { status: visit.status, permissions: visit.permissions } }
          : null;
      }
      return repo.isMember(room.id, actor.userId)
        ? { kind: 'human', relation: 'member', roomKind: room.kind }
        : null;
    }

    case 'room_agent': {
      const ra = repo.getRoomAgent(actor.roomAgentId);
      return ra && ra.roomId === room.id ? { kind: 'room_agent' } : null;
    }

    case 'agent': {
      const agent = repo.getAgent(actor.agentId);
      if (!agent) return null;
      if (room.kind === 'dm') return null;
      if (room.kind === 'our') {
        return repo.isMember(room.id, agent.ownerId) ? { kind: 'agent', mode: 'member', roomKind: 'our' } : null;
      }
      // my Room
      if (room.ownerId === agent.ownerId) {
        const state = buildRoomState(room.id, ctx.store.listAll(room.id));
        const representing = state.members[agent.ownerId]?.mandate != null;
        return { kind: 'agent', mode: representing ? 'representing' : 'accompanied', roomKind: 'my' };
      }
      const visit = repo
        .listVisitsByHost(room.id)
        .find((v) => v.visitorKind === 'agent' && v.visitorAgentId === agent.id && v.status === 'active');
      if (!visit) return null;
      return {
        kind: 'agent',
        mode: 'visiting',
        visit: { status: visit.status, permissions: visit.permissions },
        mandateActions: visit.mandate?.allowedActions ?? [],
      };
    }
  }
}

/** 서버 내부용: 가시성 필터 없이 이벤트 로그 전체를 리듀싱한 Room 상태 */
export function roomStateOf(ctx: AppContext, roomId: string): RoomState {
  return buildRoomState(roomId, ctx.store.listAll(roomId));
}

/** 이 사용자의 마지막 member_left 이벤트 (암묵적/명시적 구분용) */
export function lastLeaveOf(ctx: AppContext, roomId: string, userId: string): (RoomEvent & { type: 'member_left' }) | undefined {
  const all = ctx.store.listAll(roomId);
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i]!;
    if (e.type === 'member_left' && e.userId === userId) return e;
  }
  return undefined;
}

/** "부재 중 변화"로 세지 않는 이벤트: Agent 턴 진행과 presence 자체 */
export const QUIET_EVENTS = new Set([
  'agent_step',
  'agent_turn_started',
  'agent_turn_ended',
  'member_entered',
  'member_left',
  'member_rejoined',
  'digest_viewed',
]);

/** leftAtSeq 이후 viewer에게 보이는 변화 수 */
export function missedChangeCount(ctx: AppContext, viewerId: string, roomId: string, leftAtSeq: number | null): number {
  if (leftAtSeq === null) return 0;
  return ctx.store.listVisible(viewerId, roomId, { afterSeq: leftAtSeq }).filter((e) => !QUIET_EVENTS.has(e.type) && !(e.type === 'board_tool_updated' && e.op.op === 'cover_set')).length;
}

/** 사람 사용자가 이 Room을 볼 수 있는가 (구독·스냅샷 접근 판정) */
export function canAccessRoom(ctx: AppContext, userId: string, roomId: string): boolean {
  const room = ctx.repo.getRoom(roomId);
  return !!room && resolveSubject(ctx, room, { kind: 'human', userId }) !== null;
}

/** 월드에 보이는 Room: 모든 My Room(남의 것은 서리 유리 + 최소 정보), 내가 구성원인 Our·DM */
function roomVisibleInWorld(ctx: AppContext, viewerId: string, room: RoomRow): boolean {
  return room.kind === 'my' || ctx.repo.isMember(room.id, viewerId);
}

function agentRefsFor(ctx: AppContext, room: RoomRow): { refs: AgentRef[]; names: Map<string, string> } {
  const { repo } = ctx;
  const refs: AgentRef[] = [];
  const names = new Map<string, string>();
  const personal = (userId: string) => {
    const user = repo.getUser(userId);
    const a = repo.getAgentByOwner(userId);
    if (!a || user?.kind === 'seed') return; // 시드 사용자의 Agent는 실행하지 않는다
    refs.push({ agentId: a.id, ownerUserId: userId, homeRoomId: room.id });
    names.set(a.id, a.name);
  };
  if (room.kind === 'my' && room.ownerId) personal(room.ownerId);
  if (room.kind === 'our') {
    for (const m of repo.memberIds(room.id)) personal(m);
    const ra = repo.getRoomAgentByRoom(room.id);
    if (ra) {
      refs.push({ agentId: ra.id, ownerUserId: null, homeRoomId: room.id });
      names.set(ra.id, ra.name);
    }
  }
  return { refs, names };
}

/** 방문 Agent의 가장 최근 이동. 출발(소유자 My Room) 로그의 agent_departed에서 읽는다. 없으면 null. */
function agentTravelOf(ctx: AppContext, v: VisitRow): AgentTravel | null {
  if (v.visitorKind !== 'agent' || !v.visitorAgentId) return null;
  const home = ctx.repo.getMyRoomByOwner(v.visitorUserId);
  if (!home) return null;
  const all = ctx.store.listAll(home.id);
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i]!;
    if (e.type === 'agent_departed' && e.visitId === v.id) {
      return { fromRoomId: home.id, toRoomId: v.hostRoomId, seq: e.seq, at: e.ts };
    }
  }
  return null;
}

/** viewer의 명시적 Leave 상태. 암묵적 퇴장·미입장은 null */
function myLeaveOf(ctx: AppContext, roomId: string, viewerId: string, state: RoomState): 'delegated' | 'plain' | null {
  const m = state.members[viewerId];
  if (!m || m.present) return null;
  if (m.mandate) return 'delegated';
  return lastLeaveOf(ctx, roomId, viewerId)?.implicit === false ? 'plain' : null;
}

/** viewer 시점의 Room 미리보기. 월드에 보이지 않는 Room이면 null. 남의 캡슐에는 detail을 주지 않는다. */
export function previewFor(ctx: AppContext, viewerId: string, roomId: string): RoomPreview | null {
  const { repo, store } = ctx;
  const room = repo.getRoom(roomId);
  if (!room || !roomVisibleInWorld(ctx, viewerId, room)) return null;

  const all = store.listAll(roomId);
  const state = buildRoomState(roomId, all);
  const memberIds = repo.memberIds(roomId);
  const clarity = glassClarity(
    viewerId,
    { id: room.id, kind: room.kind, ownerId: room.ownerId, memberIds },
    repo.listVisitsByVisitor(viewerId),
  );

  const mine = room.kind === 'my' ? room.ownerId === viewerId : memberIds.includes(viewerId);
  let detail: RoomPreview['detail'] = null;
  if (mine) {
    const visible = store.listVisible(viewerId, roomId);
    const cursor = repo.getCursor(viewerId, roomId);
    const unread = visible.filter(
      (e) => e.type === 'message' && e.seq > cursor.lastSeenSeq && !(e.actorKind === 'human' && e.actorId === viewerId),
    ).length;
    const missedChanges = missedChangeCount(ctx, viewerId, roomId, cursor.leftAtSeq);
    const { refs, names } = agentRefsFor(ctx, room);
    const states = buildAgentStates(refs, all);
    const agents: AgentChip[] = refs.map((r) => {
      // 방문은 호스트 Room 로그에 도착이 남으므로, 활성 방문 중인 Agent는 방문 중으로 표시한다
      const open = ctx.repo.findOpenAgentVisit(r.agentId);
      const away = open?.status === 'active' ? open : undefined;
      const st = states[r.agentId]!;
      const chip: AgentChip = {
        agentId: r.agentId,
        name: names.get(r.agentId) ?? r.agentId,
        activity: st.activity,
        mode: away ? 'visiting' : st.mode,
        location: st.mode === 'traveling' ? null : (st.location ?? room.id),
      };
      if (away) {
        // 방문 목적지는 그 방문 당사자(Agent 소유자·호스트 소유자)만 안다. Our 구성원 등 제3자에게는 가린다.
        const hostOwner = ctx.repo.getRoom(away.hostRoomId)?.ownerId;
        const involved = viewerId === away.visitorUserId || viewerId === hostOwner;
        chip.location = involved ? away.hostRoomId : null;
        chip.travel = involved ? agentTravelOf(ctx, away) : null;
      }
      return chip;
    });
    // 이 Room에서 진행 중인 Agent 방문(호스트 Room의 소유자에게만 detail이 간다)
    const known = new Set(agents.map((a) => a.agentId));
    for (const v of repo.listVisitsByHost(roomId)) {
      if (v.visitorKind !== 'agent' || v.status !== 'active' || !v.visitorAgentId || known.has(v.visitorAgentId)) continue;
      const va = repo.getAgent(v.visitorAgentId);
      if (!va) continue;
      known.add(va.id);
      const home = repo.getMyRoomByOwner(v.visitorUserId);
      const vst = buildAgentStates([{ agentId: va.id, ownerUserId: v.visitorUserId, homeRoomId: home?.id ?? null }], all)[va.id]!;
      agents.push({
        agentId: va.id,
        name: va.name,
        activity: AGENT_ACTIVITIES.includes(vst.activity) ? vst.activity : 'idle',
        mode: 'visiting',
        location: roomId,
        travel: agentTravelOf(ctx, v),
      });
    }
    detail = {
      unread,
      missedChanges,
      agents,
      pendingApprovals: pendingApprovalsFor(state, viewerId).length,
      presentUserIds: [...state.presentUserIds],
      myLeave: myLeaveOf(ctx, roomId, viewerId, state),
      // 구성원(detail을 받는 사람)에게만: 보이는 이벤트 최근 80개로 진행 중인 A2A/A2H의 종류만 알린다(내용 없음)
      interaction: pickPreviewInteraction(
        indexInteractions(visible.slice(-80), { isAgentId: (aid) => refs.some((r) => r.agentId === aid) || known.has(aid) }),
        Date.now(),
      ),
    };
  }

  return { roomId, ambience: roomAmbience(state).stage, glass: clarity, detail };
}

/** 내 Agent의 현재 위치·상태. 방문 테이블(서버 진실)과 Room 로그에서 만든다. */
export function myAgentStatus(ctx: AppContext, userId: string): MyAgentStatus | null {
  const { repo } = ctx;
  const agent = repo.getAgentByOwner(userId);
  if (!agent) return null;
  const base = { agentId: agent.id, name: agent.name };
  const nameOf = (id: string) => repo.getUser(id)?.name ?? id;

  const open = repo.findOpenAgentVisit(agent.id);
  if (open) {
    const host = repo.getRoom(open.hostRoomId);
    const hostName = host?.ownerId ? `${nameOf(host.ownerId)}의 Room` : (host?.title ?? 'Room');
    if (open.status === 'active') {
      return {
        ...base,
        mode: 'visiting',
        activity: 'idle',
        location: open.hostRoomId,
        label: `${hostName} 방문 중`,
        travel: agentTravelOf(ctx, open),
      };
    }
    return { ...base, mode: 'accompanied', activity: 'idle', location: null, label: `${hostName} 방문 요청 중` };
  }

  // 대리 참여: 내가 Leave(mandate)한 Room
  const myRoom = repo.getMyRoomByOwner(userId);
  const rooms = [myRoom, ...repo.listRooms().filter((r) => r.kind === 'our' && repo.isMember(r.id, userId))].filter(
    (r): r is RoomRow => !!r,
  );
  for (const room of rooms) {
    const m = roomStateOf(ctx, room.id).members[userId];
    if (m && !m.present && m.mandate) {
      return {
        ...base,
        mode: 'representing',
        activity: 'idle',
        location: room.id,
        label: room.kind === 'my' ? '내 Room에서 대리 참여 중' : `${room.title}에서 대리 참여 중`,
      };
    }
  }

  let activity: AgentActivity = 'idle';
  let mode: AgentMode = 'accompanied';
  if (myRoom) {
    const ref: AgentRef = { agentId: agent.id, ownerUserId: userId, homeRoomId: myRoom.id };
    const st = buildAgentStates([ref], ctx.store.listAll(myRoom.id))[agent.id]!;
    activity = AGENT_ACTIVITIES.includes(st.activity) ? st.activity : 'idle';
    mode = st.mode === 'traveling' ? 'traveling' : 'accompanied';
  }
  return {
    ...base,
    mode,
    activity,
    location: mode === 'traveling' ? null : (myRoom?.id ?? null),
    label: mode === 'traveling' ? '이동 중' : '내 Room에서 함께 있음',
  };
}

export function buildWorld(ctx: AppContext, viewerId: string): WorldResponse {
  const { repo } = ctx;
  const me = repo.getUser(viewerId);
  if (!me) throw notFound('user_not_found');
  const rank = (r: RoomRow) => (r.kind === 'my' ? (r.ownerId === viewerId ? 0 : 3) : r.kind === 'our' ? 1 : 2);
  const rooms: WorldRoom[] = [];
  for (const room of repo.listRooms().sort((a, b) => rank(a) - rank(b))) {
    const preview = previewFor(ctx, viewerId, room.id);
    if (preview) rooms.push({ ...repo.roomInfo(room), preview });
  }
  return { me, users: repo.listUsers(), rooms, myAgent: myAgentStatus(ctx, viewerId) };
}

/** Room 스냅샷: 보이는 이벤트만 담는다. 접근할 수 없으면 403. */
export function buildSnapshot(ctx: AppContext, viewerId: string, roomId: string): RoomSnapshot {
  const { repo, store } = ctx;
  const room = requireRoom(ctx, roomId);
  if (!resolveSubject(ctx, room, { kind: 'human', userId: viewerId })) {
    throw forbidden('not_in_room', '이 Room에 접근할 수 없습니다');
  }
  const events = store.listVisible(viewerId, roomId);
  const { refs } = agentRefsFor(ctx, room);
  const agents: AgentDto[] = [];
  for (const r of refs) {
    const a = r.ownerUserId ? repo.getAgent(r.agentId) : undefined;
    if (a) agents.push(Repo.agentDto(a));
    else {
      const ra = repo.getRoomAgent(r.agentId);
      if (ra) agents.push(Repo.roomAgentDto(ra));
    }
  }
  const privileged = room.kind === 'my' ? room.ownerId === viewerId : repo.isMember(roomId, viewerId);
  const visitRows = repo.listVisitsByHost(roomId).filter((v) => privileged || v.visitorUserId === viewerId);
  const visits = visitRows.map(Repo.visitDto);
  // 방문 Agent의 표시 정보(공개 DTO만): 진행 중 방문, 그리고 보이는 타임라인에 흔적을 남긴 방문 Agent
  const known = new Set(agents.map((a) => a.id));
  const addVisitor = (agentId: string | null | undefined) => {
    if (!agentId || known.has(agentId)) return;
    const a = repo.getAgent(agentId);
    if (!a) return;
    known.add(agentId);
    agents.push(Repo.agentDto(a));
  };
  for (const v of visitRows) {
    if (v.visitorKind === 'agent' && (v.status === 'active' || v.status === 'ended')) addVisitor(v.visitorAgentId);
  }
  for (const e of events) {
    if (e.actorKind === 'agent') addVisitor(e.actorId);
  }
  return {
    room: repo.roomInfo(room),
    agents,
    events,
    lastSeq: events.length ? events[events.length - 1]!.seq : 0,
    visits,
    readCursor: repo.getCursor(viewerId, roomId),
  };
}
