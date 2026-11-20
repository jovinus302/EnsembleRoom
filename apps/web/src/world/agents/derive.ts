import { PALETTE, type AgentActivity, type AgentChip, type AgentMode, type MyAgentStatus, type RoomEvent, type UserDto, type WorldRoom } from '@ensemble/shared';
import type { RoomModel } from '../../room/useRoomModel';
import type { ActivityEntry } from '../../store/activityStore';
import { activityKey } from '../../store/activityStore';
import type { CharacterInput } from './types';

/** three를 끌어오지 않는 순수 함수들: stage/WorldHost가 메인 번들에서 쓴다 */

export const ROOM_AGENT_LIME = PALETTE.roomAgentLime;
const FALLBACK = '#a0aec4';
const SPEECH_MAX = 46;

/** 스트리밍 텍스트의 끝부분만 짧게 (말풍선용) */
export function clipSpeech(text: string, max = SPEECH_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return '…' + t.slice(t.length - max + 1);
}

function lastAgentMessage(events: readonly RoomEvent[], agentId: string): { text: string; seq: number } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'message' && e.actorId === agentId) return { text: e.text, seq: e.seq };
  }
  return null;
}

function speechFor(
  model: RoomModel,
  agentId: string,
  activity: AgentActivity,
  recalling: boolean,
  act: ActivityEntry | undefined,
): CharacterInput['speech'] {
  if (!model.replaying && act) {
    const phase = act.phase;
    if (act.text) return { text: clipSpeech(act.text), phase, tokensPerSec: act.tokensPerSec };
    return { text: '', phase: recalling ? 'recalling' : phase, tokensPerSec: act.tokensPerSec };
  }
  if (activity === 'thinking') return { text: '', phase: recalling ? 'recalling' : 'thinking', tokensPerSec: 0 };
  if (activity === 'talking' || activity === 'drafting') {
    const m = lastAgentMessage(model.events, agentId);
    if (m) return { text: clipSpeech(m.text), phase: activity === 'drafting' ? 'writing' : 'said', tokensPerSec: 0 };
    return { text: '', phase: 'writing', tokensPerSec: 0 };
  }
  return null;
}

function lastDeparture(events: readonly RoomEvent[], agentId: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'agent_departed' && e.agentId === agentId) return e.toRoomId;
  }
  return null;
}

/**
 * 포커스된 Room: useRoomModel(replaySeq 반영) + 실시간 activityStore로 세밀하게.
 * 사람은 presentUserIds, Agent는 이 Room 로그에서 재구성한 상태(`agents[].state`)를 그대로 쓴다.
 */
export function deriveFocusCharacters(model: RoomModel, activity: Readonly<Record<string, ActivityEntry>>): CharacterInput[] {
  const out: CharacterInput[] = [];
  const roomId = model.roomId;
  for (const uid of model.state.presentUserIds) {
    const u = model.users[uid];
    out.push({
      id: `h:${uid}`,
      kind: 'human',
      name: u?.name ?? uid,
      color: u?.color ?? FALLBACK,
      ownerId: uid,
      roomId,
      isMe: uid === model.meId,
      activity: 'idle',
      mode: 'accompanied',
      recalling: false,
      representing: false,
      visiting: false,
      handoverPending: false,
      target: null,
      targetCharId: null,
      cue: null,
      speech: null,
      awaitingApproval: false,
      detail: 'full',
      seatUserId: uid,
    });
  }
  const ids = new Set(out.map((c) => c.id));
  const resolveTarget = (t: CharacterInput['target']): string | null => {
    if (!t || !t.id) return null;
    if (t.kind === 'user' || t.kind === 'owner_seat') return `h:${t.id}`;
    if (t.kind === 'agent') return t.id;
    return null;
  };
  for (const a of model.agents) {
    const s = a.state;
    const traveling = s.mode === 'traveling';
    const here = s.location === roomId || s.mode === 'representing' || a.visiting;
    if (!traveling && !here) continue; // 다른 Room을 방문 중: 이 Room 로그에서는 그리지 않는다
    const act = activity[activityKey(roomId, a.agentId)];
    const activityNow: AgentActivity = !model.replaying && act && s.activity === 'idle' ? 'thinking' : s.activity;
    const row: CharacterInput = {
      id: a.agentId,
      kind: a.kind,
      name: a.name,
      color: a.color,
      ownerId: a.ownerId,
      roomId: traveling ? null : roomId,
      destRoomId: traveling ? lastDeparture(model.allEvents, a.agentId) : null,
      homeRoomId: roomId,
      isMe: a.ownerId === model.meId,
      activity: activityNow,
      mode: s.mode,
      recalling: s.recalling || act?.phase === 'recalling',
      representing: s.mode === 'representing',
      visiting: a.visiting || s.mode === 'visiting',
      handoverPending: s.handoverPending,
      target: s.target,
      targetCharId: resolveTarget(s.target),
      cue: s.cue,
      speech: speechFor(model, a.agentId, activityNow, s.recalling, act),
      awaitingApproval: s.activity === 'awaiting',
      detail: 'full',
      seatUserId: a.ownerId,
    };
    if (!ids.has(row.id)) {
      out.push(row);
      ids.add(row.id);
    }
  }
  return out;
}

/** 구독 중인 모든 Room 로그에서 agent_departed의 목적지를 모은다 (agentId → toRoomId, 가장 최근) */
export function collectTripHints(rooms: Readonly<Record<string, { events: readonly RoomEvent[] }>>): Record<string, string> {
  const best: Record<string, { seq: number; to: string }> = {};
  for (const slice of Object.values(rooms)) {
    const seen = new Set<string>();
    for (let i = slice.events.length - 1; i >= 0 && i >= slice.events.length - 120; i--) {
      const e = slice.events[i]!;
      if (e.type === 'agent_departed' && !seen.has(e.agentId)) {
        seen.add(e.agentId);
        const prev = best[e.agentId];
        if (!prev || e.seq > prev.seq) best[e.agentId] = { seq: e.seq, to: e.toRoomId };
      }
    }
  }
  return Object.fromEntries(Object.entries(best).map(([k, v]) => [k, v.to]));
}

type LightUsers = Readonly<Record<string, { id: string; name: string; color: string }>>;

/**
 * 조망의 다른 캡슐: world preview 수준.
 * - 사람: 서버가 준 `detail.presentUserIds`가 있으면 그것을 쓴다(내가 구성원인 Room). 없으면(남의 Room, 서리 유리) 조명 단계(occupied)와
 *   My Room 소유자로만 추정한다 — 남의 방은 계속 실루엣 수준.
 * - Agent: AgentChip(활동·모드). 방문 Agent는 `mode==='visiting'`이고 `location`이 있는 칩을 그 Room(호스트) 캡슐에 그린다.
 *   출발 Room에서는 나가 있고(그리지 않음), `location===null`인 visiting은 이동 연출 없이 부재로만 둔다.
 */
export function deriveLightCharacters(
  rooms: readonly WorldRoom[],
  users: LightUsers,
  meId: string,
  myAgent: MyAgentStatus | null,
  skipRoomId: string | null,
  tripHints: Readonly<Record<string, string>>,
): CharacterInput[] {
  const out: CharacterInput[] = [];
  const base = (p: Partial<CharacterInput> & Pick<CharacterInput, 'id' | 'kind' | 'name' | 'color' | 'roomId'>): CharacterInput => ({
    ownerId: null,
    isMe: false,
    activity: 'idle',
    mode: 'accompanied',
    recalling: false,
    representing: false,
    visiting: false,
    handoverPending: false,
    target: null,
    targetCharId: null,
    cue: null,
    speech: null,
    awaitingApproval: false,
    detail: 'light',
    seatUserId: null,
    ...p,
  });
  const roomIds = new Set(rooms.map((r) => r.id));
  const humanPlace = new Map<string, string>();
  const humanVisit = new Set<string>();
  const addHuman = (uid: string, r: WorldRoom, visitor: boolean) => {
    // 같은 사람이 여러 Room의 present에 있으면 방문 중인 Room(내 방이 아닌 곳)이 이긴다
    if (!humanPlace.has(uid) || (visitor && !humanVisit.has(uid))) {
      humanPlace.set(uid, r.id);
      if (visitor) humanVisit.add(uid);
    }
  };
  for (const r of rooms) {
    if (r.id === skipRoomId || r.kind === 'dm') continue;
    const d = r.preview.detail;
    const present = d?.presentUserIds;
    if (present) {
      for (const uid of present) addHuman(uid, r, r.kind === 'my' && r.ownerId !== uid);
    } else {
      const occupied = r.preview.ambience === 'occupied' || (r.preview.ambience === 'attention' && !!r.ownerId && r.ownerId === meId);
      if (occupied && r.kind === 'my' && r.ownerId) addHuman(r.ownerId, r, false);
    }
  }
  for (const [uid, roomId] of humanPlace) {
    const u = users[uid];
    out.push(base({ id: `h:${uid}`, kind: 'human', name: u?.name ?? '', color: u?.color ?? FALLBACK, ownerId: uid, roomId, isMe: uid === meId, seatUserId: uid }));
  }

  // Agent: 같은 agentId가 여러 칩으로 오면(출발 Room의 visiting 칩 + 호스트 Room 칩) 위치가 확정된 칩이 이긴다
  const chosen = new Map<string, { chip: AgentChip; room: WorldRoom }>();
  for (const r of rooms) {
    if (r.kind === 'dm') continue;
    for (const c of r.preview.detail?.agents ?? []) {
      const prev = chosen.get(c.agentId);
      const placed = c.mode === 'visiting' && !!c.location && roomIds.has(c.location);
      const prevPlaced = prev && prev.chip.mode === 'visiting' && !!prev.chip.location && roomIds.has(prev.chip.location);
      if (!prev || (placed && !prevPlaced)) chosen.set(c.agentId, { chip: c, room: r });
    }
  }
  const seen = new Set<string>();
  for (const { chip: c, room: r } of chosen.values()) {
    seen.add(c.agentId);
    const visiting = c.mode === 'visiting';
    // 방문 중인데 위치를 모르면(제3자) 이동 연출 없이 부재로만 둔다
    if (visiting && !c.location) continue;
    const roomId = c.mode === 'traveling' ? null : visiting ? c.location! : r.id;
    if (roomId === skipRoomId && roomId !== null) continue;
    const owner = guessOwner(c.name, r, users);
    const isRoom = !owner && /room/i.test(c.name);
    out.push(
      base({
        id: c.agentId,
        kind: isRoom ? 'room_agent' : 'agent',
        name: c.name,
        color: isRoom ? ROOM_AGENT_LIME : owner ? users[owner]!.color : FALLBACK,
        ownerId: owner,
        roomId,
        destRoomId: tripHints[c.agentId] ?? c.travel?.toRoomId ?? null,
        homeRoomId: visiting ? (c.travel?.fromRoomId ?? r.id) : r.id,
        isMe: owner === meId,
        activity: c.activity,
        mode: c.mode as AgentMode,
        representing: c.mode === 'representing',
        visiting,
        seatUserId: owner,
        travel: c.travel ? { fromRoomId: c.travel.fromRoomId, toRoomId: c.travel.toRoomId, seq: c.travel.seq } : null,
      }),
    );
  }
  if (myAgent && !seen.has(myAgent.agentId)) {
    const myRoom = rooms.find((r) => r.kind === 'my' && r.ownerId === meId);
    const loc = myAgent.mode === 'traveling' ? null : (myAgent.location ?? myRoom?.id ?? null);
    if (loc !== skipRoomId || loc === null) {
      out.push(
        base({
          id: myAgent.agentId,
          kind: 'agent',
          name: myAgent.name,
          color: users[meId]?.color ?? FALLBACK,
          ownerId: meId,
          roomId: loc,
          destRoomId: tripHints[myAgent.agentId] ?? myAgent.travel?.toRoomId ?? null,
          homeRoomId: myAgent.travel?.fromRoomId ?? myRoom?.id ?? null,
          isMe: true,
          activity: myAgent.activity,
          mode: myAgent.mode,
          representing: myAgent.mode === 'representing',
          visiting: myAgent.mode === 'visiting',
          seatUserId: meId,
          travel: myAgent.travel ? { fromRoomId: myAgent.travel.fromRoomId, toRoomId: myAgent.travel.toRoomId, seq: myAgent.travel.seq } : null,
        }),
      );
    }
  }
  return out;
}

function guessOwner(name: string, room: WorldRoom, users: Readonly<Record<string, { id: string; name: string }>>): string | null {
  for (const u of Object.values(users)) if (u.name && name.includes(u.name)) return u.id;
  if (room.kind === 'my' && room.ownerId) return room.ownerId;
  return null;
}

/** 포커스 Room의 세밀한 목록 + 나머지 캡슐의 가벼운 목록을 합친다. 같은 id는 세밀한 쪽이 이긴다 */
export function mergeCharacters(focus: readonly CharacterInput[], light: readonly CharacterInput[]): CharacterInput[] {
  const ids = new Set(focus.map((c) => c.id));
  // 포커스 Room 로그에는 서버가 알려 준 이동(travel)이 없다: 조망 쪽 값을 이어 붙여 이동 연출이 끊기지 않게 한다
  const travelOf = new Map(light.filter((c) => c.travel).map((c) => [c.id, c.travel!] as const));
  const focusOut = focus.map((c) => (!c.travel && travelOf.has(c.id) ? { ...c, travel: travelOf.get(c.id)! } : c));
  return [...focusOut, ...light.filter((c) => !ids.has(c.id))];
}
