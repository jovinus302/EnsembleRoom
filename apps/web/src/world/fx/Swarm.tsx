import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { ourColor } from '@ensemble/shared';
import { fxLevel, getRemoteCursors, onFx, pointer, type FxEvent } from '../../fx/fxStore';
import type { WorldLayout } from '../layout';
import type { CapsuleModel, WorldUser } from '../types';
import type { CharacterInput } from '../agents/types';
import { characterRoomOf, getCharacterWorldPosition, onCharacterEvent } from '../agents/registry';
import { GROUPS, SLOT_AGENT, SLOT_FX, SLOT_ME, SLOT_REMOTE, SwarmSim, type GroupCmd } from './swarmSim';
import { capsuleCenter, clamp01, easeInOut, firstNeighbor, interiorAnchor, localToWorld, tubePoint, worldToLocal } from './geo';
import { cursorWorld } from './cursorWorld';
import { totalLength } from '../capsule/dims';

const ORANGE = '#ff8a3d';
const GOLD = '#ffd36a';
const FROST = '#d6ecff';
const GREY = '#8d97a8';
const MEMORY = '#ffe08a';
const CURSOR_Y = 1.5;

interface Script {
  slots: number[];
  t0: number;
  dur: number;
  run: (tn: number, now: number, cmds: GroupCmd[], slots: number[]) => void;
}

const mkCmd = (): GroupCmd => ({
  active: false,
  mode: 'cohere',
  strength: 1,
  radius: 1.5,
  speed: 1,
  target: new THREE.Vector3(),
  aux: new THREE.Vector3(),
  color: new THREE.Color('#ffffff'),
  alpha: 0.8,
});

export interface SwarmProps {
  layout: WorldLayout;
  models: Record<string, CapsuleModel>;
  users: Readonly<Record<string, WorldUser>>;
  viewerId: string;
  curves: ReadonlyMap<string, THREE.Curve<THREE.Vector3>>;
  hoveredId: string | null;
  focusRoomId: string | null;
  characters?: readonly CharacterInput[];
  replaying?: boolean;
  particles: number;
  onCursor?: (c: { x: number; y: number; z: number }) => void;
}

/**
 * swarm 감독 (계획 8.5 표 · 8.6 · 8.7). 슬롯 0은 내 커서 무리(캡슐 호버 시 그 캡슐을 감싸며 소유자 색으로 물든다),
 * 1~2는 상대 커서, 3~8은 Agent 활동/이동, 9~11(+남는 슬롯)은 fxStore 사건의 장면 스크립트가 쓴다.
 */
export function Swarm(props: SwarmProps) {
  const gl = useThree((s) => s.gl);
  const side = Math.max(32, Math.round(Math.sqrt(props.particles)));
  const sim = useMemo(() => {
    try {
      return new SwarmSim(gl, side, new THREE.Vector3(0, 0, 0));
    } catch (err) {
      console.warn('[swarm] GPGPU 사용 불가, swarm 끔', err);
      return null;
    }
  }, [gl, side]);
  useEffect(() => () => sim?.dispose(), [sim]);

  const P = useRef(props);
  P.current = props;
  const cmds = useRef<GroupCmd[]>(Array.from({ length: GROUPS }, mkCmd));
  const scripts = useRef<Script[]>([]);
  const agentSlots = useRef(new Map<string, number>());
  const trips = useRef(new Map<string, { until: number }>());
  const tmp = useMemo(() => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), ray: new THREE.Raycaster(), ndc: new THREE.Vector2() }), []);
  const gainRef = useRef(1);
  const lastGround = useRef(new THREE.Vector3(0, CURSOR_Y, 0));
  const lastSend = useRef({ t: 0, x: 0, z: 0 });
  const wantColor = useRef<THREE.Color[]>(Array.from({ length: GROUPS }, () => new THREE.Color('#ffffff')));
  const colorOf = (id: string | null | undefined): string => {
    const c = P.current.characters?.find((x) => x.id === id);
    return c?.color ?? '#ffffff';
  };

  // 슬롯 풀: 장면용(9,10,11 → 남는 Agent 슬롯 8,7,...)
  const allocSlots = (n: number): number[] => {
    const used = new Set<number>();
    for (const s of scripts.current) for (const x of s.slots) used.add(x);
    for (const x of agentSlots.current.values()) used.add(x);
    const pool = [...SLOT_FX, ...[...SLOT_AGENT].reverse()];
    const out: number[] = [];
    for (const s of pool) if (!used.has(s) && out.length < n) out.push(s);
    return out;
  };

  const placement = (roomId: string | null | undefined) => (roomId ? P.current.layout.placements[roomId] : undefined);
  const charPos = (id: string | null | undefined, out: THREE.Vector3): boolean => !!id && !!getCharacterWorldPosition(id, out, true);

  // fx 사건 → 장면 스크립트
  useEffect(() => {
    if (!sim) return;
    const start = (ev: FxEvent, n: number, dur: number, run: Script['run']) => {
      const slots = allocSlots(n);
      if (slots.length < n) return;
      scripts.current.push({ slots, t0: performance.now(), dur: dur * 1000, run });
    };
    const myColor = () => P.current.users[P.current.viewerId]?.color ?? '#ff8f7a';
    const off = onFx((ev) => {
      const pl = placement(ev.roomId);
      const curves = P.current.curves;
      const cmdOf = (cmds_: GroupCmd[], s: number, p: Omit<Partial<GroupCmd>, 'color'> & { color?: THREE.ColorRepresentation }) => {
        const c = cmds_[s]!;
        c.active = true;
        if (p.mode) c.mode = p.mode;
        if (p.strength !== undefined) c.strength = p.strength;
        if (p.radius !== undefined) c.radius = p.radius;
        if (p.speed !== undefined) c.speed = p.speed;
        if (p.alpha !== undefined) c.alpha = p.alpha;
        if (p.target) c.target.copy(p.target);
        if (p.aux) c.aux.copy(p.aux);
        if (p.color !== undefined) wantColor.current[s]!.set(p.color);
        return c;
      };
      const v = new THREE.Vector3();
      switch (ev.kind) {
        case 'agreement': {
          if (!pl) return;
          const cols = ev.colors && ev.colors.length ? ev.colors : [myColor(), '#8fc8ff'];
          const finalC = ourColor(cols);
          start(ev, 3, 2.2, (tn, now, c, s) => {
            const L = totalLength(pl.dims) * 0.36;
            const center = capsuleCenter(pl, new THREE.Vector3(), 0.5);
            const u = easeInOut(clamp01(tn / 0.38));
            const fade = 1 - clamp01((tn - 0.86) / 0.14);
            const ca = cols[0]!;
            const cb = cols[1] ?? cols[0]!;
            if (tn < 0.62) {
              const k = clamp01((tn - 0.38) / 0.24);
              const sideA = new THREE.Vector3(center.x - L * (1 - u), center.y, center.z);
              const sideB = new THREE.Vector3(center.x + L * (1 - u), center.y, center.z);
              cmdOf(c, s[0]!, { mode: tn < 0.38 ? 'cohere' : 'condense', target: sideA, radius: 1.0 - 0.4 * k, color: new THREE.Color(ca).lerp(new THREE.Color(finalC), k), alpha: 1 });
              cmdOf(c, s[1]!, { mode: tn < 0.38 ? 'cohere' : 'condense', target: sideB, radius: 1.0 - 0.4 * k, color: new THREE.Color(cb).lerp(new THREE.Color(finalC), k), alpha: 1 });
              if (tn >= 0.38) cmdOf(c, s[2]!, { mode: 'condense', target: center, radius: 0.7, color: finalC, alpha: 1 });
            } else if (tn < 0.7) {
              for (const x of s) cmdOf(c, x, { mode: 'scatter', target: center, speed: 8, strength: 1, color: finalC, alpha: 1 });
            } else {
              for (const x of s) cmdOf(c, x, { mode: 'vortex', target: center.clone().setY(pl.dims.floorHeight + 0.3), radius: pl.dims.radius * 0.9, aux: new THREE.Vector3(0, pl.dims.radius * 1.6, 0), speed: 1.1, strength: 1, color: finalC, alpha: 0.95 * fade });
            }
          });
          break;
        }
        case 'approval_requested': {
          if (!pl) return;
          start(ev, 1, 2.6, (tn, now, c, s) => {
            const top = capsuleCenter(pl, new THREE.Vector3(), pl.dims.radius + 0.7);
            const src = ev.actorId && charPos(ev.actorId, v) ? v.clone() : capsuleCenter(pl, new THREE.Vector3(), 0);
            const fade = 1 - clamp01((tn - 0.88) / 0.12);
            if (tn < 0.25) cmdOf(c, s[0]!, { mode: 'flow', target: top, aux: src, radius: 0.9, speed: 2.4, color: ORANGE, alpha: 1 });
            else cmdOf(c, s[0]!, { mode: 'condense', target: top, radius: 0.5 + 0.28 * Math.sin(now * 0.008), color: ORANGE, alpha: fade });
          });
          break;
        }
        case 'approval_resolved': {
          if (!pl) return;
          const col = ev.outcome === 'rejected' ? GREY : ev.outcome === 'edited' ? '#ffb066' : GOLD;
          start(ev, 1, 1.5, (tn, _n, c, s) => {
            const top = capsuleCenter(pl, new THREE.Vector3(), pl.dims.radius + 0.7);
            const fade = 1 - clamp01((tn - 0.7) / 0.3);
            if (tn < 0.12) cmdOf(c, s[0]!, { mode: 'condense', target: top, radius: 0.4, color: ORANGE, alpha: 1 });
            else if (ev.outcome === 'edited') cmdOf(c, s[0]!, { mode: 'vortex', target: top, radius: 1.0, aux: new THREE.Vector3(0, -2, 0), speed: 1.4, color: col, alpha: fade });
            else if (ev.outcome === 'rejected') cmdOf(c, s[0]!, { mode: tn < 0.5 ? 'scatter' : 'settle', target: top, speed: 9, color: col, alpha: 0.8 * fade });
            else cmdOf(c, s[0]!, { mode: tn < 0.45 ? 'scatter' : 'orbit', target: top, speed: 9, aux: new THREE.Vector3(pl.dims.radius * 1.3, 0.6, pl.dims.radius * 1.3), color: col, alpha: fade });
          });
          break;
        }
        case 'visit_request':
        case 'send_local':
        case 'message': {
          if (ev.kind !== 'visit_request') return; // 메시지는 FxScene의 투사체가 맡는다
          const from = ev.fromRoomId ?? (ev.toRoomId ? firstNeighbor(curves, ev.toRoomId) : null);
          const to = ev.toRoomId;
          const pa = placement(from);
          const pb = placement(to);
          if (!pa || !pb || !from || !to) return;
          const col = ev.color ?? myColor();
          start(ev, 2, 1.5, (tn, _n, c, s) => {
            [0, 1].forEach((i) => {
              const u = easeInOut(clamp01(tn * 1.15 - i * 0.14));
              const p = new THREE.Vector3();
              if (!tubePoint(curves, from, to, u, p)) p.lerpVectors(capsuleCenter(pa, new THREE.Vector3()), capsuleCenter(pb, new THREE.Vector3()), u);
              p.y += 0.5;
              cmdOf(c, s[i]!, { mode: 'cohere', target: p, radius: i === 0 ? 1.0 : 0.8, color: col, alpha: 1 - clamp01((tn - 0.9) / 0.1) });
            });
          });
          break;
        }
        case 'visit_accept': {
          // 유리가 맑아지는 순간: 호스트 캡슐 둘레를 한 바퀴 휘감는 푸른 입자(서리가 걷히는 와이프와 함께 보인다)
          if (!pl || !ev.roomId) return;
          start(ev, 2, 2.4, (tn, _n, c, s) => {
            const fade = 1 - clamp01((tn - 0.7) / 0.3);
            [0, 1].forEach((i) => {
              cmdOf(c, s[i]!, {
                mode: 'orbit',
                target: capsuleCenter(pl, new THREE.Vector3(), 0.1),
                aux: new THREE.Vector3(totalLength(pl.dims) / 2 + 0.7, pl.dims.radius * 0.9, pl.dims.radius + 0.9),
                speed: i === 0 ? 1.6 : -1.2,
                color: '#bfe6ff',
                alpha: fade,
              });
            });
          });
          break;
        }
        case 'visit_end': {
          if (!pl) return;
          start(ev, 1, 1.5, (tn, _n, c, s) => {
            const top = capsuleCenter(pl, new THREE.Vector3(), pl.dims.radius + 0.4);
            cmdOf(c, s[0]!, { mode: tn < 0.3 ? 'cohere' : 'settle', target: top, radius: pl.dims.radius * 1.3, color: FROST, alpha: 0.9 * (1 - clamp01((tn - 0.75) / 0.25)) });
          });
          break;
        }
        case 'agent_called':
        case 'agent_arrive':
        case 'agent_return':
        case 'agent_depart': {
          const col = ev.color ?? colorOf(ev.actorId);
          start(ev, 1, 1.3, (tn, _n, c, s) => {
            const p = new THREE.Vector3();
            if (!charPos(ev.actorId, p)) {
              if (!pl) return;
              capsuleCenter(pl, p, 0.5);
            }
            const fade = 1 - clamp01((tn - 0.75) / 0.25);
            if (ev.kind === 'agent_called') cmdOf(c, s[0]!, { mode: 'vortex', target: p, radius: 1.2, aux: new THREE.Vector3(0, 2.2, 0), speed: 1.6, color: col, alpha: fade });
            else if (ev.kind === 'agent_depart') cmdOf(c, s[0]!, { mode: tn < 0.4 ? 'scatter' : 'cohere', target: p, speed: 8, radius: 1.4, color: col, alpha: fade });
            else cmdOf(c, s[0]!, { mode: tn < 0.45 ? 'cohere' : 'condense', target: p, radius: tn < 0.45 ? 2.2 : 0.6, color: col, alpha: fade });
          });
          break;
        }
        case 'memory': {
          const model = ev.roomId ? P.current.models[ev.roomId] : undefined;
          if (!pl || !model) return;
          start(ev, 1, 1.5, (tn, _n, c, s) => {
            const shelf = interiorAnchor(model, pl, 'shelf', new THREE.Vector3());
            const head = new THREE.Vector3();
            if (!charPos(ev.actorId, head)) localToWorld(pl, 0, 1.4, 0.8, head);
            const fade = 1 - clamp01((tn - 0.8) / 0.2);
            cmdOf(c, s[0]!, { mode: 'flow', target: head, aux: shelf, radius: 0.7, speed: 2.2, color: MEMORY, alpha: fade });
          });
          break;
        }
        case 'leave': {
          if (!pl) return;
          const col = ev.color ?? '#ffffff';
          start(ev, 1, 1.7, (tn, _n, c, s) => {
            const owner = new THREE.Vector3();
            if (!charPos(ev.actorId, owner)) localToWorld(pl, 0, 1.4, 0.4, owner);
            const agent = new THREE.Vector3();
            const fade = 1 - clamp01((tn - 0.85) / 0.15);
            if (tn < 0.45) cmdOf(c, s[0]!, { mode: 'vortex', target: owner, radius: 1.0, aux: new THREE.Vector3(0, 2.6, 0), speed: 1.5, color: col, alpha: 1 });
            else {
              if (!charPos(ev.targetId, agent)) agent.copy(owner).add(new THREE.Vector3(1.6, 0, 0));
              cmdOf(c, s[0]!, { mode: tn < 0.8 ? 'flow' : 'condense', target: agent, aux: owner, radius: 0.9, speed: 2.6, color: col, alpha: fade });
            }
          });
          break;
        }
        case 'rejoin': {
          if (!pl) return;
          const col = ev.color ?? '#ffffff';
          start(ev, 2, 1.8, (tn, _n, c, s) => {
            const owner = new THREE.Vector3();
            if (!charPos(ev.actorId, owner)) localToWorld(pl, 0, 1.4, 0.4, owner);
            const center = capsuleCenter(pl, new THREE.Vector3(), 0.2);
            const fade = 1 - clamp01((tn - 0.82) / 0.18);
            const strength = Math.min(1, 0.6 + (ev.count ?? 1) * 0.1);
            cmdOf(c, s[0]!, { mode: 'flow', target: owner, aux: center, radius: 1.2, speed: 2.2, strength, color: '#ffffff', alpha: fade });
            cmdOf(c, s[1]!, { mode: 'flow', target: owner, aux: center, radius: 0.8, speed: 2.8, color: col, alpha: fade });
          });
          break;
        }
        case 'agent_paused':
        case 'error': {
          const col = GREY;
          start(ev, 1, 1.4, (tn, _n, c, s) => {
            const p = new THREE.Vector3();
            if (!charPos(ev.actorId, p)) {
              if (!pl) return;
              capsuleCenter(pl, p, 0.3);
            }
            cmdOf(c, s[0]!, { mode: tn < 0.3 ? 'scatter' : 'settle', target: p, speed: 6, color: col, alpha: 0.75 * (1 - clamp01((tn - 0.7) / 0.3)) });
          });
          break;
        }
        case 'click': {
          if (!cursorWorld.valid) return;
          const at = cursorWorld.point.clone();
          const col = cursorWorld.hoverRoom ? P.current.models[cursorWorld.hoverRoom]?.color ?? myColor() : myColor();
          start(ev, 1, 0.9, (tn, _n, c, s) => {
            cmdOf(c, s[0]!, { mode: tn < 0.7 ? 'scatter' : 'settle', target: at, speed: 11, color: col, alpha: (1 - clamp01((tn - 0.5) / 0.5)) * ev.gain });
          });
          break;
        }
        default:
          break;
      }
    });
    const offChar = onCharacterEvent((e) => {
      if (e.type === 'trip_start') trips.current.set(e.id, { until: Infinity });
      else if (e.type === 'trip_end') {
        const t = trips.current.get(e.id);
        if (t) t.until = performance.now() + 700;
      }
    });
    return () => {
      off();
      offChar();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim]);

  useFrame((state, dtRaw) => {
    if (!sim) return;
    const dt = Math.min(dtRaw, 0.05);
    const now = performance.now();
    const pr = P.current;
    const C = cmds.current;
    const lvl = fxLevel();
    gainRef.current += (lvl.l3Gain - gainRef.current) * Math.min(1, dt * 6);
    const gain = gainRef.current;

    // 1) 커서 → 지면 점. 캔버스가 DOM 패널 뒤에 있어도 window 좌표를 쓴다
    const cam = state.camera;
    const rect = gl.domElement.getBoundingClientRect();
    const inside = pointer.seen && pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom;
    cursorWorld.inside = inside;
    if (inside) {
      tmp.ndc.set(((pointer.x - rect.left) / rect.width) * 2 - 1, -((pointer.y - rect.top) / rect.height) * 2 + 1);
      tmp.ray.setFromCamera(tmp.ndc, cam);
      const o = tmp.ray.ray.origin;
      const d = tmp.ray.ray.direction;
      if (d.y < -0.004) {
        const t = -o.y / d.y;
        if (t > 0 && t < 600) lastGround.current.set(o.x + d.x * t, CURSOR_Y, o.z + d.z * t);
      }
    }
    cursorWorld.point.copy(lastGround.current);
    cursorWorld.valid = pointer.seen;
    cursorWorld.hoverRoom = pr.hoveredId;

    const hovered = pr.hoveredId ? pr.layout.placements[pr.hoveredId] : undefined;
    const hovModel = pr.hoveredId ? pr.models[pr.hoveredId] : undefined;
    const myColor = pr.users[pr.viewerId]?.color ?? '#ff8f7a';
    // Room 포커스는 카메라가 훨씬 가까워 같은 월드 크기가 화면에서 몇 배로 커진다: 무리와 입자를 줄여 입자 하나하나가 보이게 한다
    const closeK = pr.focusRoomId ? 0.4 : 1;

    // 2) 슬롯 0: 내 무리
    const me = C[SLOT_ME]!;
    me.active = true;
    me.alpha = 0.95 * gain;
    if (hovered && hovModel) {
      me.mode = 'orbit';
      me.strength = 1;
      me.speed = 1.15;
      capsuleCenter(hovered, me.target, 0.15);
      me.aux.set(totalLength(hovered.dims) / 2 + 0.9, hovered.dims.radius * 0.8, hovered.dims.radius + 1.2);
      wantColor.current[SLOT_ME]!.set(hovModel.color);
    } else {
      me.mode = pointer.down ? 'condense' : 'cohere';
      me.strength = 1;
      me.radius = (pointer.down ? 1.3 : inside ? 3.0 : 3.6) * closeK;
      me.speed = 1;
      me.target.copy(lastGround.current);
      if (!pointer.seen) {
        // 포인터를 아직 못 봤으면 내 캡슐 위를 천천히 돈다
        const first = pr.layout.order[0] ? pr.layout.placements[pr.layout.order[0]] : undefined;
        if (first) {
          me.mode = 'orbit';
          capsuleCenter(first, me.target, 1.8);
          me.aux.set(totalLength(first.dims) * 0.55, 1.0, first.dims.radius * 1.4);
          me.speed = 0.5;
        }
      }
      wantColor.current[SLOT_ME]!.set(myColor);
    }

    // 3) 상대 커서(슬롯 1~2): 캡슐 로컬 좌표로 인코딩돼 있어 시점이 달라도 같은 캡슐 위에 있다
    const remotes = getRemoteCursors().filter((r) => r.userId !== pr.viewerId).slice(0, SLOT_REMOTE.length);
    const canon = Object.keys(pr.layout.placements).sort();
    SLOT_REMOTE.forEach((slot, i) => {
      const r = remotes[i];
      const c = C[slot]!;
      const rp = r ? pr.layout.placements[canon[Math.floor(r.x / 100)] ?? ''] : undefined;
      if (!r || !rp) {
        c.active = false;
        return;
      }
      const lx = r.x - Math.floor(r.x / 100) * 100 - 50;
      localToWorld(rp, lx, r.y, r.z, c.target);
      c.target.y = Math.max(CURSOR_Y, c.target.y);
      c.active = true;
      c.mode = 'cohere';
      c.radius = 2.6 * closeK;
      c.strength = 1;
      c.alpha = 0.85 * Math.max(gain, 0.45);
      wantColor.current[slot]!.set(pr.users[r.userId]?.color ?? '#8fc8ff');
    });

    // 4) Agent 활동 슬롯
    const wanted = new Map<string, { act: string; c: CharacterInput | null; trip: boolean }>();
    if (!pr.replaying) {
      for (const ch of pr.characters ?? []) {
        if (ch.kind === 'human' || !ch.roomId) continue;
        const act = ch.awaitingApproval || ch.activity === 'awaiting' ? 'awaiting' : ch.recalling ? 'recalling' : ch.activity;
        if (act === 'idle') continue;
        wanted.set(ch.id, { act, c: ch, trip: false });
      }
      for (const [id, t] of trips.current) {
        if (now > t.until) trips.current.delete(id);
        else wanted.set(`trip:${id}`, { act: 'trip', c: (pr.characters ?? []).find((x) => x.id === id) ?? null, trip: true });
      }
    }
    for (const [k, slot] of agentSlots.current) {
      if (!wanted.has(k)) {
        agentSlots.current.delete(k);
        C[slot]!.active = false;
      }
    }
    for (const [k, w] of wanted) {
      let slot = agentSlots.current.get(k);
      if (slot === undefined) {
        const taken = new Set<number>([...agentSlots.current.values(), ...scripts.current.flatMap((s) => s.slots)]);
        slot = SLOT_AGENT.find((s) => !taken.has(s));
        if (slot === undefined) continue;
        agentSlots.current.set(k, slot);
      }
      const c = C[slot]!;
      const id = w.trip ? k.slice(5) : k;
      const head = tmp.a;
      if (!getCharacterWorldPosition(id, head, true)) {
        c.active = false;
        continue;
      }
      const room = characterRoomOf(id);
      const pl = room ? pr.layout.placements[room] : undefined;
      const model = room ? pr.models[room] : undefined;
      const col = w.act === 'awaiting' ? ORANGE : w.act === 'paused' ? GREY : (w.c?.color ?? '#ffffff');
      c.active = true;
      c.strength = 1;
      c.alpha = 0.95;
      wantColor.current[slot]!.set(col);
      c.target.copy(head);
      switch (w.act) {
        case 'thinking':
          c.mode = 'vortex';
          c.radius = 1.1;
          c.speed = 1.3;
          c.aux.set(0, 2.0, 0);
          break;
        case 'recalling':
          c.mode = 'flow';
          c.radius = 0.7;
          c.speed = 2;
          if (pl && model) interiorAnchor(model, pl, 'shelf', c.aux);
          else c.aux.copy(head).add(tmp.b.set(2, 0, 0));
          break;
        case 'drafting':
        case 'talking': {
          c.mode = 'flow';
          c.radius = 0.7;
          c.speed = 2;
          const targetPos = tmp.b;
          const tid = w.c?.targetCharId;
          if (w.act === 'talking' && tid && getCharacterWorldPosition(tid, targetPos, true)) {
            c.aux.copy(head);
            c.target.copy(targetPos);
          } else if (pl && model) {
            c.aux.copy(head);
            interiorAnchor(model, pl, 'board', c.target);
          }
          break;
        }
        case 'awaiting':
          c.mode = 'condense';
          c.radius = 0.6 + 0.22 * Math.sin(now * 0.007);
          c.target.y += 0.3;
          break;
        case 'paused':
          c.mode = 'settle';
          c.alpha = 0.5;
          break;
        default:
          c.mode = 'cohere';
          c.radius = 1.1;
          break;
      }
    }

    // 5) 장면 스크립트(FX 슬롯): 쓰이지 않은 슬롯은 비활성
    const claimed = new Set<number>();
    scripts.current = scripts.current.filter((s) => now - s.t0 < s.dur);
    for (const s of scripts.current) {
      for (const x of s.slots) claimed.add(x);
      s.run(clamp01((now - s.t0) / s.dur), now, C, s.slots);
    }
    for (const slot of SLOT_FX) if (!claimed.has(slot)) C[slot]!.active = false;
    for (const slot of SLOT_AGENT) if (!claimed.has(slot) && ![...agentSlots.current.values()].includes(slot)) C[slot]!.active = false;

    // 6) 색 보간 + uniform 반영
    const k = 1 - Math.exp(-dt * 9);
    for (let i = 0; i < GROUPS; i++) {
      sim.colors[i]!.lerp(wantColor.current[i]!, k);
      sim.setGroup(i, C[i]!);
    }
    const fovRad = THREE.MathUtils.degToRad((cam as THREE.PerspectiveCamera).fov);
    const px = (state.size.height * state.viewport.dpr) / (2 * Math.tan(fovRad / 2));
    sim.setDensityScale(pr.focusRoomId ? 0.3 : 1);
    sim.setPointSize((side >= 200 ? 0.2 : side >= 120 ? 0.25 : 0.36) * (pr.focusRoomId ? 0.45 : 1));
    sim.step(dt, state.clock.elapsedTime, px, state.size.width / Math.max(1, state.size.height));

    // 7) 내 커서를 상대에게 알린다(20Hz 상한). 가장 가까운 캡슐 기준 로컬 좌표로 보낸다
    if (pr.onCursor && inside && now - lastSend.current.t > 50) {
      const g = lastGround.current;
      if (Math.abs(g.x - lastSend.current.x) + Math.abs(g.z - lastSend.current.z) > 0.05 || now - lastSend.current.t > 500) {
        let best = -1;
        let bestD = Infinity;
        canon.forEach((id, i) => {
          const p = pr.layout.placements[id]!;
          const d = Math.hypot(p.x - g.x, p.z - g.z);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
        if (best >= 0) {
          const p = pr.layout.placements[canon[best]!]!;
          const [lx, lz] = worldToLocal(p, g.x, g.z);
          const cl = (n: number) => Math.max(-45, Math.min(45, n));
          pr.onCursor({ x: best * 100 + cl(lx) + 50, y: hovered ? 1.2 : 0.3, z: cl(lz) });
          lastSend.current = { t: now, x: g.x, z: g.z };
        }
      }
    }
  });

  if (!sim) return null;
  return <primitive object={sim.points} />;
}

