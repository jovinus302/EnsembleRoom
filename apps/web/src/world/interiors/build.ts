import { useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ThemeId, ThemeVariant } from '@ensemble/shared';
import { MINI_SCALE } from '../capsule/dims';
import type { QualityTier } from '../quality';
import { interiorPropIds, interiorSpec, tierAllows, type InteriorSpec, type PropSpec, type V3 } from './layouts';

// ------------------------------------------------------------------ GLB 로딩 (drei useGLTF 캐시)

const propUrl = (id: string) => `/assets/props/${id}.glb`;

export interface PropPart {
  /** 피벗을 "바닥 중앙"으로 옮긴 geometry(미터, 원본 단위). 공유되므로 수정 금지(복제해서 쓴다) */
  geometry: THREE.BufferGeometry;
  mat: string;
  color: THREE.Color;
}

const partsCache = new Map<string, PropPart[]>();

function extractParts(id: string, scene: THREE.Object3D): PropPart[] {
  const hit = partsCache.get(id);
  if (hit) return hit;
  scene.updateMatrixWorld(true);
  const parts: PropPart[] = [];
  const box = new THREE.Box3();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    const mat = Array.isArray(m.material) ? m.material[0]! : m.material;
    const std = mat as THREE.MeshStandardMaterial;
    parts.push({ geometry: g, mat: mat.name || 'default', color: (std.color ?? new THREE.Color('#ffffff')).clone() });
    g.computeBoundingBox();
    box.union(g.boundingBox!);
  });
  // props-manifest의 pivotOffset과 같은 결과: 바닥 중앙을 원점으로
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  for (const p of parts) {
    p.geometry.translate(-cx, -box.min.y, -cz);
    // 병합 시 속성이 같아야 한다. uv는 쓰지 않는다
    p.geometry.deleteAttribute('uv');
    if (p.geometry.index) p.geometry = p.geometry.toNonIndexed();
  }
  partsCache.set(id, parts);
  return parts;
}

/** drei useGLTF로 로드(Draco/meshopt 디코더를 CDN에서 받지 않도록 둘 다 끈다). Suspense를 던진다 */
export function usePropParts(ids: readonly string[]): ReadonlyMap<string, PropPart[]> {
  const gltfs = useGLTF(ids.map(propUrl), false, false);
  return useMemo(() => {
    const out = new Map<string, PropPart[]>();
    ids.forEach((id, i) => out.set(id, extractParts(id, (gltfs[i] as { scene: THREE.Object3D }).scene)));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gltfs]);
}

/** 방 목록에 나온 테마의 소품을 미리 받아 둔다 */
export function preloadInteriors(rooms: readonly { theme: ThemeId; themeVariant: ThemeVariant | null; kind: string }[]) {
  const ids = new Set<string>();
  for (const r of rooms) {
    const spec = interiorSpec(r.theme, r.themeVariant, dimsFor(r.kind === 'our' ? 'plump' : 'long'));
    interiorPropIds(spec).forEach((i) => ids.add(i));
  }
  ids.forEach((id) => useGLTF.preload(propUrl(id), false, false));
}

import { capsuleDims } from '../capsule/dims';
const dimsFor = capsuleDims;

// ------------------------------------------------------------------ 팔레트

export interface InteriorPalette {
  wood: THREE.Color;
  woodDark: THREE.Color;
  accent: THREE.Color;
  accent2: THREE.Color;
  cream: THREE.Color;
  plant: THREE.Color;
  metalWarm: THREE.Color;
  wall: THREE.Color;
  wallLow: THREE.Color;
  trim: THREE.Color;
}

const c = (hex: string) => new THREE.Color(hex);

/** 테마 기본 톤에 소유자(구성원) 색을 입힌다 → 같은 테마여도 캡슐마다 다른 개성 */
export function interiorPalette(theme: ThemeId, variant: ThemeVariant | null, color: string, members: readonly string[]): InteriorPalette {
  const owner = c(color);
  const second = c(members[1] ?? members[0] ?? color);
  const cream = c('#f6ead6');
  const base =
    theme === 'studio'
      ? { wood: '#e4c49a', wall: '#aebfd9', accent2: '#6fa3c8', low: 0.82 }
      : theme === 'lounge'
        ? { wood: '#a06b45', wall: '#cdb4c9', accent2: '#c0614f', low: 0.8 }
        : variant === 'meeting'
          ? { wood: '#c9a77f', wall: '#cfd8d6', accent2: '#4f86a8', low: 0.85 }
          : { wood: '#d5a06a', wall: '#f0d9b8', accent2: '#5f93b3', low: 0.86 };
  const wood = c(base.wood).lerp(owner, 0.07);
  const accent = owner.clone().lerp(cream, 0.12);
  const accent2 = c(base.accent2).lerp(second, theme === 'cafe' ? 0.35 : 0.12);
  const wall = c(base.wall).lerp(owner, 0.16);
  return {
    wood,
    woodDark: wood.clone().multiplyScalar(0.78),
    accent,
    accent2,
    cream,
    plant: c('#3fa86b'),
    metalWarm: c('#ffd7a8'),
    wall,
    wallLow: wall.clone().multiplyScalar(base.low),
    trim: cream.clone().lerp(wood, 0.25),
  };
}

// ------------------------------------------------------------------ 굽기(병합)

export type MatKind = 'std' | 'metal' | 'glass';
export interface BakedMesh {
  geometry: THREE.BufferGeometry;
  kind: MatKind;
  color: THREE.Color;
}
export interface BakedLamp {
  geometry: THREE.BufferGeometry;
  /** 전구(갓) 중심(내부 좌표계) */
  position: THREE.Vector3;
}
export interface BakedInterior {
  meshes: BakedMesh[];
  lamps: BakedLamp[];
  dispose: () => void;
}

function resolveColor(mat: string, orig: THREE.Color, pal: InteriorPalette, tone: 'a' | 'b'): { kind: MatKind; color: THREE.Color } {
  const lower = mat.toLowerCase();
  if (lower === 'wood') return { kind: 'std', color: pal.wood };
  if (lower === 'wooddark') return { kind: 'std', color: pal.woodDark };
  if (lower === 'carpetdarker') return { kind: 'std', color: (tone === 'a' ? pal.accent : pal.accent2).clone().multiplyScalar(0.72) };
  if (lower === 'carpetwhite') return { kind: 'std', color: pal.cream };
  if (lower === 'carpetblue') return { kind: 'std', color: pal.accent2 };
  if (lower === 'carpet') return { kind: 'std', color: tone === 'a' ? pal.accent : pal.accent2 };
  if (lower === 'plant') return { kind: 'std', color: pal.plant.clone().lerp(orig, 0.35) };
  if (lower === 'glass') return { kind: 'glass', color: orig };
  if (lower.startsWith('metal')) return { kind: 'metal', color: orig.clone().lerp(pal.metalWarm, 0.18) };
  if (lower === '_defaultmat') return { kind: 'std', color: pal.cream };
  return { kind: 'std', color: orig };
}

const lampLift: Record<string, number> = {
  'lamp-square-table': 0.22,
  'lamp-round-table': 0.24,
  'lamp-round-floor': 0.72,
  'lamp-square-floor': 0.72,
  'lamp-wall': 0.05,
};

export function bakeInterior(
  spec: InteriorSpec,
  parts: ReadonlyMap<string, PropPart[]>,
  pal: InteriorPalette,
  tier: QualityTier,
): BakedInterior {
  const groups = new Map<string, { kind: MatKind; color: THREE.Color; geos: THREE.BufferGeometry[] }>();
  const lamps: BakedLamp[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);

  for (const p of spec.props) {
    if (!tierAllows(p.p, tier)) continue;
    const ps = parts.get(p.id);
    if (!ps) continue;
    const sv = typeof p.s === 'number' ? ([p.s, p.s, p.s] as V3) : (p.s ?? [1, 1, 1]);
    q.setFromAxisAngle(up, ((p.rot ?? 0) * Math.PI) / 180);
    m.compose(
      new THREE.Vector3(p.x, p.y ?? 0, p.z),
      q,
      new THREE.Vector3(MINI_SCALE * spec.scale * sv[0], MINI_SCALE * spec.scale * sv[1], MINI_SCALE * spec.scale * sv[2]),
    );
    const isLamp = p.id.startsWith('lamp-');
    let lampGeos: THREE.BufferGeometry[] | null = null;
    for (const part of ps) {
      const g = part.geometry.clone();
      g.applyMatrix4(m);
      if (isLamp && part.mat === 'lamp') {
        (lampGeos ??= []).push(g);
        continue;
      }
      const { kind, color } = resolveColor(part.mat, part.color, pal, p.tone ?? 'a');
      const key = `${kind}|${color.getHexString()}`;
      let grp = groups.get(key);
      if (!grp) groups.set(key, (grp = { kind, color, geos: [] }));
      grp.geos.push(g);
    }
    if (isLamp && lampGeos) {
      const lift = (lampLift[p.id] ?? 0.2) * MINI_SCALE * spec.scale * (typeof p.s === 'number' ? p.s : 1);
      lamps.push({
        geometry: mergeGeometries(lampGeos)!,
        position: new THREE.Vector3(p.x, (p.y ?? 0) + lift, p.z),
      });
    }
  }
  const meshes: BakedMesh[] = [];
  for (const g of groups.values()) {
    const merged = mergeGeometries(g.geos, false);
    g.geos.forEach((x) => x.dispose());
    if (merged) meshes.push({ geometry: merged, kind: g.kind, color: g.color });
  }
  // 가장 앞(+z)에 있는 등이 첫 번째: Agent 색을 받는 "가장 가까운 등"
  lamps.sort((a, b) => b.position.z - a.position.z);
  return {
    meshes,
    lamps,
    dispose: () => {
      meshes.forEach((x) => x.geometry.dispose());
      lamps.forEach((x) => x.geometry.dispose());
    },
  };
}

export type { PropSpec };

/** 실내 등의 전구 위치(내부 좌표계). GLB 없이 레이아웃 데이터만으로 계산한다. 가장 앞(+z) 등이 첫 번째 */
export function interiorLampPoints(spec: InteriorSpec, tier: QualityTier): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (const p of spec.props) {
    if (!p.id.startsWith('lamp-') || !tierAllows(p.p, tier)) continue;
    const lift = (lampLift[p.id] ?? 0.2) * MINI_SCALE * spec.scale * (typeof p.s === 'number' ? p.s : 1);
    pts.push(new THREE.Vector3(p.x, (p.y ?? 0) + lift, p.z));
  }
  return pts.sort((a, b) => b.z - a.z);
}
