import * as THREE from 'three';
import type { Placement } from '../layout';
import { interiorSpec } from '../interiors/layouts';
import type { CapsuleModel } from '../types';

/** 연출용 월드 좌표 도우미. 캡슐 로컬(바닥 윗면 원점, +x 길이, +z 관객) ↔ 월드 */

export function capsuleCenter(p: Placement, out = new THREE.Vector3(), lift = 0): THREE.Vector3 {
  return out.set(p.x, p.dims.axisHeight + lift, p.z);
}

export function localToWorld(p: Placement, lx: number, ly: number, lz: number, out = new THREE.Vector3()): THREE.Vector3 {
  const c = Math.cos(p.rotY);
  const s = Math.sin(p.rotY);
  return out.set(p.x + lx * c + lz * s, p.dims.floorHeight + ly, p.z - lx * s + lz * c);
}

export function worldToLocal(p: Placement, wx: number, wz: number): [number, number] {
  const dx = wx - p.x;
  const dz = wz - p.z;
  const c = Math.cos(p.rotY);
  const s = Math.sin(p.rotY);
  return [dx * c - dz * s, dx * s + dz * c];
}

export function interiorAnchor(model: CapsuleModel, p: Placement, kind: 'shelf' | 'board' | 'door', out = new THREE.Vector3()): THREE.Vector3 {
  const spec = interiorSpec(model.theme, model.themeVariant, p.dims);
  if (kind === 'shelf') {
    const [x, y, z] = spec.memoryShelf.position;
    return localToWorld(p, x, y, z, out);
  }
  if (kind === 'board') {
    const [x, y, z] = spec.board.position;
    return localToWorld(p, x, y, z, out);
  }
  return localToWorld(p, p.dims.floorHalfLength * 0.75, 0.8, p.dims.floorHalfDepth * 0.6, out);
}

/** 튜브 위 한 점. from>to 튜브가 있으면 그대로, to>from이면 뒤집어 읽는다. 없으면 false */
export function tubePoint(
  curves: ReadonlyMap<string, THREE.Curve<THREE.Vector3>>,
  from: string,
  to: string,
  u: number,
  out: THREE.Vector3,
): boolean {
  const f = curves.get(`${from}>${to}`);
  if (f) {
    f.getPointAt(THREE.MathUtils.clamp(u, 0, 1), out);
    return true;
  }
  const r = curves.get(`${to}>${from}`);
  if (r) {
    r.getPointAt(THREE.MathUtils.clamp(1 - u, 0, 1), out);
    return true;
  }
  return false;
}

/** roomId에 닿는 첫 튜브의 (이웃 roomId) */
export function firstNeighbor(curves: ReadonlyMap<string, unknown>, roomId: string): string | null {
  for (const k of curves.keys()) {
    const [a, b] = k.split('>');
    if (a === roomId && b) return b;
    if (b === roomId && a) return a;
  }
  return null;
}

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
