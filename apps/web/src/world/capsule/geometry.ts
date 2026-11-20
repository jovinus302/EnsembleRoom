import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CapsuleDims } from './dims';
import { makeOutline, outlineAt } from './outline';

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

/** 스타디움 측면 띠(비인덱스). 사각형마다 중점 색을 단색으로 칠한다. 법선은 둘레 바깥 법선 */
export function stadiumBand(
  halfL: number,
  halfD: number,
  y0: number,
  y1: number,
  colorAt: (x: number, z: number) => THREE.Color,
  step = 0.08,
): THREE.BufferGeometry {
  const o = makeOutline(halfL, halfD);
  const n = Math.max(8, Math.ceil(o.P / step));
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const push = (x: number, y: number, z: number, nx: number, nz: number, c: THREE.Color) => {
    pos.push(x, y, z);
    nor.push(nx, 0, nz);
    col.push(c.r, c.g, c.b);
  };
  for (let i = 0; i < n; i++) {
    const sa = -o.P / 2 + (o.P * i) / n;
    const sb = -o.P / 2 + (o.P * (i + 1)) / n;
    const a = outlineAt(o, sa);
    const b = outlineAt(o, sb);
    const m = outlineAt(o, (sa + sb) / 2);
    const c = colorAt(m.x, m.z);
    // 바깥에서 볼 때 반시계: (A,C,D) (A,B,C), A=(a,y0) B=(a,y1) C=(b,y1) D=(b,y0)
    push(a.x, y0, a.z, a.nx, a.nz, c);
    push(b.x, y1, b.z, b.nx, b.nz, c);
    push(b.x, y0, b.z, b.nx, b.nz, c);
    push(a.x, y0, a.z, a.nx, a.nz, c);
    push(a.x, y1, a.z, a.nx, a.nz, c);
    push(b.x, y1, b.z, b.nx, b.nz, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/** x 방향 폭 w마다 구성원 색을 순환하는 줄무늬 */
export function stripeColorAt(colors: readonly string[], halfL: number, w = 0.5): (x: number, z: number) => THREE.Color {
  const cols = colors.map((c) => new THREE.Color(c));
  const n = Math.max(cols.length, 1);
  return (x) => cols[Math.max(Math.floor((x + halfL) / w), 0) % n] ?? new THREE.Color('#ffffff');
}

/** Our 마루 앞쪽에 구성원 수만큼 놓는 색 구슬(최대 6). 병합 + vertex color */
export function memberDots(colors: readonly string[], d: CapsuleDims): THREE.BufferGeometry {
  const list = colors.slice(0, 6);
  const parts = list.map((c, i) => {
    const g = new THREE.SphereGeometry(0.17, 16, 12);
    g.translate((i - (list.length - 1) / 2) * 0.52, 0.17, d.floorHalfDepth + 0.42);
    const col = new THREE.Color(c);
    const arr = new Float32Array(g.getAttribute('position').count * 3);
    for (let k = 0; k < arr.length; k += 3) {
      arr[k] = col.r;
      arr[k + 1] = col.g;
      arr[k + 2] = col.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  });
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  return merged ?? new THREE.BufferGeometry();
}
