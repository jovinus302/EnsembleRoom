import * as THREE from 'three';
import type { CapsuleDims } from './dims';

/** 색 정지점 배열에서 t(0..1)의 선형 보간 색 (linear 작업 색공간) */
export function gradientAt(stops: readonly string[], t: number, wrap = false): THREE.Color {
  const cols = stops.map((s) => new THREE.Color(s));
  if (cols.length === 1) return cols[0]!;
  const list = wrap ? [...cols, cols[0]!] : cols;
  const f = Math.min(Math.max(t, 0), 0.99999) * (list.length - 1);
  const i = Math.floor(f);
  return list[i]!.clone().lerp(list[i + 1]!, f - i);
}

export function paintGradient(
  geo: THREE.BufferGeometry,
  stops: readonly string[],
  tOf: (x: number, y: number, z: number) => number,
  wrap = false,
) {
  const pos = geo.getAttribute('position');
  const arr = new Float32Array(pos.count * 3);
  const cache = new Map<number, THREE.Color>();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.round(tOf(pos.getX(i), pos.getY(i), pos.getZ(i)) * 200) / 200;
    let c = cache.get(t);
    if (!c) {
      c = gradientAt(stops, t, wrap);
      cache.set(t, c);
    }
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

export function stadiumShape(halfLen: number, halfDepth: number): THREE.Shape {
  const r = halfDepth;
  const s = Math.max(halfLen - r, 0);
  const sh = new THREE.Shape();
  sh.moveTo(-s, -r);
  sh.lineTo(s, -r);
  sh.absarc(s, 0, r, -Math.PI / 2, Math.PI / 2, false);
  sh.lineTo(-s, r);
  sh.absarc(-s, 0, r, Math.PI / 2, (3 * Math.PI) / 2, false);
  return sh;
}

/** 스타디움 판. y0~y1 구간, XZ 평면 */
export function stadiumSlab(halfLen: number, halfDepth: number, y0: number, y1: number): THREE.ExtrudeGeometry {
  const g = new THREE.ExtrudeGeometry(stadiumShape(halfLen, halfDepth), {
    depth: y1 - y0,
    bevelEnabled: false,
    curveSegments: 28,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  return g;
}

/** 바닥에 놓는 납작한 스타디움 고리(선택 후광) */
export function stadiumRing(halfLen: number, halfDepth: number, width: number): THREE.ShapeGeometry {
  const outer = stadiumShape(halfLen + width, halfDepth + width);
  outer.holes.push(stadiumShape(halfLen, halfDepth));
  const g = new THREE.ShapeGeometry(outer, 28);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** 가로로 누운 알약(긴 축 = x) */
export function pillGeometry(d: CapsuleDims, scale = 1): THREE.CapsuleGeometry {
  const g = new THREE.CapsuleGeometry(d.radius * scale, d.length, 16, 56);
  g.rotateZ(Math.PI / 2);
  return g;
}

/** 이음매 링: x 축 둘레. 둘레 각도에 따라 구성원 색 그라데이션 */
export function seamRing(radius: number, colors: readonly string[]): THREE.TorusGeometry {
  const g = new THREE.TorusGeometry(radius, 0.055, 14, 72);
  g.rotateY(Math.PI / 2);
  paintGradient(g, colors, (_x, y, z) => (Math.atan2(y, z) / Math.PI + 1) / 2, true);
  return g;
}
