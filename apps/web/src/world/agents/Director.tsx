import { Suspense, createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { PALETTE } from '@ensemble/shared';
import type { WorldLayout } from '../layout';
import { TUBE_Y } from '../GlassTube';
import { glowTexture } from '../capsule/glow';
import { bottomPlane, createSpriteMaterial, useCharacterTextures } from './AgentSprite';
import { CharacterCtx, type CharacterCtxValue } from './RoomCharacters';
import { emitCharacterEvent, registerCharacter } from './registry';
import type { CharacterInput, WorldCharacters } from './types';

const EXIT_MS = 950;
const EMPTY_LIST: readonly CharacterInput[] = [];

/** 튜브를 따라가는 경로(폴리라인). 구간 사이는 캡슐 안을 직선으로 잇는다 */
interface PathData {
  pts: THREE.Vector3[];
  cum: number[];
  length: number;
  rooms: string[];
}

function samplePath(path: PathData, u: number, out: THREE.Vector3): THREE.Vector3 {
  const d = THREE.MathUtils.clamp(u, 0, 1) * path.length;
  let lo = 0;
  let hi = path.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (path.cum[mid]! <= d) lo = mid;
    else hi = mid;
  }
  const a = path.pts[lo]!;
  const b = path.pts[Math.min(lo + 1, path.pts.length - 1)]!;
  const seg = Math.max(path.cum[Math.min(lo + 1, path.cum.length - 1)]! - path.cum[lo]!, 1e-6);
  return out.copy(a).lerp(b, (d - path.cum[lo]!) / seg);
}

function bfs(layout: WorldLayout, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const adj = new Map<string, string[]>();
  for (const t of layout.tubes) {
    (adj.get(t.from) ?? adj.set(t.from, []).get(t.from)!).push(t.to);
    (adj.get(t.to) ?? adj.set(t.to, []).get(t.to)!).push(t.from);
  }
  const prev = new Map<string, string>([[from, '']]);
  const q = [from];
  while (q.length) {
    const u = q.shift()!;
    for (const v of adj.get(u) ?? []) {
      if (prev.has(v)) continue;
      prev.set(v, u);
      if (v === to) {
        const out = [v];
        let c = u;
        while (c) {
          out.unshift(c);
          c = prev.get(c)!;
        }
        return out;
      }
      q.push(v);
    }
  }
  return null;
}

function buildPath(layout: WorldLayout, curves: ReadonlyMap<string, THREE.Curve<THREE.Vector3>>, from: string, to: string): PathData | null {
  const rooms = bfs(layout, from, to) ?? [from, to];
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i + 1 < rooms.length; i++) {
    const u = rooms[i]!;
    const v = rooms[i + 1]!;
    const fwd = curves.get(`${u}>${v}`);
    const rev = curves.get(`${v}>${u}`);
    let seg: THREE.Vector3[] | null = null;
    if (fwd) seg = fwd.getSpacedPoints(48);
    else if (rev) seg = rev.getSpacedPoints(48).reverse();
    if (!seg) {
      const a = layout.placements[u];
      const b = layout.placements[v];
      if (!a || !b) return null;
      seg = [new THREE.Vector3(a.x, TUBE_Y, a.z), new THREE.Vector3(b.x, TUBE_Y, b.z)];
    }
    for (const p of seg) pts.push(p.clone());
  }
  if (pts.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + pts[i]!.distanceTo(pts[i - 1]!));
  return { pts, cum, length: cum[cum.length - 1]!, rooms };
}

/** 방 안의 로컬 x 부호: other 캡슐이 me 캡슐의 어느 쪽(좌/우)에 있는가 → 그쪽 끝에 문이 있다 */
function doorSide(layout: WorldLayout, me: string, other: string | null | undefined): -1 | 1 {
  const a = layout.placements[me];
  const b = other ? layout.placements[other] : undefined;
  if (!a || !b) return 1;
  const c = Math.cos(-a.rotY);
  const s = Math.sin(-a.rotY);
  const lx = (b.x - a.x) * c + (b.z - a.z) * s;
  return lx < 0 ? -1 : 1;
}

interface Trip {
  id: string;
  char: CharacterInput;
  from: string;
  to: string | null;
  startAt: number;
  arrived: boolean;
  progress: number;
  started: boolean;
  path: PathData | null;
  pathKey: string;
}

/**
 * 캐릭터 연출 감독. 논리 위치(CharacterInput.roomId)가 캡슐 A → (null: 이동 중) → 캡슐 B로 바뀌면
 * A에서 문으로 나가고(퇴장 모션) → 튜브를 따라 실제로 지나가고 → B의 문으로 들어온다(등장 모션).
 * 도착 신호가 먼저 와도 이동 연출은 끝까지 재생하고, 아직 도착 전이면 튜브 안에서 기다린다.
 * `agent_departed/arrived/returned`가 가는 대로 `agent_returned`(방문처 → 집)도 같은 튜브를 되짚어 간다.
 */
export function CharacterDirector({
  input,
  layout,
  curves,
  reducedMotion,
  focusRoomId,
  children,
}: {
  input: WorldCharacters | undefined;
  layout: WorldLayout;
  curves: ReadonlyMap<string, THREE.Curve<THREE.Vector3>>;
  reducedMotion: boolean;
  focusRoomId?: string | null;
  children: ReactNode;
}) {
  const chars = input?.characters ?? EMPTY_LIST;
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const shownRoom = useRef(new Map<string, string | null>()).current;
  const trips = useRef(new Map<string, Trip>()).current;
  const doors = useRef<Record<string, -1 | 1>>({}).current;
  // 서버가 준 방문 이동(travel): 본 seq 기록, 첫 스냅샷 여부, 마지막 입력(호스트 쪽 복귀 연출용), 유령(입력에서 사라진 뒤 돌아가는 중) 목록
  const travelSeen = useRef(new Map<string, number>()).current;
  const baselined = useRef(false);
  const lastChar = useRef(new Map<string, CharacterInput>()).current;
  const ghosts = useRef(new Set<string>()).current;

  useEffect(() => {
    const now = performance.now();
    const alive = new Set(chars.map((c) => c.id));
    let changed = false;
    const mk = (c: CharacterInput, from: string, to: string | null, startAt: number, arrived: boolean): Trip => ({ id: c.id, char: c, from, to, startAt, arrived, progress: 0, started: false, path: null, pathKey: '' });
    for (const id of [...shownRoom.keys()]) {
      if (!alive.has(id)) {
        if (ghosts.has(id) && trips.has(id)) continue;
        const lc = lastChar.get(id);
        const tv = lc?.travel;
        // 호스트 쪽 복귀: 방문 Agent 칩이 사라지면(visiting→accompanied) 직전 travel을 역방향으로 한 번 재생한다
        if (baselined.current && lc && lc.visiting && tv && shownRoom.get(id) === tv.toRoomId && !trips.has(id)) {
          const ghost: CharacterInput = { ...lc, roomId: null, destRoomId: tv.fromRoomId };
          trips.set(id, mk(ghost, tv.toRoomId, tv.fromRoomId, now, true));
          doors[id] = doorSide(layout, tv.toRoomId, tv.fromRoomId);
          ghosts.add(id);
          shownRoom.set(id, null);
          lastChar.delete(id);
          changed = true;
          continue;
        }
        shownRoom.delete(id);
        lastChar.delete(id);
        if (trips.delete(id)) emitCharacterEvent({ type: 'trip_end', id, fromRoomId: null, toRoomId: null });
        changed = true;
      }
    }
    for (const c of chars) {
      if (c.kind === 'human') {
        if (shownRoom.get(c.id) !== c.roomId) {
          shownRoom.set(c.id, c.roomId);
          changed = true;
        }
        continue;
      }
      const prev = shownRoom.has(c.id) ? shownRoom.get(c.id) : undefined;
      const trip = trips.get(c.id);
      lastChar.set(c.id, c);
      // travel.seq가 바뀌면 {from,to} 튜브 이동을 1회 재생한다. 첫 스냅샷에 이미 있던 travel은 도착 상태로 둔다
      const tv = c.travel;
      let explicit = false;
      if (tv && travelSeen.get(c.id) !== tv.seq) {
        travelSeen.set(c.id, tv.seq);
        explicit = baselined.current && !trip;
      }
      if (explicit && tv && c.roomId === tv.toRoomId && (prev === undefined || prev === c.roomId)) {
        trips.set(c.id, mk(c, tv.fromRoomId, tv.toRoomId, reducedMotion ? now : now + 250, true));
        doors[c.id] = doorSide(layout, tv.toRoomId, tv.fromRoomId);
        shownRoom.set(c.id, null);
        changed = true;
        continue;
      }
      if (trip) {
        trip.char = c;
        if (c.roomId === null) {
          if (c.destRoomId) trip.to = c.destRoomId;
        } else {
          trip.arrived = true;
          trip.to = c.roomId;
        }
        changed = true;
        continue;
      }
      if (prev === undefined) {
        if (c.roomId === null) {
          const from = c.homeRoomId ?? null;
          if (from) {
            trips.set(c.id, { id: c.id, char: c, from, to: c.destRoomId ?? null, startAt: now, arrived: false, progress: 0, started: false, path: null, pathKey: '' });
            shownRoom.set(c.id, null);
          }
        } else shownRoom.set(c.id, c.roomId);
        changed = true;
      } else if (prev !== null && c.roomId !== prev) {
        const to = c.roomId ?? c.destRoomId ?? null;
        trips.set(c.id, { id: c.id, char: c, from: prev, to, startAt: reducedMotion ? now : now + EXIT_MS, arrived: c.roomId !== null, progress: 0, started: false, path: null, pathKey: '' });
        doors[c.id] = doorSide(layout, prev, to);
        shownRoom.set(c.id, null);
        changed = true;
      } else if (prev === null && c.roomId) {
        shownRoom.set(c.id, c.roomId);
        changed = true;
      }
    }
    if (chars.length > 0) baselined.current = true;
    if (changed) bump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chars, layout, reducedMotion]);

  const byRoom = useMemo(() => {
    const out: Record<string, CharacterInput[]> = {};
    for (const c of chars) {
      if (trips.has(c.id)) continue;
      const room = c.kind === 'human' ? c.roomId : shownRoom.has(c.id) ? shownRoom.get(c.id)! : c.roomId;
      if (!room) continue;
      (out[room] ??= []).push(c);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chars, version]);

  const value = useMemo<CharacterCtxValue>(
    () => ({ byRoom, doors: { ...doors }, replaying: !!input?.replaying, reducedMotion, focusRoomId: focusRoomId ?? null }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byRoom, input?.replaying, reducedMotion, version, focusRoomId],
  );

  const finish = (t: Trip) => {
    trips.delete(t.id);
    if (ghosts.delete(t.id)) {
      shownRoom.delete(t.id);
      emitCharacterEvent({ type: 'trip_end', id: t.id, fromRoomId: t.from, toRoomId: t.to });
      bump();
      return;
    }
    if (t.to) {
      shownRoom.set(t.id, t.to);
      doors[t.id] = doorSide(layout, t.to, t.path?.rooms[t.path.rooms.length - 2] ?? t.from);
    }
    emitCharacterEvent({ type: 'trip_end', id: t.id, fromRoomId: t.from, toRoomId: t.to });
    bump();
  };

  const list = [...trips.values()];
  const orbs: OrbsCtxValue = { list, layout, curves, reducedMotion, onDone: finish };
  return (
    <CharacterCtx.Provider value={value}>
      <OrbsCtx.Provider value={orbs}>{children}</OrbsCtx.Provider>
    </CharacterCtx.Provider>
  );
}

interface OrbsCtxValue {
  list: Trip[];
  layout: WorldLayout;
  curves: ReadonlyMap<string, THREE.Curve<THREE.Vector3>>;
  reducedMotion: boolean;
  onDone: (t: Trip) => void;
}
const OrbsCtx = createContext<OrbsCtxValue | null>(null);

/**
 * 튜브 속을 지나가는 Agent. 유리(투과) 버퍼 안에 있어야 튜브 앞면에 가려지지 않으므로
 * 반드시 GlassBufferProvider 안쪽에 둔다.
 */
export function TripOrbs() {
  const v = useContext(OrbsCtx);
  if (!v) return null;
  return (
    <Suspense fallback={null}>
      {v.list.map((t) => (
        <TripOrb key={t.id} trip={t} layout={v.layout} curves={v.curves} reducedMotion={v.reducedMotion} onDone={v.onDone} />
      ))}
    </Suspense>
  );
}

const ORB_S = 1.7;
const ORB_GEO = bottomPlane(ORB_S, ORB_S, 0.14);
const TRAIL = 6;

function TripOrb({
  trip,
  layout,
  curves,
  reducedMotion,
  onDone,
}: {
  trip: Trip;
  layout: WorldLayout;
  curves: ReadonlyMap<string, THREE.Curve<THREE.Vector3>>;
  reducedMotion: boolean;
  onDone: (t: Trip) => void;
}) {
  const tex = useCharacterTextures();
  const isRoom = trip.char.kind === 'room_agent';
  const mat = useMemo(() => {
    const m = createSpriteMaterial(isRoom ? tex.lime : tex.body);
    m.depthTest = false;
    return m;
  }, [tex, isRoom]);
  const color = useMemo(() => new THREE.Color(trip.char.color), [trip.char.color]);
  const group = useRef<THREE.Group>(null);
  const body = useRef<THREE.Mesh>(null);
  const glow = useRef<THREE.Sprite>(null);
  const trail = useRef<THREE.Group>(null);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const hist = useRef<THREE.Vector3[]>([]);
  const glowMat = useMemo(
    () => new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
    [color],
  );
  useEffect(
    () => () => {
      mat.dispose();
      glowMat.dispose();
    },
    [mat, glowMat],
  );
  useEffect(() => {
    if (!group.current) return;
    return registerCharacter(trip.id, group.current, 0.45, null);
  }, [trip.id]);
  const done = useRef(false);

  useFrame((state, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const g = group.current;
    if (!g) return;
    const now = performance.now();
    if (now < trip.startAt) {
      g.visible = false;
      return;
    }
    // 목적지가 정해지면(또는 바뀌면) 경로를 만든다
    const dest = trip.to ?? guessDest(layout, trip.from, trip.char);
    const key = `${trip.from}>${dest}`;
    if (dest && trip.pathKey !== key) {
      const keepU = trip.path ? trip.progress : 0;
      trip.path = buildPath(layout, curves, trip.from, dest);
      trip.pathKey = key;
      trip.progress = Math.min(keepU, 0.4);
    }
    if (!trip.started) {
      trip.started = true;
      emitCharacterEvent({ type: 'trip_start', id: trip.id, fromRoomId: trip.from, toRoomId: trip.to });
    }
    const path = trip.path;
    if (!path) {
      if (trip.arrived && !done.current) {
        done.current = true;
        onDone(trip);
      }
      g.visible = false;
      return;
    }
    const dur = reducedMotion ? 0.4 : THREE.MathUtils.clamp(path.length / 8, 2.2, 6);
    const cap = trip.arrived ? 1 : 0.84;
    trip.progress = Math.min(cap, trip.progress + dt / dur);
    g.visible = true;
    samplePath(path, trip.progress, tmp);
    const wait = !trip.arrived && trip.progress >= cap - 1e-3;
    const bob = wait ? Math.sin(state.clock.elapsedTime * 3) * 0.05 : 0;
    g.position.set(tmp.x, tmp.y - 0.3 + bob, tmp.z);
    // 카메라를 향하는 빌보드
    const cam = state.camera.position;
    if (body.current) {
      body.current.rotation.y = Math.atan2(cam.x - tmp.x, cam.z - tmp.z);
      const pulse = 1 + Math.sin(state.clock.elapsedTime * 7) * 0.04;
      body.current.scale.setScalar(pulse);
      body.current.position.y = 0;
    }
    const u = mat.u;
    u.uTime.value = state.clock.elapsedTime;
    u.uTint.value.copy(color);
    u.uTintAmt.value = isRoom ? 0 : 0.88;
    u.uLight.value = 1.15;
    u.uRimAmt.value = 0.8;
    u.uRim.value.copy(color).lerp(new THREE.Color('#fff'), 0.5);
    u.uFaceOn.value = 1;
    u.uFaceCenter.value.set(0.5, 0.5);
    u.uFaceScale.value = 0.17;
    u.uSquint.value = 0.25;
    u.uMouth.value = 0;
    u.uLook.value.set(0.7, 0);
    if (glow.current) glow.current.position.set(0, 0.7, 0);
    // 꼬리: 지나간 자리에 빛이 남는다
    const h = hist.current;
    h.unshift(new THREE.Vector3(tmp.x, tmp.y + 0.3, tmp.z));
    if (h.length > TRAIL * 3) h.pop();
    if (trail.current) {
      trail.current.children.forEach((c, i) => {
        const p = h[Math.min(h.length - 1, (i + 1) * 3)];
        if (p) c.position.set(p.x - tmp.x, p.y, p.z - tmp.z);
        const m = (c as THREE.Sprite).material as THREE.SpriteMaterial;
        m.opacity = Math.max(0, 0.55 - i * 0.09);
        c.scale.setScalar(0.4 - i * 0.04);
      });
    }
    if (trip.arrived && trip.progress >= 1 && !done.current) {
      done.current = true;
      onDone(trip);
    }
  });

  const trailMats = useMemo(() => Array.from({ length: TRAIL }, () => glowMat.clone()), []);
  useEffect(() => () => trailMats.forEach((m) => m.dispose()), [trailMats]);

  return (
    <group ref={group} visible={false}>

      <mesh ref={body} geometry={ORB_GEO} material={mat} renderOrder={8} />
      <sprite ref={glow} scale={[3.4, 3.4, 1]} material={glowMat} renderOrder={7} />
      <group ref={trail}>
        {Array.from({ length: TRAIL }, (_, i) => (
          <sprite key={i} material={trailMats[i]} scale={[0.3, 0.3, 1]} renderOrder={7} />
        ))}
      </group>
    </group>
  );
}

/** 목적지를 모를 때: 출발 캡슐에서 튜브로 이어진 다른 사람의 My Room(없으면 첫 이웃) */
function guessDest(layout: WorldLayout, from: string, c: CharacterInput): string | null {
  const nb: string[] = [];
  for (const t of layout.tubes) {
    if (t.from === from) nb.push(t.to);
    else if (t.to === from) nb.push(t.from);
  }
  void c;
  void PALETTE;
  return nb[0] ?? null;
}
