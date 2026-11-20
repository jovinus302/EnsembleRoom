import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PALETTE } from '@ensemble/shared';
import { glowTexture } from '../capsule/glow';
import {
  ATLAS_URL,
  YAW_FRAMES,
  atlasFrameUv,
  bottomPlane,
  createSpriteMaterial,
  topPlane,
  useCharacterTextures,
} from './AgentSprite';
import { Bubble, NameTag, dashedRingTexture, type BubbleSpec } from './labels';
import { registerCharacter, emitCharacterEvent } from './registry';
import type { RoomPlan, Spot } from './plan';
import type { CharacterInput } from './types';

void ATLAS_URL;
const ORANGE = new THREE.Color(PALETTE.approvalOrange);
const INK = '#2b2118';

export const AGENT_H = 0.86;
/** 캡슐 안에서 한눈에 보이도록 인물 전체를 키운다 */
const CHAR_SCALE = 1.3;
export const PAWN_H = 0.82;

export interface ActorRuntime {
  /** 모든 Actor의 현재 로컬 위치 (시선·말하기 대상 조회) */
  positions: Map<string, THREE.Vector3>;
  plan: RoomPlan;
  /** 조명 단계에서 온 실내 밝기(0.45~1) */
  light: { current: number };
  quality: 'high' | 'mid' | 'low';
  replaying: boolean;
  reducedMotion: boolean;
  doorFor: (side: -1 | 1) => Spot;
  roomId: string;
}

// ------------------------------------------------------------------ 공용 부품

let pawnGeo: THREE.BufferGeometry | null = null;
function pawnGeometry(): THREE.BufferGeometry {
  if (pawnGeo) return pawnGeo;
  const pts: THREE.Vector2[] = [];
  const prof: [number, number][] = [
    [0.0, 0.0], [0.2, 0.0], [0.215, 0.03], [0.17, 0.07], [0.1, 0.16], [0.085, 0.3], [0.1, 0.36], [0.17, 0.38], [0.1, 0.42], [0.085, 0.47],
  ];
  for (const [r, y] of prof) pts.push(new THREE.Vector2(r, y));
  const body = new THREE.LatheGeometry(pts, 28);
  const head = new THREE.SphereGeometry(0.155, 24, 18);
  head.translate(0, 0.6, 0);
  pawnGeo = mergeGeometries([body, head]) ?? body;
  return pawnGeo;
}
let ringGeoCache: THREE.RingGeometry | null = null;
const ringGeo = () => (ringGeoCache ??= new THREE.RingGeometry(0.3, 0.37, 40).rotateX(-Math.PI / 2));
let discGeoCache: THREE.CircleGeometry | null = null;
const discGeo = () => (discGeoCache ??= new THREE.CircleGeometry(0.42, 28).rotateX(-Math.PI / 2));
let diamondGeoCache: THREE.OctahedronGeometry | null = null;
const diamondGeo = () => (diamondGeoCache ??= new THREE.OctahedronGeometry(0.13, 0).scale(1, 1.5, 1));
const armGeo = () => ARM_GEO;
const ARM_GEO = topPlane(0.2, 0.26);
const EGG_S = 1.36;
const GHOST_S = 1.18;
const EGG_GEO = bottomPlane(EGG_S, EGG_S, 0.14);
const GHOST_GEO = bottomPlane(GHOST_S, GHOST_S, 0.14);
const CARD_GEO = new THREE.PlaneGeometry(0.34, 0.24);

// ------------------------------------------------------------------ 입자 (생각 소용돌이 / 기억 / 가라앉음 / 반짝임)

type ParticleMode = 'none' | 'think' | 'recall' | 'sink' | 'sparkle' | 'owner';
const NP = 22;

function Particles({ color, mode, from, to, enabled }: { color: THREE.Color; mode: React.RefObject<ParticleMode>; from: React.RefObject<THREE.Vector3>; to: React.RefObject<THREE.Vector3>; enabled: boolean }) {
  const pts = useRef<THREE.Points>(null);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NP * 3), 3));
    return g;
  }, []);
  const seeds = useMemo(() => Array.from({ length: NP }, (_, i) => ({ a: (i / NP) * Math.PI * 2, r: 0.12 + ((i * 37) % 10) / 60, ph: (i * 0.37) % 1 })), []);
  const mat = useMemo(
    () =>
      new THREE.PointsMaterial({ map: glowTexture(), size: 0.17, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0, color }),
    [color],
  );
  useEffect(
    () => () => {
      geo.dispose();
      mat.dispose();
    },
    [geo, mat],
  );
  useFrame((state) => {
    const p = pts.current;
    if (!p) return;
    const m = mode.current ?? 'none';
    mat.opacity = THREE.MathUtils.damp(mat.opacity, m === 'none' ? 0 : 0.95, 8, 1 / 60);
    p.visible = mat.opacity > 0.02;
    if (!p.visible) return;
    const t = state.clock.elapsedTime;
    const arr = geo.getAttribute('position') as THREE.BufferAttribute;
    const f = from.current!;
    const dst = to.current!;
    for (let i = 0; i < NP; i++) {
      const s = seeds[i]!;
      let x = 0;
      let y = 0;
      let z = 0;
      if (m === 'think') {
        const a = s.a + t * 2.4;
        x = Math.cos(a) * (0.22 + s.r);
        z = Math.sin(a) * (0.22 + s.r);
        y = AGENT_H + 0.12 + Math.sin(t * 3 + s.a * 3) * 0.06 + s.ph * 0.18;
      } else if (m === 'recall') {
        const u = (t * 0.7 + s.ph) % 1;
        x = THREE.MathUtils.lerp(f.x, dst.x, u) + Math.sin(u * 9 + s.a) * 0.12 * (1 - u);
        y = THREE.MathUtils.lerp(f.y, dst.y, u) + Math.sin(u * Math.PI) * 0.35;
        z = THREE.MathUtils.lerp(f.z, dst.z, u) + Math.cos(u * 9 + s.a) * 0.12 * (1 - u);
      } else if (m === 'sink') {
        const u = (t * 0.35 + s.ph) % 1;
        x = Math.cos(s.a) * s.r * 2.2;
        z = Math.sin(s.a) * s.r * 2.2;
        y = AGENT_H * 0.9 * (1 - u);
      } else if (m === 'owner') {
        const u = (t * 0.8 + s.ph) % 1;
        x = THREE.MathUtils.lerp(0, dst.x, u) + Math.sin(u * 8 + s.a) * 0.1;
        y = 0.5 + Math.sin(u * Math.PI) * 0.4;
        z = THREE.MathUtils.lerp(0, dst.z, u) + Math.cos(u * 8 + s.a) * 0.1;
      } else {
        const u = (t * 1.1 + s.ph) % 1;
        x = Math.cos(s.a * 3) * u * 0.7;
        z = Math.sin(s.a * 3) * u * 0.7;
        y = 0.4 + u * 0.9;
      }
      arr.setXYZ(i, x, y, z);
    }
    arr.needsUpdate = true;
  });
  if (!enabled) return null;
  return <points ref={pts} geometry={geo} material={mat} frustumCulled={false} renderOrder={20} />;
}

// ------------------------------------------------------------------ Actor

export interface ActorProps {
  char: CharacterInput;
  rt: ActorRuntime;
  /** 퇴장 중(사라지는 모션) */
  leaving: boolean;
  /** 등장 시 문 쪽 */
  enterSide: -1 | 1;
  leaveSide: -1 | 1;
}

const smooth = THREE.MathUtils.smoothstep;
const damp = THREE.MathUtils.damp;

/**
 * 캐릭터 하나. 사람은 무광 말(pawn), Personal Agent는 알형 스프라이트(소유자 색 틴트 + 팔), Room Agent는 유령형(yaw 아틀라스).
 * 상태 → 모션 1:1 (계획 8.5): idle/thinking/recalling/drafting(보드 앞)/talking(대상 쪽)/awaiting/paused, 모드별 표식.
 */
export function Actor({ char, rt, leaving, enterSide, leaveSide }: ActorProps) {
  const tex = useCharacterTextures();
  const isHuman = char.kind === 'human';
  const isRoom = char.kind === 'room_agent';
  const full = char.detail === 'full';
  const color = useMemo(() => new THREE.Color(char.color), [char.color]);
  const home = rt.plan.home.get(char.id) ?? { x: 0, z: 0.4, yaw: 0 };
  const boardSpot = rt.plan.board.get(char.id) ?? home;

  const root = useRef<THREE.Group>(null);
  const bill = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const diamond = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const dash = useRef<THREE.Mesh>(null);
  const cardRef = useRef<THREE.Mesh>(null);
  const silhouette = useRef<THREE.Mesh>(null);

  const bodyMat = useMemo(() => createSpriteMaterial(isRoom ? tex.atlas : tex.body), [tex, isRoom]);
  const armMat = useMemo(() => createSpriteMaterial(tex.arm), [tex]);
  const pawnMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: char.color, roughness: 0.86, metalness: 0, emissive: char.color, emissiveIntensity: 0.22 }),
    [char.color],
  );
  const ringMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: char.color, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
    [char.color],
  );
  const meRingMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
    [],
  );
  const shadowMat = useMemo(
    () => new THREE.MeshBasicMaterial({ map: glowTexture(), color: '#140a04', transparent: true, opacity: 0.55, depthWrite: false }),
    [],
  );
  const diamondMat = useMemo(() => new THREE.MeshBasicMaterial({ color: ORANGE.clone().multiplyScalar(2.2), toneMapped: false }), []);
  const dashMat = useMemo(
    () => new THREE.MeshBasicMaterial({ map: dashedRingTexture(), color: char.color, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
    [char.color],
  );
  const cardMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#fff6e0', side: THREE.DoubleSide }), []);
  const silMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: char.color, transparent: true, opacity: 0.28, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending }),
    [char.color],
  );
  useEffect(
    () => () => {
      [bodyMat, armMat, pawnMat, ringMat, meRingMat, shadowMat, diamondMat, dashMat, cardMat, silMat].forEach((m) => m.dispose());
    },
    [bodyMat, armMat, pawnMat, ringMat, meRingMat, shadowMat, diamondMat, dashMat, cardMat, silMat],
  );

  // 입자 상태
  const pMode = useRef<ParticleMode>('none');
  const pFrom = useRef(new THREE.Vector3());
  const pTo = useRef(new THREE.Vector3());

  // 런타임 상태
  const st = useRef({
    x: 0,
    z: 0,
    yaw: home.yaw,
    born: -1,
    leaveT: -1,
    blink: 0,
    nextBlink: 1.5 + Math.random() * 2,
    cueSeq: char.cue?.seq ?? -1,
    cueKind: '' as string,
    cueT: -99,
    prevX: 0,
    prevZ: 0,
    speed: 0,
    inited: false,
    mouth: 0,
    look: new THREE.Vector2(),
    faceYaw: home.yaw,
    gazeRel: 0,
    jumpY: 0,
    holdUntil: 0,
  });
  const temp = useMemo(() => ({ v: new THREE.Vector3(), cam: new THREE.Vector3(), q: new THREE.Vector4() }), []);

  const unregister = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!root.current) return;
    unregister.current = registerCharacter(char.id, root.current, isHuman ? PAWN_H : AGENT_H, rt.roomId);
    emitCharacterEvent({ type: 'spawn', id: char.id, roomId: rt.roomId, kind: char.kind });
    const id = char.id;
    const roomId = rt.roomId;
    const kind = char.kind;
    return () => {
      unregister.current?.();
      emitCharacterEvent({ type: 'despawn', id, roomId, kind });
      rt.positions.delete(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [char.id, rt.roomId]);

  const writing = !isHuman && (char.activity === 'drafting' || char.speech?.phase === 'writing' || char.speech?.phase === 'acting');
  const paused = char.activity === 'paused';

  useFrame((state, dtRaw) => {
    const r = root.current;
    if (!r) return;
    const dt = Math.min(dtRaw, 0.05);
    const s = st.current;
    const t = state.clock.elapsedTime;
    const door = rt.doorFor(leaving ? leaveSide : enterSide);

    if (!s.inited) {
      s.inited = true;
      s.x = door.x;
      s.z = door.z;
      s.born = t;
      s.prevX = s.x;
      s.prevZ = s.z;
    }
    if (leaving && s.leaveT < 0) s.leaveT = t;

    // ---- 목표 위치 ----
    let tx = home.x;
    let tz = home.z;
    if (leaving) {
      tx = door.x;
      tz = door.z;
    } else if (writing && !char.awaitingApproval) {
      tx = boardSpot.x;
      tz = boardSpot.z;
    }
    const lam = rt.reducedMotion ? 9 : 2.8;
    s.x = damp(s.x, tx, lam, dt);
    s.z = damp(s.z, tz, lam, dt);
    const mv = Math.hypot(s.x - s.prevX, s.z - s.prevZ) / Math.max(dt, 1e-4);
    s.speed = damp(s.speed, mv, 10, dt);
    s.prevX = s.x;
    s.prevZ = s.z;

    // ---- 바라볼 방향 ----
    const look = temp.v;
    let hasLook = false;
    const tgt = char.targetCharId ? rt.positions.get(char.targetCharId) : undefined;
    if (writing && !leaving) {
      look.set(rt.plan.boardCenter.x, 0, rt.plan.boardCenter.z);
      hasLook = true;
    } else if (char.recalling && !leaving) {
      look.set(rt.plan.shelf.x, 0, rt.plan.shelf.z);
      hasLook = true;
    } else if (tgt && (char.activity === 'talking' || char.activity === 'awaiting' || char.activity === 'idle')) {
      look.set(tgt.x, 0, tgt.z);
      hasLook = true;
    } else if (leaving || s.speed > 0.15) {
      look.set(tx, 0, tz);
      hasLook = Math.hypot(tx - s.x, tz - s.z) > 0.05;
    }
    let wantYaw = home.yaw;
    if (hasLook) {
      const dx = look.x - s.x;
      const dz = look.z - s.z;
      if (Math.hypot(dx, dz) > 0.05) wantYaw = Math.atan2(dx, dz);
    }
    // 시선(gaze)은 실제 대상 방향, 몸은 관객(카메라) 쪽으로 어느 정도 돌려 얼굴이 보이게 한다
    const gazeYaw = wantYaw;
    {
      const g0 = r.parent as THREE.Object3D;
      temp.cam.copy(state.camera.position);
      g0.worldToLocal(temp.cam);
      const cy0 = Math.atan2(temp.cam.x - s.x, temp.cam.z - s.z);
      if (!isHuman && !leaving) {
        const dd = Math.atan2(Math.sin(cy0 - wantYaw), Math.cos(cy0 - wantYaw));
        wantYaw += dd * (writing || char.recalling ? 0.3 : 0.62);
      }
      s.gazeRel = gazeYaw - cy0;
    }
    let dy = wantYaw - s.faceYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    s.faceYaw += dy * Math.min(1, dt * (rt.reducedMotion ? 14 : 6));

    // ---- 카메라 기준 빌보드 ----
    const grp = r.parent as THREE.Object3D;
    temp.cam.copy(state.camera.position);
    grp.worldToLocal(temp.cam);
    const camYaw = Math.atan2(temp.cam.x - s.x, temp.cam.z - s.z);
    if (bill.current) bill.current.rotation.y = camYaw;
    const rel = s.faceYaw - camYaw;
    const cosRel = Math.cos(rel);
    const sinRel = Math.sin(rel);

    // ---- 등장·퇴장 ----
    const age = t - s.born;
    let appear = smooth(age, 0, 0.8);
    if (leaving) appear = Math.min(appear, 1 - smooth(t - s.leaveT, 0, 0.85));
    if (rt.reducedMotion) appear = leaving ? 0 : 1;

    // ---- 큐(일회성 연출) ----
    if (char.cue && char.cue.seq !== s.cueSeq) {
      s.cueSeq = char.cue.seq;
      if (!rt.replaying) {
        s.cueKind = char.cue.kind;
        s.cueT = t;
        emitCharacterEvent({ type: 'cue', id: char.id, roomId: rt.roomId, cue: char.cue.kind });
        if (char.cue.kind === 'hold_card' || char.cue.kind === 'present_cards') s.holdUntil = t + 4.5;
      }
    }
    const cueAge = t - s.cueT;
    const cueKind = s.cueKind;
    let hop = 0;
    let nod = 0;
    let shake = 0;
    let flash = 0;
    let sparkle = false;
    if (cueAge >= 0 && cueAge < 1.6) {
      if (cueKind === 'nod' && cueAge < 0.7) nod = Math.sin((cueAge / 0.7) * Math.PI * 2) * 0.5;
      if (cueKind === 'jump' && cueAge < 0.7) hop = Math.abs(Math.sin((cueAge / 0.7) * Math.PI)) * 0.32;
      if (cueKind === 'agreement') {
        hop = Math.abs(Math.sin(cueAge * Math.PI * 2.2)) * 0.34;
        sparkle = true;
      }
      if (cueKind === 'scatter' && cueAge < 0.9) {
        shake = Math.sin(cueAge * 60) * 0.03 * (1 - cueAge / 0.9);
        flash = (1 - cueAge / 0.9) * 0.45;
      }
      if (cueKind === 'reassemble' && cueAge < 0.8) appear = Math.min(appear, smooth(cueAge, 0, 0.8));
      if (cueKind === 'flow_to_owner' || cueKind === 'present_cards') sparkle = cueKind === 'flow_to_owner';
    }

    // ---- 활동별 값 ----
    const act = char.activity;
    const tps = char.speech?.tokensPerSec ?? 0;
    const speaking = act === 'talking' || act === 'drafting' || (char.speech?.text ? char.speech.phase !== 'thinking' : false);
    const breathe = 1 + Math.sin(t * 1.9 + home.x * 3) * 0.018;
    const bob = Math.sin(t * 1.5 + home.z * 2.0) * (paused ? 0.004 : 0.022) + (s.speed > 0.2 ? Math.abs(Math.sin(t * 11)) * 0.05 : 0);
    const thinking = act === 'thinking';
    const jitter = thinking ? Math.sin(t * 38) * 0.006 : 0;
    const lowered = paused ? -0.09 : 0;

    // 입 벌림 ∝ tokensPerSec
    const mouthTarget = speaking
      ? (0.3 + 0.7 * Math.abs(Math.sin(t * (7 + Math.min(tps, 60) * 0.12)))) * (0.45 + Math.min(1, tps / 40) * 0.55)
      : 0;
    s.mouth = damp(s.mouth, mouthTarget, 18, dt);

    // 깜빡임
    if (t > s.nextBlink) {
      s.blink = 1;
      s.nextBlink = t + 2 + Math.random() * 3;
    }
    s.blink = Math.max(0, s.blink - dt * 9);

    // 시선: 대상 쪽(화면 오른쪽 +)
    const lookX = hasLook ? THREE.MathUtils.clamp(Math.sin(s.gazeRel) * 1.2, -1, 1) : Math.sin(t * 0.6) * 0.15;
    s.look.x = damp(s.look.x, lookX, 9, dt);
    s.look.y = damp(s.look.y, thinking ? 0.7 : char.recalling ? 0.4 : writing ? -0.5 : 0, 7, dt);

    const lightK = rt.light.current;
    // ---- 위치·스케일 적용 ----
    r.position.set(s.x + shake, 0, s.z);
    r.scale.setScalar(CHAR_SCALE);
    s.jumpY = damp(s.jumpY, hop, 22, dt);
    const sc = appear;
    r.visible = appear > 0.01;
    if (body.current) {
      body.current.position.y = (bob + s.jumpY + lowered) * 1;
      const squash = 1 + (hop > 0 ? 0 : 0);
      body.current.scale.set(sc * breathe * (thinking ? 1.02 : 1) * squash, sc * (2 - breathe) * (paused ? 0.94 : 1), sc * breathe);
      body.current.rotation.z = (writing ? 0.1 * (sinRel > 0 ? 1 : -1) : 0) + nod * 0.3 + jitter * 6;
      body.current.rotation.x = nod * 0.2;
    }

    // ---- 스프라이트 uniforms ----
    const u = bodyMat.u;
    u.uTime.value = t;
    u.uLight.value = (isRoom ? 0.9 : 0.95) * (0.6 + 0.5 * lightK) * (paused ? 0.85 : 1);
    u.uDesat.value = damp(u.uDesat.value, paused ? 0.78 : 0, 6, dt);
    u.uAlpha.value = Math.min(1, appear * 1.2);
    u.uTint.value.copy(color);
    u.uTintAmt.value = isRoom ? 0 : 0.88;
    u.uRim.value.copy(isRoom ? new THREE.Color(PALETTE.roomAgentLime) : color).lerp(new THREE.Color('#ffffff'), 0.4);
    u.uRimAmt.value = paused ? 0.1 : 0.35 + (char.awaitingApproval ? 0.4 : 0);
    u.uFlash.value.set(flash > 0 ? '#ff5a4a' : '#ffffff');
    u.uFlashAmt.value = flash;
    u.uWave.value = paused ? 0.3 : 1;
    // 얼굴: 카메라를 향할 때만 보인다
    const faceVis = smooth(cosRel, -0.15, 0.4);
    u.uFaceOn.value = faceVis * (full || true ? 1 : 0);
    u.uBlink.value = s.blink;
    u.uMouth.value = s.mouth;
    u.uSquint.value = damp(u.uSquint.value, thinking ? 0.75 : paused ? 0.85 : act === 'awaiting' ? 0.0 : 0, 8, dt);
    u.uWorry.value = damp(u.uWorry.value, act === 'awaiting' || cueKind === 'scatter' && cueAge < 1.2 ? 1 : 0, 8, dt);
    u.uLook.value.copy(s.look);
    if (isRoom) {
      const frame = (rel / (Math.PI * 2)) * YAW_FRAMES;
      atlasFrameUv(frame, u.uFrame.value);
      u.uFaceCenter.value.set(0.5 + 0.2 * sinRel, 0.66);
      u.uFaceScale.value = 0.15;
    } else {
      u.uFaceCenter.value.set(0.5 + 0.05 * sinRel, 0.5);
      u.uFaceScale.value = 0.17;
    }
    // 팔(알형만)
    const au = armMat.u;
    au.uTime.value = t;
    au.uLight.value = u.uLight.value;
    au.uTint.value.copy(color);
    au.uTintAmt.value = 0.88;
    au.uAlpha.value = u.uAlpha.value;
    au.uFaceOn.value = 0;
    au.uWave.value = 0;
    au.uRimAmt.value = 0.2;
    au.uDesat.value = u.uDesat.value;
    au.uFlashAmt.value = flash;
    au.uFlash.value.copy(u.uFlash.value);
    const holding = t < s.holdUntil;
    if (armL.current && armR.current) {
      const wr = writing ? Math.sin(t * 13) * 0.35 : 0;
      const talk = act === 'talking' ? Math.sin(t * 4.2) * 0.35 : 0;
      const idleSw = Math.sin(t * 1.6) * 0.06;
      armR.current.rotation.z = THREE.MathUtils.lerp(armR.current.rotation.z, holding ? 1.9 : writing ? 2.1 + wr : act === 'awaiting' ? 2.5 + Math.sin(t * 5) * 0.2 : 0.35 + talk + idleSw, 0.25);
      armL.current.rotation.z = THREE.MathUtils.lerp(armL.current.rotation.z, holding ? -1.9 : -0.35 - idleSw - (act === 'talking' ? talk * 0.4 : 0), 0.25);
    }
    if (cardRef.current) {
      cardRef.current.visible = holding && appear > 0.5;
      cardRef.current.position.set(0, AGENT_H * 0.32, 0.12);
      cardRef.current.rotation.z = Math.sin(t * 2) * 0.04;
    }
    // 승인 대기: 오렌지 결정
    if (diamond.current) {
      diamond.current.visible = char.awaitingApproval && appear > 0.3;
      diamond.current.rotation.y = t * 1.8;
      diamond.current.position.y = (isHuman ? PAWN_H : AGENT_H) + 0.52 + Math.sin(t * 3) * 0.05;
      const k = 1 + Math.sin(t * 5) * 0.12;
      diamond.current.scale.setScalar(k);
    }
    // 바닥 링
    if (ring.current) {
      const pulse = char.awaitingApproval ? 1 + Math.sin(t * 5) * 0.08 : char.isMe ? 1 + Math.sin(t * 2.2) * 0.03 : 1;
      ring.current.scale.setScalar(pulse * (isHuman ? 1 : 0.88) * appear);
      ringMat.color.set(char.awaitingApproval ? '#ffb45a' : char.color);
      ringMat.opacity = (0.5 + 0.5 * lightK) * appear;
    }
    meRingMat.opacity = 0.9 * appear;
    shadowMat.opacity = 0.5 * appear * (1 - Math.min(0.6, (bob + s.jumpY) * 2));
    if (dash.current) {
      dash.current.visible = char.visiting;
      dash.current.rotation.y = t * 0.5;
    }
    if (silhouette.current) {
      silhouette.current.visible = false;
    }

    // ---- 입자 모드 ----
    let pm: ParticleMode = 'none';
    if (!rt.replaying && rt.quality !== 'low' && full) {
      if (paused) pm = 'sink';
      else if (char.recalling) {
        pm = 'recall';
        pFrom.current.set(rt.plan.shelf.x - s.x, rt.plan.shelf.y - 0.1, rt.plan.shelf.z - s.z);
        pTo.current.set(0, AGENT_H * 0.7, 0);
      } else if (thinking) pm = 'think';
      else if (sparkle && cueKind === 'flow_to_owner') {
        const o = char.seatUserId ? rt.positions.get(`h:${char.seatUserId}`) : undefined;
        pTo.current.set((o?.x ?? s.x) - s.x, 0, (o?.z ?? s.z) - s.z);
        pm = 'owner';
      } else if (sparkle) pm = 'sparkle';
    }
    pMode.current = pm;
    // 위치 공유
    let pos = rt.positions.get(char.id);
    if (!pos) {
      pos = new THREE.Vector3();
      rt.positions.set(char.id, pos);
    }
    pos.set(s.x, 0, s.z);
    void camYaw;
  });

  let crowd = false;
  for (const [oid, sp] of rt.plan.home) {
    if (oid !== char.id && !isHuman && Math.hypot(sp.x - (rt.plan.home.get(char.id)?.x ?? 0), sp.z - (rt.plan.home.get(char.id)?.z ?? 0)) < 0.95) crowd = true;
  }
  const tagY = (isHuman ? PAWN_H : AGENT_H) + 0.3 + (crowd ? 0.26 : 0);
  const badge = char.representing ? '대리' : char.visiting ? '방문' : null;
  const tagText = char.isMe && !isRoom ? `${char.name} · 나` : isRoom ? `${char.name} · 우리` : char.name;
  const bubbleSpec = useMemo<BubbleSpec | null>(() => {
    if (!full) return null;
    if (char.awaitingApproval) return { kind: 'ask', text: '승인이 필요해요', color: '#ff9a3c' };
    if (char.activity === 'paused') return { kind: 'paused', text: '일시정지', color: '#8b94a6' };
    const sp = char.speech;
    if (!sp) return null;
    if (sp.phase === 'recalling') return { kind: 'recalling', text: '', color: '#7e5fd8' };
    if (sp.phase === 'thinking' || (!sp.text && char.activity === 'thinking')) return { kind: 'thinking', text: '', color: char.color };
    if (sp.text) return { kind: sp.phase === 'said' ? 'said' : 'writing', text: sp.text, color: char.color };
    return { kind: 'writing', text: '', color: char.color };
  }, [full, char.awaitingApproval, char.activity, char.speech, char.color]);
  const bubbleKey = bubbleSpec ? `${bubbleSpec.kind}|${bubbleSpec.text}|${bubbleSpec.color}` : 'none';
  void INK;
  void armGeo;
  void ringGeo;

  return (
    <group ref={root}>
      {/* 접지 그림자 */}
      <mesh geometry={discGeo()} material={shadowMat} position={[0, 0.012, 0]} renderOrder={2} />
      {/* 소유자 색 링 (나는 흰 바깥 링이 하나 더) */}
      <mesh ref={ring} geometry={ringGeo()} material={ringMat} position={[0, 0.018, 0]} renderOrder={3} />
      {char.isMe ? <mesh geometry={ringGeo()} material={meRingMat} position={[0, 0.016, 0]} scale={1.22} renderOrder={3} /> : null}
      {/* 방문 배지: 점선 링 */}
      <mesh ref={dash} position={[0, 0.02, 0]} rotation-x={-Math.PI / 2} renderOrder={3} material={dashMat}>
        <planeGeometry args={[1.05, 1.05]} />
      </mesh>
      <group ref={body}>
        {isHuman ? (
          <mesh geometry={pawnGeometry()} material={pawnMat} castShadow />
        ) : (
          <group ref={bill}>
            <mesh geometry={isRoom ? GHOST_GEO : EGG_GEO} material={bodyMat} renderOrder={6} />
            {!isRoom ? (
              <>
                <group ref={armL} position={[-0.3, AGENT_H * 0.45, 0.02]}>
                  <mesh geometry={ARM_GEO} material={armMat} renderOrder={7} />
                </group>
                <group ref={armR} position={[0.3, AGENT_H * 0.45, 0.02]} scale={[-1, 1, 1]}>
                  <mesh geometry={ARM_GEO} material={armMat} renderOrder={7} />
                </group>
              </>
            ) : null}
            <mesh ref={cardRef} geometry={CARD_GEO} material={cardMat} visible={false} renderOrder={8} />
          </group>
        )}
      </group>
      {/* 승인 대기 결정 */}
      <mesh ref={diamond} geometry={diamondGeo()} material={diamondMat} visible={false} renderOrder={9} />
      {full ? <NameTag text={tagText} color={isRoom ? PALETTE.roomAgentLime : char.color} badge={badge} me={char.isMe} position={[0, tagY + (bubbleSpec ? 0 : 0), 0]} /> : null}
      {full && bubbleSpec ? <Bubble key={bubbleKey.slice(0, 4)} spec={bubbleSpec} position={[0, tagY + 0.12, 0]} /> : null}
      {!full && !isHuman ? <LightMarker activity={char.activity} color={char.color} y={AGENT_H + 0.25} /> : null}
      <Particles color={useMemo(() => new THREE.Color(isRoom ? PALETTE.roomAgentLime : char.color).lerp(new THREE.Color('#ffffff'), 0.25), [char.color, isRoom])} mode={pMode} from={pFrom} to={pTo} enabled={full && rt.quality !== 'low'} />
      <mesh ref={silhouette} visible={false} />
    </group>
  );
}

/** 조망(light) 캐릭터: 일하는 중이면 머리 위에 작은 점 3개가 뛴다 */
function LightMarker({ activity, color, y }: { activity: string; color: string; y: number }) {
  const g = useRef<THREE.Group>(null);
  const mats = useMemo(() => [0, 1, 2].map(() => new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, depthTest: false, depthWrite: false, toneMapped: false })), [color]);
  useEffect(() => () => mats.forEach((m) => m.dispose()), [mats]);
  const busy = activity === 'thinking' || activity === 'drafting' || activity === 'talking';
  const orange = activity === 'awaiting';
  useFrame((state) => {
    const gg = g.current;
    if (!gg) return;
    gg.visible = busy || orange;
    const t = state.clock.elapsedTime;
    gg.children.forEach((c, i) => {
      c.position.y = Math.sin(t * 6 - i * 0.9) * 0.07;
      mats[i]!.color.set(orange ? '#ffb45a' : color);
    });
  });
  return (
    <group ref={g} position={[0, y, 0]} visible={false}>
      {[0, 1, 2].map((i) => (
        <sprite key={i} position={[(i - 1) * 0.22, 0, 0]} scale={[0.34, 0.34, 1]} material={mats[i]} renderOrder={30} />
      ))}
    </group>
  );
}
