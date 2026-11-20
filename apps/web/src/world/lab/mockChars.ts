import { PALETTE, type AgentActivity, type AgentCueKind, type AmbienceStage, type WorldRoom } from '@ensemble/shared';
import type { CharacterInput, WorldCharacters } from '../agents/types';
import type { WorldUser } from '../types';
import { awayHumanInput } from '../agents/derive';

export type LabAgentMode = 'accompanied' | 'representing' | 'visiting' | 'traveling';
export type LabState = AgentActivity | 'recalling' | 'error';
export const LAB_STATES: readonly LabState[] = ['idle', 'thinking', 'recalling', 'drafting', 'talking', 'awaiting', 'paused', 'error'];
export const LAB_MODES: readonly LabAgentMode[] = ['accompanied', 'representing', 'visiting', 'traveling'];

export interface LabCharsOptions {
  viewerId: string;
  state: LabState;
  mode: LabAgentMode;
  cue: { kind: AgentCueKind; seq: number } | null;
  /** 모드 시연 대상: 이 사용자의 Agent에게 mode를 적용한다 */
  modeUserId: string;
  /** visiting/traveling의 목적지 Room */
  destRoomId: string;
  speech: string;
  /** A2A/A2H 연결선 시연(서버 데이터가 없어도 3D를 확인하기 위한 주입). 시연 링크는 pending이라 사라지지 않는다 */
  ix?: LabIxDemo;
}

export type LabIxDemo = 'none' | 'a2a_ask' | 'a2a_answer' | 'a2h_approval';
export const LAB_IX_DEMOS: readonly LabIxDemo[] = ['none', 'a2a_ask', 'a2a_answer', 'a2h_approval'];

/** Our 방마다: Room Agent -> 구성원 Agent(A2A), 구성원 Agent -> 사람(A2H, 자리 비움 포함)을 주입한다 */
function injectDemo(out: CharacterInput[], demo: LabIxDemo): CharacterInput[] {
  if (demo === 'none') return out;
  const at = Date.now();
  const byId = new Map(out.map((c) => [c.id, c] as const));
  const patch = new Map<string, Partial<CharacterInput>>();
  const addLink = (fromId: string, link: NonNullable<CharacterInput['links']>[number]) => {
    const prev = patch.get(fromId)?.links ?? [];
    patch.set(fromId, { ...patch.get(fromId), links: [...prev, link] });
  };
  const rooms = new Set(out.filter((c) => c.kind === 'room_agent').map((c) => c.roomId!));
  for (const roomId of rooms) {
    const ra = out.find((c) => c.kind === 'room_agent' && c.roomId === roomId)!;
    const agents = out.filter((c) => c.kind === 'agent' && c.roomId === roomId);
    if (agents.length === 0) continue;
    if (demo === 'a2a_ask' || demo === 'a2a_answer') {
      const targets = agents.length > 1 ? agents.slice(1, 3) : agents;
      targets.forEach((t, i) => addLink(ra.id, { toCharId: t.id, channel: 'a2a', seq: 10 + i, at, pending: true, reverse: demo === 'a2a_answer' }));
    } else {
      const asker = agents.length > 1 ? agents[1]! : agents[0]!;
      const humans = out.filter((c) => c.kind === 'human' && c.roomId === roomId).slice(0, 2);
      humans.forEach((h, i) => {
        addLink(asker.id, { toCharId: h.id, channel: 'a2h', seq: 20 + i, at, pending: true });
        patch.set(h.id, { ...patch.get(h.id), alert: 'approval' });
      });
    }
  }
  const linked = new Set<string>();
  for (const [from, pt] of patch) for (const l of pt.links ?? []) (linked.add(from), linked.add(l.toCharId));
  return out.map((c) => (byId.has(c.id) && (patch.has(c.id) || linked.has(c.id)) ? { ...c, ...patch.get(c.id), ...(linked.has(c.id) ? { linked: true } : {}) } : c));
}

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
  detail: 'full',
  seatUserId: null,
  ...p,
});

/** /lab/world용 mock: 방마다 사람과 Agent를 놓고, 한 가지 상태·모드를 모든 Agent에게 시연한다 */
export function mockCharacters(
  rooms: readonly WorldRoom[],
  users: Readonly<Record<string, WorldUser>>,
  ambience: Readonly<Record<string, AmbienceStage>>,
  o: LabCharsOptions,
): WorldCharacters {
  const out: CharacterInput[] = [];
  const act: AgentActivity = o.state === 'recalling' ? 'thinking' : o.state === 'error' ? 'idle' : o.state;
  const speechFor = (): CharacterInput['speech'] => {
    if (o.state === 'thinking') return { text: '', phase: 'thinking', tokensPerSec: 0 };
    if (o.state === 'recalling') return { text: '', phase: 'recalling', tokensPerSec: 0 };
    if (o.state === 'drafting') return { text: o.speech, phase: 'writing', tokensPerSec: 28 };
    if (o.state === 'talking') return { text: o.speech, phase: 'said', tokensPerSec: 24 };
    return null;
  };
  for (const r of rooms) {
    const amb = ambience[r.id] ?? r.preview.ambience;
    const humansHere = amb === 'occupied' || amb === 'attention';
    const owners = r.kind === 'my' ? (r.ownerId ? [r.ownerId] : []) : r.memberIds.slice(0, 6);
    // 접속 중: 불이 켜진 방이면 구성원 중 마지막 한 명(2명 이상일 때)만 빼고 모두. 나머지는 자리 비움(흐리게)
    const nPresent = humansHere ? (r.kind === 'our' && owners.length > 1 ? owners.length - 1 : owners.length) : 0;
    const present = owners.slice(0, nPresent);
    const away = owners.slice(nPresent);
    const forDemo = (uid: string) => uid === o.modeUserId;
    for (const uid of away) {
      // 명시적 Leave(대리 시연 중인 소유자)는 사람을 그리지 않는다
      if (r.kind === 'my' && o.mode === 'representing' && forDemo(uid)) continue;
      const u = users[uid];
      out.push(awayHumanInput(uid, r.id, u?.name ?? uid, u?.color ?? '#999999', o.viewerId, 'full'));
    }
    for (const uid of present) {
      if (r.kind === 'my' && o.mode === 'representing' && forDemo(uid)) continue;
      const u = users[uid];
      out.push(
        base({
          id: `h:${uid}`,
          kind: 'human',
          name: u?.name ?? uid,
          color: u?.color ?? '#999999',
          ownerId: uid,
          roomId: r.id,
          isMe: uid === o.viewerId,
          seatUserId: uid,
        }),
      );
    }
    const firstHuman = present[0] ? `h:${present[0]}` : null;
    if (r.kind === 'my' && r.ownerId) {
      const uid = r.ownerId;
      const u = users[uid];
      const demo = forDemo(uid);
      const mode = demo ? o.mode : 'accompanied';
      const loc = mode === 'traveling' ? null : mode === 'visiting' ? o.destRoomId : r.id;
      out.push(
        base({
          id: `ag_${uid}`,
          kind: 'agent',
          name: `${u?.name ?? uid}의 Agent`,
          color: u?.color ?? '#999999',
          ownerId: uid,
          roomId: loc,
          destRoomId: mode === 'traveling' ? o.destRoomId : null,
          homeRoomId: r.id,
          isMe: uid === o.viewerId,
          activity: mode === 'traveling' ? 'idle' : act,
          mode,
          recalling: o.state === 'recalling',
          representing: mode === 'representing',
          visiting: mode === 'visiting',
          target: o.state === 'talking' || o.state === 'awaiting' ? { kind: 'user', id: uid } : null,
          targetCharId: o.state === 'talking' || o.state === 'awaiting' ? `h:${uid}` : null,
          cue: o.cue && demo ? o.cue : o.state === 'error' ? { kind: 'scatter', seq: 9000 } : null,
          speech: speechFor(),
          awaitingApproval: o.state === 'awaiting',
          seatUserId: uid,
        }),
      );
    } else if (r.kind === 'our') {
      // 구성원 Personal Agent(같은 자리 옆에 선다): 사람과 겹치지 않는지 보기 위한 시연
      for (const uid of owners.slice(0, 3)) {
        const u = users[uid];
        out.push(
          base({
            id: `ag_${uid}@${r.id}`,
            kind: 'agent',
            name: `${u?.name ?? uid}의 Agent`,
            color: u?.color ?? '#999999',
            ownerId: uid,
            roomId: r.id,
            homeRoomId: r.id,
            isMe: uid === o.viewerId,
            activity: act,
            recalling: o.state === 'recalling',
            seatUserId: uid,
          }),
        );
      }
      out.push(
        base({
          id: `ra_${r.id}`,
          kind: 'room_agent',
          name: `${r.title} Room Agent`,
          color: PALETTE.roomAgentLime,
          roomId: r.id,
          homeRoomId: r.id,
          activity: act,
          recalling: o.state === 'recalling',
          target: o.state === 'talking' && owners[0] ? { kind: 'user', id: owners[0] } : null,
          targetCharId: o.state === 'talking' ? firstHuman : null,
          speech: speechFor(),
          awaitingApproval: o.state === 'awaiting',
          cue: o.cue && !['dissolve', 'reassemble'].includes(o.cue.kind) ? o.cue : null,
        }),
      );
    }
  }
  return { characters: injectDemo(out, o.ix ?? 'none') };
}
