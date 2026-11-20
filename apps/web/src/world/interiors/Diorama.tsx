import { useEffect, useMemo, useRef, Suspense } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { PALETTE } from '@ensemble/shared';
import type { CapsuleInteriorContext } from '../types';
import type { CapsuleDims } from '../capsule/dims';
import { stadiumSlab } from '../capsule/geometry';
import { ambienceTargets } from '../capsule/InteriorLights';
import { frostOf } from '../capsule/GlassMaterial';
import { PlaceholderInterior } from '../capsule/PlaceholderInterior';
import { themeSeats } from '@ensemble/shared';
import { BoardToolProps } from './BoardToolProps';
import { bakeInterior, interiorPalette, usePropParts, type InteriorPalette } from './build';
import {
  SEAT_CLEARANCE,
  glassClearance,
  interiorPropIds,
  interiorSpec,
  wallFrame,
  wallHalfSpan,
  type BoardAnchor,
  type InteriorSpec,
} from './layouts';

const WARM = new THREE.Color('#ffb066');
const LAMP_SHADE = new THREE.Color('#ffe2a0');
const AGENT = new THREE.Color(PALETTE.agentMintLight);

// ------------------------------------------------------------------ 바닥 판재 텍스처

const floorTex = new Map<string, THREE.CanvasTexture>();
const FLOOR_COLOR = { birch: '#e9d3ab', walnut: '#b48660', oak: '#dfbd8d', concrete: '#cfcbc4' } as const;

function floorTexture(kind: keyof typeof FLOOR_COLOR): THREE.CanvasTexture {
  let t = floorTex.get(kind);
  if (t) return t;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g = cv.getContext('2d')!;
  let seed = kind.length * 977;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  if (kind === 'concrete') {
    g.fillStyle = '#f2f2f2';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 1800; i++) {
      g.fillStyle = `rgba(0,0,0,${rnd() * 0.06})`;
      g.fillRect(rnd() * 256, rnd() * 256, 2 + rnd() * 3, 2 + rnd() * 3);
    }
    g.strokeStyle = 'rgba(0,0,0,0.18)';
    g.lineWidth = 2;
    g.strokeRect(1, 1, 254, 254);
  } else {
    const planks = 8;
    const hgt = 256 / planks;
    for (let i = 0; i < planks; i++) {
      const v = 226 + rnd() * 29;
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(0, i * hgt, 256, hgt);
      for (let k = 0; k < 40; k++) {
        g.fillStyle = `rgba(90,60,30,${rnd() * 0.07})`;
        g.fillRect(rnd() * 256, i * hgt + rnd() * hgt, 20 + rnd() * 60, 1);
      }
      g.fillStyle = 'rgba(60,35,15,0.5)';
      g.fillRect(0, i * hgt, 256, 2);
      const jx = rnd() * 256;
      g.fillRect(jx, i * hgt, 2, hgt);
    }
  }
  t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  floorTex.set(kind, t);
  return t;
}

// ------------------------------------------------------------------ 뒷벽 (벽 장식·액자가 걸리는 면)

function wallGeometry(d: CapsuleDims, spec: InteriorSpec, pal: InteriorPalette): THREE.BufferGeometry {
  const span = wallHalfSpan(d);
  const N = 96;
  // 행: 0 바닥, 걸레받이, 벽면, 몰딩, 꼭대기
  const rowsDef = (H: number) => [
    { y: 0, c: pal.trim },
    { y: 0.1, c: pal.trim },
    { y: 0.1, c: pal.wallLow },
    { y: H * 0.42, c: pal.wallLow },
    { y: H * 0.42, c: pal.wall },
    { y: H - 0.07, c: pal.wall },
    { y: H - 0.07, c: pal.trim },
    { y: H, c: pal.trim },
  ];
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const nrows = 8;
  for (let i = 0; i <= N; i++) {
    const s = -span + (2 * span * i) / N;
    const f = wallFrame(d, s, 0);
    const H = Math.min(spec.wallCap, glassClearance(d, f.x, f.z) * 0.92);
    const rows = rowsDef(H);
    for (const r of rows) {
      pos.push(f.x, r.y, f.z);
      col.push(r.c.r * 0.78, r.c.g * 0.78, r.c.b * 0.78);
    }
    if (i < N) {
      for (const k of [0, 2, 4, 6]) {
        const a = i * nrows + k;
        const b = (i + 1) * nrows + k;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ 보드 (카드가 붙는 벽 액자 / 화이트보드)

const STICKY = ['#ffe28a', '#ffb3c1', '#9fd3ff', '#b6e8b0'];

function BoardObject({ board, pal, color, level }: { board: BoardAnchor; pal: InteriorPalette; color: string; level: React.RefObject<number> }) {
  const frameMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: board.kind === 'whiteboard' ? '#cfd6dc' : pal.woodDark, roughness: board.kind === 'whiteboard' ? 0.4 : 0.6, metalness: board.kind === 'whiteboard' ? 0.5 : 0 }),
    [board.kind, pal],
  );
  const faceMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: board.kind === 'whiteboard' ? '#f7f9fb' : '#ead9b8', roughness: 0.85 }),
    [board.kind],
  );
  const cardMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#fff8ea', roughness: 0.9 }), []);
  const stripMat = useMemo(() => new THREE.MeshBasicMaterial({ color, toneMapped: false }), [color]);
  const stickies = useMemo(() => STICKY.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 })), []);
  useFrame(() => {
    const k = 0.06 + 0.12 * (level.current ?? 1);
    faceMat.emissive.copy(faceMat.color);
    faceMat.emissiveIntensity = k;
    cardMat.emissive.copy(cardMat.color);
    cardMat.emissiveIntensity = k;
    for (const m of stickies) {
      m.emissive.copy(m.color);
      m.emissiveIntensity = k;
    }
  });
  const [bx, by, bz] = board.position;
  const rim = 0.07;
  return (
    <group position={[bx, by, bz]} rotation={[0, board.yaw, 0]} name="board">
      <mesh material={frameMat} castShadow>
        <boxGeometry args={[board.width + rim * 2, board.height + rim * 2, 0.05]} />
      </mesh>
      <mesh material={faceMat} position={[0, 0, 0.03]}>
        <boxGeometry args={[board.width, board.height, 0.02]} />
      </mesh>
      {board.kind === 'whiteboard' ? (
        <mesh material={frameMat} position={[0, -board.height / 2 - rim - 0.03, 0.05]}>
          <boxGeometry args={[board.width * 0.7, 0.05, 0.12]} />
        </mesh>
      ) : null}
      {board.slots.map((s, i) => (
        <group key={i} position={[s.position[0] - bx, s.position[1] - by, s.position[2] - bz + 0.012]}>
          <mesh material={board.kind === 'whiteboard' ? stickies[i % stickies.length] : cardMat} rotation={[0, 0, board.kind === 'whiteboard' ? ((i % 3) - 1) * 0.035 : 0]}>
            <planeGeometry args={[s.width * 0.92, s.height * 0.9]} />
          </mesh>
          {board.kind === 'frame' ? (
            <mesh material={stripMat} position={[0, s.height * 0.4, 0.002]}>
              <planeGeometry args={[s.width * 0.92, s.height * 0.12]} />
            </mesh>
          ) : null}
        </group>
      ))}
    </group>
  );
}

// ------------------------------------------------------------------ 좌석 디버그 표시(?seats=1)

function SeatMarkers({ spec }: { spec: InteriorSpec }) {
  const show = useMemo(() => typeof location !== 'undefined' && new URLSearchParams(location.search).get('seats') === '1', []);
  if (!show) return null;
  return (
    <group>
      {spec.seats.map((s) => (
        <group key={s.index} position={[s.position[0], 0.05, s.position[2]]} rotation={[0, s.yaw, 0]}>
          <mesh rotation-x={-Math.PI / 2}>
            <ringGeometry args={[SEAT_CLEARANCE - 0.04, SEAT_CLEARANCE, 32]} />
            <meshBasicMaterial color="#ff2bd6" toneMapped={false} depthTest={false} transparent opacity={0.9} />
          </mesh>
          <mesh position={[0, 0, 0.2]} rotation-x={Math.PI / 2}>
            <coneGeometry args={[0.07, 0.2, 8]} />
            <meshBasicMaterial color="#ff2bd6" toneMapped={false} depthTest={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// ------------------------------------------------------------------ 본체

function DioramaInner({ ctx }: { ctx: CapsuleInteriorContext }) {
  const { model, dims, quality } = ctx;
  const spec = useMemo(() => interiorSpec(model.theme, model.themeVariant, dims), [model.theme, model.themeVariant, dims]);
  const ids = useMemo(() => interiorPropIds(spec), [spec]);
  const parts = usePropParts(ids);
  const membersKey = model.memberColors.join('|');
  const pal = useMemo(
    () => interiorPalette(model.theme, model.themeVariant, model.color, model.memberColors),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model.theme, model.themeVariant, model.color, membersKey],
  );
  const baked = useMemo(() => bakeInterior(spec, parts, pal, quality), [spec, parts, pal, quality]);
  useEffect(() => () => baked.dispose(), [baked]);

  const wallGeo = useMemo(() => wallGeometry(dims, spec, pal), [dims, spec, pal]);
  const floorGeo = useMemo(() => {
    const g = stadiumSlab(dims.floorHalfLength - 0.015, dims.floorHalfDepth - 0.015, 0.001, 0.0045);
    return g;
  }, [dims]);
  useEffect(
    () => () => {
      wallGeo.dispose();
      floorGeo.dispose();
    },
    [wallGeo, floorGeo],
  );
  const floorMat = useMemo(() => {
    const t = floorTexture(spec.floor).clone();
    t.needsUpdate = true;
    t.repeat.set(1 / 2.2, 1 / 2.2);
    return new THREE.MeshStandardMaterial({ map: t, color: FLOOR_COLOR[spec.floor], roughness: 0.55 });
  }, [spec.floor]);
  const wallMat = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide }), []);

  const mats = useMemo(
    () =>
      baked.meshes.map((m) => {
        if (m.kind === 'glass') {
          return new THREE.MeshPhysicalMaterial({ color: m.color, transparent: true, opacity: 0.4, roughness: 0.1, depthWrite: false });
        }
        const mat = new THREE.MeshStandardMaterial({
          color: m.color,
          roughness: m.kind === 'metal' ? 0.38 : 0.72,
          metalness: m.kind === 'metal' ? 0.55 : 0,
        });
        mat.emissive.copy(m.color);
        mat.emissiveIntensity = 0.1;
        return mat;
      }),
    [baked],
  );
  const lampMats = useMemo(
    () => baked.lamps.map(() => new THREE.MeshStandardMaterial({ color: LAMP_SHADE, emissive: WARM, emissiveIntensity: 1, roughness: 0.6 })),
    [baked],
  );
  useEffect(
    () => () => {
      [...mats, ...lampMats, floorMat, wallMat].forEach((m) => m.dispose());
    },
    [mats, lampMats, floorMat, wallMat],
  );

  // 조명 단계 → 실내 자체 발광 + 램프 갓 emissive (InteriorLights와 같은 목표값을 따라간다)
  const cur = useRef({ level: model.ambience === 'empty' ? 0 : 1, agent: 0, shade: ambienceTargets(model.ambience).shade, cool: ambienceTargets(model.ambience).cool, frost: frostOf(model.glass), lamp0: 1, others: 1 });
  const baseColors = useMemo(() => mats.map((m) => (m as THREE.MeshStandardMaterial).color.clone()), [mats]);
  const shadeTint = useMemo(() => new THREE.Color(), []);
  const level = useRef(1);
  const tmp = useMemo(() => new THREE.Color(), []);
  useFrame((state, dt) => {
    const t = ambienceTargets(model.ambience);
    const c = cur.current;
    c.level = THREE.MathUtils.damp(c.level, t.level, 4, dt);
    c.agent = THREE.MathUtils.damp(c.agent, t.agent, 4, dt);
    c.shade = THREE.MathUtils.damp(c.shade, t.shade, 4, dt);
    c.cool = THREE.MathUtils.damp(c.cool, t.cool, 4, dt);
    c.lamp0 = THREE.MathUtils.damp(c.lamp0, t.lamp0, 4, dt);
    c.others = THREE.MathUtils.damp(c.others, t.others, 4, dt);
    c.frost = THREE.MathUtils.damp(c.frost, frostOf(model.glass), 1 / 0.6, dt);
    level.current = c.shade;
    // 조명 단계: 소품 전체의 밝기·색온도를 곱한다(occupied 따뜻하고 밝음 / agentOnly 어둡고 스탠드만 / empty 어둡고 차가움). 서리 유리 너머는 실루엣 위주로
    const k = c.shade * (1 - 0.45 * c.frost);
    shadeTint.setRGB(
      THREE.MathUtils.lerp(1.04, 0.5, c.cool) * k,
      THREE.MathUtils.lerp(0.97, 0.62, c.cool) * k,
      THREE.MathUtils.lerp(0.88, 1.0, c.cool) * k,
    );
    mats.forEach((m, i) => {
      if (baked.meshes[i]!.kind !== 'glass') (m as THREE.MeshStandardMaterial).color.copy(baseColors[i]!).multiply(shadeTint);
    });
    wallMat.color.copy(shadeTint);
    floorMat.color.copy(new THREE.Color(FLOOR_COLOR[spec.floor])).multiply(shadeTint);
    const selfLight = 0.02 + 0.05 * c.shade;
    mats.forEach((m, i) => {
      if (baked.meshes[i]!.kind !== 'glass') (m as THREE.MeshStandardMaterial).emissiveIntensity = selfLight;
    });
    floorMat.emissive.copy(WARM);
    floorMat.emissiveIntensity = 0.01 + 0.025 * c.shade;
    wallMat.emissive.setRGB(0.5, 0.36, 0.25);
    wallMat.emissiveIntensity = 0.01 + 0.05 * c.shade;
    lampMats.forEach((m, i) => {
      tmp.copy(WARM);
      if (i === 0) tmp.lerp(AGENT, 0.6 * c.agent);
      m.emissive.copy(tmp);
      m.emissiveIntensity = 0.1 + 2.6 * (i === 0 ? c.lamp0 : c.others);
    });
  });

  return (
    <group name="diorama">
      <mesh geometry={floorGeo} material={floorMat} receiveShadow />
      <mesh geometry={wallGeo} material={wallMat} receiveShadow />
      {baked.meshes.map((m, i) => (
        <mesh key={i} geometry={m.geometry} material={mats[i]} castShadow={m.kind !== 'glass'} receiveShadow />
      ))}
      {baked.lamps.map((l, i) => (
        <mesh key={`l${i}`} geometry={l.geometry} material={lampMats[i]} />
      ))}
      <BoardObject board={spec.board} pal={pal} color={model.color} level={level} />
      <BoardToolProps roomId={model.roomId} slots={spec.toolSlots} scale={spec.toolScale} />
      <SeatMarkers spec={spec} />
    </group>
  );
}

/**
 * 테마별 미니어처 실내(S17). GLB가 로드되는 동안에는 PlaceholderInterior를 보여 준다.
 * `renderInterior={(ctx) => <Diorama ctx={ctx} />}`로 쓰거나, WorldCanvas의 기본 실내로 쓰인다.
 */
export function Diorama({ ctx }: { ctx: CapsuleInteriorContext }) {
  return (
    <Suspense
      fallback={
        <PlaceholderInterior dims={ctx.dims} color={ctx.model.color} seats={themeSeats(ctx.model.theme, ctx.model.themeVariant)} />
      }
    >
      <DioramaInner ctx={ctx} />
    </Suspense>
  );
}
