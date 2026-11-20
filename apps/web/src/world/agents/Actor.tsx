import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { INTERACTION_COLORS, PALETTE } from '@ensemble/shared';
import { glowTexture } from '../capsule/glow';
import { portraitDataUrl } from '../../avatar/portrait';
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
import { DWELL, D_SOCIAL, WALK, createIdle, releaseIdle, startIdle, stepIdle, stopIdle, rand, type IdleState } from './idle';
import type { CharacterInput } from './types';
import type { LabelEntry } from './LabelStacker';

void ATLAS_URL;
const ORANGE = new THREE.Color(PALETTE.approvalOrange);
const INK = '#2b2118';

export const AGENT_H = 0.86;
/** 캡슐 안에서 한눈에 보이도록 인물 전체를 키운다 */
const CHAR_SCALE = 1.42;
export const PAWN_H = 0.82;

/** 소유자 캐릭터 위치: 접속 중(`h:`)이 없으면 자리 비움(`ha:<uid>:<roomId>`)으로 대체 */
function ownerPos(rt: ActorRuntime, uid: string): THREE.Vector3 | undefined {
  return rt.positions.get(`h:${uid}`) ?? rt.positions.get(`ha:${uid}:${rt.roomId}`);
}

export interface ActorRuntime {
  /** 모든 Actor의 현재 로컬 위치 (시선·말하기 대상 조회) */
  positions: Map<string, THREE.Vector3>;
  plan: RoomPlan;
  /** idle 배회 지점 예약(지점 인덱스 -> 캐릭터 id) */
  reserve: Map<number, string>;
  /** 조명 단계에서 온 실내 밝기(0.45~1) */
  light: { current: number };
  quality: 'high' | 'mid' | 'low';
  replaying: boolean;
  reducedMotion: boolean;
  doorFor: (side: -1 | 1) => Spot;
  roomId: string;
  /** 이름표 겹침 회피(LabelStacker)가 읽는 라벨 목록 */
  labels: Map<string, LabelEntry>;
  /** 방을 포커스 중이고 이 방이 포커스 방이 아님: 이름표·말풍선을 그리지 않는다 */
  tagsHidden?: boolean;
  /** 이 방에 그려지는 캐릭터 수(이름표 펼침 판단) */
  charCount: number;
}

// ------------------------------------------------------------------ 공용 부품

/** 사람 아바타: 어깨가 있는 몸통 + 머리(구). 얼굴 원판(초상)은 별도 빌보드 */
let torsoGeo: THREE.BufferGeometry | null = null;
function humanTorsoGeometry(): THREE.BufferGeometry {
  if (torsoGeo) return torsoGeo;
  const prof: [number, number][] = [[0.0, 0.0], [0.2, 0.0], [0.225, 0.04], [0.2, 0.16], [0.215, 0.3], [0.17, 0.42], [0.075, 0.46], [0.0, 0.46]];
  torsoGeo = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 28);
  return torsoGeo;
}
let headGeo: THREE.BufferGeometry | null = null;
const humanHeadGeometry = () => (headGeo ??= new THREE.SphereGeometry(0.155, 24, 18).translate(0, 0.62, 0));
const faceGeo = () => (FACE_GEO ??= new THREE.CircleGeometry(0.15, 32).translate(0, 0.62, 0.16));
let FACE_GEO: THREE.CircleGeometry | null = null;

/**
 * 사람 얼굴 원판 텍스처: 먼저 빈 원판(크림 바탕 + 소유자 색 테두리)을 그려 두고, 초상 SVG를 비동기 로드해
 * 같은 캔버스에 덮어 그린다. 이니셜 글자는 쓰지 않는다. low 품질은 해상도(S)만 낮춘다.
 * 인스턴스(Actor)별로 만들고 언마운트 시 dispose한다. SVG data URL 문자열은 portrait.ts에서 캐시된다.
 */
function faceTexture(name: string, color: string, S: number): THREE.CanvasTexture {
  const k = S / 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const ring = () => {
    g.lineWidth = 28 * k;
    g.strokeStyle = color;
    g.beginPath();
    g.arc(S / 2, S / 2, 110 * k, 0, Math.PI * 2);
    g.stroke();
  };
  g.fillStyle = '#fff7e8';
  g.beginPath();
  g.arc(S / 2, S / 2, 124 * k, 0, Math.PI * 2);
  g.fill();
  ring();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  const img = new Image();
  img.onload = () => {
    g.clearRect(0, 0, S, S);
    g.save();
    g.beginPath();
    g.arc(S / 2, S / 2, 124 * k, 0, Math.PI * 2);
    g.clip();
    g.drawImage(img, 0, 0, S, S);
    g.restore();
    ring();
    t.needsUpdate = true;
  };
  img.src = portraitDataUrl(name, color, S);
  return t;
}

let starTexCache: THREE.CanvasTexture | null = null;
/** Agent 표식: 4갈래 스파크 */
function starTexture(): THREE.CanvasTexture {
  if (starTexCache) return starTexCache;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? 60 : 13;
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    g[i === 0 ? 'moveTo' : 'lineTo'](64 + Math.cos(a) * r, 64 + Math.sin(a) * r);
  }
  g.closePath();
  g.fill();
  starTexCache = new THREE.CanvasTexture(c);
  starTexCache.colorSpace = THREE.SRGBColorSpace;
  return starTexCache;
}
let ringGeoCache: THREE.RingGeometry | null = null;
const ringGeo = () => (ringGeoCache ??= new THREE.RingGeometry(0.3, 0.37, 40).rotateX(-Math.PI / 2));
let discGeoCache: THREE.CircleGeometry | null = null;
const discGeo = () => (discGeoCache ??= new THREE.CircleGeometry(0.42, 28).rotateX(-Math.PI / 2));
let diamondGeoCache: THREE.OctahedronGeometry | null = null;
const diamondGeo = () => (diamondGeoCache ??= new THREE.OctahedronGeometry(0.13, 0).scale(1, 1.5, 1));
let diamondRingCache: THREE.RingGeometry | null = null;
const diamondRingGeo = () => (diamondRingCache ??= new THREE.RingGeometry(0.33, 0.42, 4, 1).rotateX(-Math.PI / 2));
let hexRingCache: THREE.RingGeometry | null = null;
const hexRingGeo = () => (hexRingCache ??= new THREE.RingGeometry(0.34, 0.42, 6, 1).rotateX(-Math.PI / 2));
let diamondPadCache: THREE.CircleGeometry | null = null;
const diamondPadGeo = () => (diamondPadCache ??= new THREE.CircleGeometry(0.42, 4).rotateX(-Math.PI / 2));
let hexPadCache: THREE.CircleGeometry | null = null;
const hexPadGeo = () => (hexPadCache ??= new THREE.CircleGeometry(0.42, 6).rotateX(-Math.PI / 2));
let linkGeoCache: THREE.PlaneGeometry | null = null;
/** +z 방향으로 길이 1, 폭 1인 바닥 띠 (소유자 연결선) */
const linkGeo = () => (linkGeoCache ??= new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5));
let antennaGeoCache: THREE.CylinderGeometry | null = null;
const antennaGeo = () => (antennaGeoCache ??= new THREE.CylinderGeometry(0.012, 0.012, 0.16, 6).translate(0, 0.08, 0));
let haloGeoCache: THREE.TorusGeometry | null = null;
const haloGeo = () => (haloGeoCache ??= new THREE.TorusGeometry(0.2, 0.02, 8, 36).rotateX(Math.PI / 2));
/** 종류별 크기: 사람 > Room Agent > Personal Agent */
const MARK_Y = 0.68;
const KIND_K = { human: 1.14, room: 0.8, agent: 0.7 } as const;
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
  const away = !!char.away && isHuman;
  const full = char.detail === 'full';
  // 포커스 중에는 포커스 방 밖 캡슐의 이름표를 숨긴다(유리 너머로 작고 흐리게 비쳐 지저분하다)
  const tagsOn = full && !rt.tagsHidden;
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
  const sparkG = useRef<THREE.Group>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Sprite>(null);
  const linkRef = useRef<THREE.Mesh>(null);
  const padRef = useRef<THREE.Mesh>(null);
  const K = isHuman ? KIND_K.human : isRoom ? KIND_K.room : KIND_K.agent;
  const accent = isRoom ? PALETTE.roomAgentLime : char.color;

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
  // 자리 비움: 채도를 빼고 반투명(깊이는 쓰지 않아 뒤가 비친다)
  const awayColor = useMemo(() => new THREE.Color(char.color).lerp(new THREE.Color('#a9afba'), 0.6), [char.color]);
  const torsoMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: (away ? awayColor.clone() : new THREE.Color(char.color)).multiplyScalar(0.9),
        roughness: 0.8,
        metalness: 0,
        emissive: away ? awayColor : char.color,
        emissiveIntensity: away ? 0.1 : 0.18,
        transparent: away,
        opacity: away ? 0.42 : 1,
        depthWrite: !away,
      }),
    [char.color, away, awayColor],
  );
  const headMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: (away ? awayColor.clone() : new THREE.Color(char.color)).lerp(new THREE.Color('#ffffff'), 0.3),
        roughness: 0.8,
        metalness: 0,
        emissive: away ? awayColor : char.color,
        emissiveIntensity: away ? 0.1 : 0.16,
        transparent: away,
        opacity: away ? 0.42 : 1,
        depthWrite: !away,
      }),
    [char.color, away, awayColor],
  );
  const faceSize = rt.quality === 'low' ? 96 : 256;
  const faceTex = useMemo(() => faceTexture(char.name, char.color, faceSize), [char.name, char.color, faceSize]);
  useEffect(() => () => faceTex.dispose(), [faceTex]);
  const faceMat = useMemo(
    () => new THREE.MeshBasicMaterial({ map: faceTex, transparent: true, opacity: away ? 0.42 : 1, color: away ? '#b9bec8' : '#ffffff', toneMapped: false, side: THREE.DoubleSide }),
    [faceTex, away],
  );
  const sparkMat = useMemo(
    () => new THREE.SpriteMaterial({ map: starTexture(), color: new THREE.Color(accent).lerp(new THREE.Color('#ffffff'), 0.5).multiplyScalar(2.2), transparent: true, depthWrite: false, toneMapped: false }),
    [accent],
  );
  const antennaMat = useMemo(() => new THREE.MeshBasicMaterial({ color: new THREE.Color(accent).lerp(new THREE.Color('#ffffff'), 0.4), toneMapped: false, transparent: true }), [accent]);
  const glowMat = useMemo(
    () => new THREE.SpriteMaterial({ map: glowTexture(), color: accent, transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false }),
    [accent],
  );
  const haloMat = useMemo(() => new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.roomAgentLime).multiplyScalar(1.5), toneMapped: false, transparent: true }), []);
  const padMat = useMemo(() => new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.22, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }), [accent]);
  const linkMat = useMemo(() => new THREE.MeshBasicMaterial({ color: char.color, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }), [char.color]);
  const silMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: char.color, transparent: true, opacity: 0.28, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending }),
    [char.color],
  );
  useEffect(
    () => () => {
      [bodyMat, armMat, pawnMat, ringMat, meRingMat, shadowMat, diamondMat, dashMat, cardMat, silMat, torsoMat, headMat, faceMat, sparkMat, antennaMat, glowMat, haloMat, linkMat, padMat].forEach((m) => m.dispose());
    },
    [bodyMat, armMat, pawnMat, ringMat, meRingMat, shadowMat, diamondMat, dashMat, cardMat, silMat, torsoMat, headMat, faceMat, sparkMat, antennaMat, glowMat, haloMat, linkMat, padMat],
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
    idle: null as IdleState | null,
  });
  const temp = useMemo(() => ({ v: new THREE.Vector3(), cam: new THREE.Vector3(), q: new THREE.Vector4() }), []);

  const unregister = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!root.current) return;
    unregister.current = registerCharacter(char.id, root.current, isHuman ? PAWN_H * K : AGENT_H * K, rt.roomId);
    emitCharacterEvent({ type: 'spawn', id: char.id, roomId: rt.roomId, kind: char.kind });
    const id = char.id;
    const roomId = rt.roomId;
    const kind = char.kind;
    return () => {
      unregister.current?.();
      if (st.current.idle) releaseIdle(st.current.idle, rt, id);
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
      // 자리 비움은 걸어 들어오지 않고 제자리에서 서서히 나타난다
      s.x = away ? home.x : door.x;
      s.z = away ? home.z : door.z;
      s.born = t;
      s.prevX = s.x;
      s.prevZ = s.z;
    }
    if (leaving && s.leaveT < 0) s.leaveT = t;
    if (!s.idle) {
      s.idle = createIdle(char.id);
      s.idle.nextAt = t + 3 + s.idle.ph;
    }
    const idle = s.idle;

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
    // idle 배회: 평상시(연출 없음)의 Agent만. 다른 연출이 시작되면 즉시 끊고 기존 이동이 현재 위치에서 이어받는다
    const canIdle =
      !isHuman &&
      !leaving &&
      !writing &&
      !char.recalling &&
      !char.awaitingApproval &&
      !char.representing &&
      !paused &&
      char.activity === 'idle' &&
      !rt.reducedMotion &&
      rt.quality !== 'low' &&
      t - s.born > 1.2 &&
      !(t - s.cueT < 1.6) &&
      t >= s.holdUntil;
    if (canIdle) {
      if (!idle.active && t >= idle.nextAt) startIdle(idle, s, rt, char.id, char.ownerId, home, t);
    } else {
      if (idle.active) stopIdle(idle, rt, char.id, t);
      else idle.nextAt = Math.max(idle.nextAt, t + 1);
    }
    const idleOn = idle.active;
    if (idleOn) {
      stepIdle(idle, s, rt, char.id, char.ownerId, home, t, dt);
      tx = idle.tx;
      tz = idle.tz;
    } else {
      const lam = rt.reducedMotion ? 9 : 2.8;
      s.x = damp(s.x, tx, lam, dt);
      s.z = damp(s.z, tz, lam, dt);
    }
    const idleWalk = idleOn && idle.phase === WALK;
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
    } else if (idleWalk) {
      look.set(idle.tx, 0, idle.tz);
      hasLook = Math.hypot(idle.tx - s.x, idle.tz - s.z) > 0.05;
    } else if (idleOn && idle.phase === DWELL) {
      const so = idle.dkind === D_SOCIAL && idle.socialId ? rt.positions.get(idle.socialId) : undefined;
      if (so) look.set(so.x, 0, so.z);
      else look.set(s.x + Math.sin(idle.lookYaw), 0, s.z + Math.cos(idle.lookYaw));
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
        wantYaw += dd * (writing || char.recalling ? 0.3 : idleWalk ? 0.4 : 0.62);
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
    // 사람: 가끔 고개를 살짝 돌린다(얼굴 원판이 옆으로 비낀다)
    let headTurn = 0;
    if (isHuman && !away && !leaving && !rt.reducedMotion) {
      if (t >= idle.htNext) {
        idle.htStart = t;
        idle.htDir = (rand(idle) < 0.5 ? -1 : 1) * (0.4 + rand(idle) * 0.3);
        idle.htNext = t + 6 + rand(idle) * 9;
      }
      const hu = (t - idle.htStart) / 1.8;
      if (hu >= 0 && hu < 1) headTurn = Math.sin(hu * Math.PI) * idle.htDir;
    }
    if (bill.current) bill.current.rotation.y = camYaw + headTurn;
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
    let nod = idleOn ? idle.nod : 0;
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
    // 사람은 아주 약한 숨쉬기만, Agent는 조금 더
    const breathe = 1 + Math.sin(t * 1.9 + home.x * 3) * (isHuman ? 0.009 : 0.018);
    const gait = s.speed > 0.2 ? (idleOn ? Math.abs(Math.sin(t * 6 + idle.ph)) * 0.035 : Math.abs(Math.sin(t * 11)) * 0.05) : 0;
    const bob = Math.sin(t * 1.5 + home.z * 2.0) * (paused ? 0.004 : isHuman ? 0.009 : 0.022) + gait;
    const thinking = act === 'thinking';
    const jitter = thinking ? Math.sin(t * 38) * 0.006 : 0;
    const lowered = paused ? -0.09 : 0;
    // Agent는 바닥에서 살짝 떠 있다 (사람은 서 있다)
    const floatH = isHuman ? 0 : paused ? 0.02 : 0.08 + (rt.reducedMotion ? 0 : Math.sin(t * 1.8 + home.x * 2) * 0.045);

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
    r.scale.setScalar(CHAR_SCALE * K);
    s.jumpY = damp(s.jumpY, hop, 22, dt);
    const sc = appear;
    r.visible = appear > 0.01;
    if (body.current) {
      body.current.position.y = bob + s.jumpY + lowered + floatH;
      const squash = 1 + (hop > 0 ? 0 : 0);
      body.current.scale.set(sc * breathe * (thinking ? 1.02 : 1) * squash, sc * (2 - breathe) * (paused ? 0.94 : 1), sc * breathe);
      body.current.rotation.z = (writing ? 0.1 * (sinRel > 0 ? 1 : -1) : 0) + nod * 0.3 + jitter * 6 + (idleWalk ? Math.sin(t * 6 + idle.ph) * 0.05 * Math.min(1, s.speed / 0.4) : 0);
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
      ring.current.scale.setScalar(pulse * (isHuman ? 1 : 1.4) * appear);
      ringMat.color.set(char.awaitingApproval ? '#ffb45a' : char.color);
      ringMat.opacity = (0.5 + 0.5 * lightK) * appear * (away ? 0.35 : 1);
    }
    meRingMat.opacity = 0.9 * appear;
    shadowMat.opacity = 0.5 * appear * (1 - Math.min(0.6, (bob + s.jumpY + floatH) * 2));
    if (dash.current) {
      dash.current.visible = char.visiting;
      dash.current.rotation.y = t * 0.5;
    }
    if (silhouette.current) {
      silhouette.current.visible = false;
    }
    // Agent 표식: 머리 위 스파크(+안테나/후광), 은은한 발광
    const by = bob + s.jumpY + lowered + floatH;
    if (sparkG.current) {
      sparkG.current.visible = !isHuman && appear > 0.05;
      sparkG.current.position.y = MARK_Y + by;
      sparkG.current.scale.setScalar(Math.max(0.01, appear));
      const pulse = rt.reducedMotion || paused ? 1 : 1 + Math.sin(t * 3.2) * 0.12;
      sparkMat.rotation = rt.reducedMotion || paused ? 0 : t * 0.9;
      sparkMat.opacity = paused ? 0.45 : 1;
      antennaMat.opacity = paused ? 0.45 : 1;
      const sp = sparkG.current.getObjectByName('spark');
      if (sp) sp.scale.setScalar(0.62 * pulse);
    }
    if (haloRef.current) {
      haloRef.current.rotation.y = rt.reducedMotion ? 0 : t * 1.4;
      haloMat.opacity = paused ? 0.4 : 1;
    }
    if (glowRef.current) {
      glowRef.current.visible = !isHuman && appear > 0.05;
      glowRef.current.position.y = AGENT_H * 0.55 + by;
      glowMat.opacity = (paused ? 0.1 : 0.26 + (rt.reducedMotion ? 0 : Math.sin(t * 2 + home.z) * 0.07) + (writing || thinking ? 0.12 : 0)) * appear * (0.55 + 0.45 * lightK);
    }
    if (padRef.current) {
      padRef.current.scale.setScalar(1.4 * appear);
      padMat.opacity = (paused ? 0.1 : 0.3) * appear;
    }
    // 소유자 연결선: Personal Agent <-> 같은 방의 소유자 (바닥)
    if (linkRef.current) {
      const o = !isHuman && !isRoom && !leaving && !char.visiting && char.ownerId ? ownerPos(rt, char.ownerId) : undefined;
      const lk = linkRef.current;
      const csc = CHAR_SCALE * K;
      const ddx = o ? o.x - s.x : 0;
      const ddz = o ? o.z - s.z : 0;
      const dist = Math.hypot(ddx, ddz);
      const len = dist - 0.2;
      lk.visible = !!o && len > 0.08 && dist < 8 && appear > 0.5;
      if (lk.visible) {
        const ux = ddx / dist;
        const uz = ddz / dist;
        lk.position.set((ux * 0.1) / csc, 0.02, (uz * 0.1) / csc);
        lk.rotation.y = Math.atan2(ddx, ddz);
        lk.scale.set(0.07 / csc, 1, len / csc);
        linkMat.opacity = (paused ? 0.25 : 0.55) * appear;
      }
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
        const o = char.seatUserId ? ownerPos(rt, char.seatUserId) : undefined;
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

  // Agent·Room Agent 이름표는 평소 아이콘 칩만. 활동 중이거나 연결선 끝이거나 호버거나 방이 한산하면(<=3) 전체 이름을 펼친다
  const [hover, setHover] = useState(false);
  const activeNow = (char.activity !== 'idle' && char.activity !== 'paused') || char.recalling || !!char.linked || !!char.speech?.text;
  const compactTag = !isHuman && !activeNow && !hover && rt.charCount > 3;
  let crowd = false;
  for (const [oid, sp] of rt.plan.home) {
    if (oid !== char.id && !isHuman && Math.hypot(sp.x - (rt.plan.home.get(char.id)?.x ?? 0), sp.z - (rt.plan.home.get(char.id)?.z ?? 0)) < 0.95) crowd = true;
  }
  const tagY = compactTag ? AGENT_H + (isRoom ? 0.5 : 0.3) / K : (isHuman ? PAWN_H : AGENT_H) + (isHuman ? 0.62 : isRoom ? 0.78 : 0.42) / K + (crowd ? 0.26 / K : 0);
  const badge = away ? '자리 비움' : char.representing ? '대리' : char.visiting ? '방문' : null;
  // 사람: 이름 / Personal Agent: 이름 · Agent / Room Agent: Room Agent
  const agentBase = char.name.replace(/\s*(의\s*)?Agent$/i, '').trim() || char.name;
  const tagText = isRoom ? 'Room Agent' : isHuman ? (char.isMe ? `${char.name} · 나` : char.name) : `${agentBase} · Agent`;
  const bubbleSpec = useMemo<BubbleSpec | null>(() => {
    if (!tagsOn) return null;
    // 태그 줄: Personal Agent "✦ ALICE의 AGENT · WRITING", Room Agent "ROOM AGENT · WRITING" (사람은 상태 라벨만)
    const who = isHuman ? '' : isRoom ? 'ROOM AGENT' : `✦ ${agentBase}의 AGENT`;
    const tg = (label: string) => (who ? `${who} · ${label}` : undefined);
    if (char.awaitingApproval) return { kind: 'ask', text: '승인이 필요해요', color: INTERACTION_COLORS.a2h };
    // 사람: 이 사람이 승인자인 Agent 승인 대기
    if (char.alert === 'approval') return { kind: 'ask', text: char.isMe ? '내 승인 필요' : '승인 대기', color: INTERACTION_COLORS.a2h };
    if (char.activity === 'paused') return { kind: 'paused', text: '일시정지', color: '#8dbed2', tag: tg('PAUSED') };
    const sp = char.speech;
    if (!sp) return null;
    if (sp.phase === 'recalling') return { kind: 'recalling', text: '', color: char.color, tag: tg('RECALLING') };
    if (sp.phase === 'thinking' || (!sp.text && char.activity === 'thinking')) return { kind: 'thinking', text: '', color: char.color, tag: tg('THINKING') };
    if (sp.text) return { kind: sp.phase === 'said' ? 'said' : 'writing', text: sp.text, color: char.color, tag: sp.phase === 'said' ? (who || undefined) : tg('WRITING') };
    return { kind: 'writing', text: '', color: char.color, tag: tg('WRITING') };
  }, [tagsOn, char.awaitingApproval, char.alert, char.isMe, char.activity, char.speech, char.color, isHuman, isRoom, agentBase]);
  const bubbleKey = bubbleSpec ? `${bubbleSpec.kind}|${bubbleSpec.text}|${bubbleSpec.color}|${bubbleSpec.tag ?? ''}` : 'none';
  void INK;
  void armGeo;
  void ringGeo;

  // 이름표 겹침 회피: 라벨 그룹을 rt.labels에 등록한다(LabelStacker가 매 프레임 위치를 조정)
  const labelG = useRef<THREE.Group>(null);
  const leader = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false, toneMapped: false }));
    l.renderOrder = 27;
    l.frustumCulled = false;
    l.visible = false;
    l.raycast = () => undefined;
    return l;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    (leader.material as THREE.LineBasicMaterial).color.set(accent);
  }, [leader, accent]);
  const labelEntry = useRef<LabelEntry | null>(null);
  // NameTag가 알려 주는 크기는 캐릭터 루트 로컬 단위다. 월드 크기(루트 스케일 곱)로 바꿔 둔다.
  // 자식 효과가 부모 효과(엔트리 생성)보다 먼저 돌므로, 측정값은 ref에 보관했다가 엔트리 생성 때 쓴다.
  const measured = useRef<{ w: number; h: number } | null>(null);
  const onMeasure = (w: number, h: number) => {
    const sc = CHAR_SCALE * K;
    measured.current = { w: w * sc, h: h * sc };
    if (labelEntry.current) {
      labelEntry.current.w = w * sc;
      labelEntry.current.h = h * sc;
    }
  };
  useEffect(() => {
    const g = labelG.current;
    if (!g || !tagsOn) return;
    const e: LabelEntry = { group: g, line: leader, baseY: tagY, headY: (isHuman ? PAWN_H : AGENT_H) * CHAR_SCALE * K * 0.95, w: measured.current?.w ?? 1.2, h: measured.current?.h ?? 0.3, bubble: null, cur: 0, leaving: false };
    labelEntry.current = e;
    rt.labels.set(char.id, e);
    return () => {
      if (rt.labels.get(char.id) === e) rt.labels.delete(char.id);
      labelEntry.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagsOn, char.id, rt.labels]);
  if (labelEntry.current) {
    labelEntry.current.baseY = tagY;
    labelEntry.current.leaving = leaving;
    labelEntry.current.bubble = bubbleSpec ? { w: 2.1 / K, h: 1.1 / K, y: 0.17 / K } : null;
  }

  return (
    <group ref={root}>
      {/* 접지 그림자 */}
      <mesh geometry={discGeo()} material={shadowMat} position={[0, 0.012, 0]} renderOrder={2} />
      {/* 소유자 색 링 (나는 흰 바깥 링이 하나 더) */}
      <mesh ref={ring} geometry={isHuman ? ringGeo() : isRoom ? hexRingGeo() : diamondRingGeo()} material={ringMat} position={[0, 0.018, 0]} renderOrder={3} />
      {char.isMe && isHuman ? <mesh geometry={ringGeo()} material={meRingMat} position={[0, 0.016, 0]} scale={1.22} renderOrder={3} /> : null}
      {!isHuman ? <mesh ref={padRef} geometry={isRoom ? hexPadGeo() : diamondPadGeo()} material={padMat} position={[0, 0.014, 0]} renderOrder={2} /> : null}
      {/* 소유자 연결선 (Personal Agent만) */}
      {!isHuman && !isRoom ? <mesh ref={linkRef} geometry={linkGeo()} material={linkMat} visible={false} renderOrder={3} /> : null}
      {/* 은은한 발광 (Agent) */}
      {!isHuman ? <sprite ref={glowRef} material={glowMat} scale={[1.7, 1.7, 1]} position={[0, AGENT_H * 0.55, 0]} renderOrder={5} /> : null}
      {/* 방문 배지: 점선 링 */}
      <mesh ref={dash} position={[0, 0.02, 0]} rotation-x={-Math.PI / 2} renderOrder={3} material={dashMat}>
        <planeGeometry args={[1.05, 1.05]} />
      </mesh>
      <group ref={body}>
        {isHuman ? (
          <>
            <mesh geometry={humanTorsoGeometry()} material={torsoMat} castShadow />
            <mesh geometry={humanHeadGeometry()} material={headMat} castShadow />
            <group ref={bill}>
              <mesh geometry={faceGeo()} material={faceMat} renderOrder={6} />
            </group>
          </>
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
      {/* Agent 종류 표식: Personal = 안테나 + 스파크, Room = 후광 + 스파크 */}
      {!isHuman ? (
        <group ref={sparkG} position={[0, MARK_Y, 0]}>
          {!isRoom ? <mesh geometry={antennaGeo()} material={antennaMat} position={[0, 0, 0]} /> : null}
          {isRoom ? <mesh ref={haloRef} geometry={haloGeo()} material={haloMat} position={[0, 0.1, 0]} /> : null}
          <sprite name="spark" material={sparkMat} position={[0, isRoom ? 0.34 : 0.28, 0]} scale={[0.62, 0.62, 1]} renderOrder={10} />
        </group>
      ) : null}
      {/* 승인 대기 결정 */}
      <mesh ref={diamond} geometry={diamondGeo()} material={diamondMat} visible={false} renderOrder={9} />
      <primitive object={leader} />
      <group ref={labelG} position={[0, tagY, 0]}>
        {tagsOn ? <NameTag text={tagText} color={accent} badge={badge} me={char.isMe} variant={isHuman ? 'human' : isRoom ? 'room' : 'agent'} scale={(isHuman || isRoom ? 1 : 0.88) / K} position={[0, 0, 0]} onMeasure={onMeasure} compact={compactTag} subtleBadge={away} onHover={isHuman ? undefined : setHover} /> : null}
        {tagsOn && bubbleSpec ? <Bubble key={bubbleKey.slice(0, 4)} spec={bubbleSpec} width={2.5 / K} position={[0, 0.17 / K, 0]} /> : null}
      </group>
      {!full && !isHuman ? <LightMarker activity={char.activity} color={char.color} y={AGENT_H + 0.55 / K} /> : null}
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
