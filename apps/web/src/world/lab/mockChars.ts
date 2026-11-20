import { PALETTE, type AgentActivity, type AgentCueKind, type AmbienceStage, type WorldRoom } from '@ensemble/shared';
import type { CharacterInput, WorldCharacters } from '../agents/types';
import type { WorldUser } from '../types';

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
    const owners = r.kind === 'my' ? (r.ownerId ? [r.ownerId] : []) : r.memberIds.slice(0, 3);
    const present = humansHere ? owners : [];
    const forDemo = (uid: string) => uid === o.modeUserId;
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
  return { characters: out };
}
