import type { Placement } from '../layout';

/**
 * 받침 벽 스타디움 둘레의 1차원 좌표 s (캡슐 로컬).
 *  - s = 0은 뒤(-z) 벽 중앙. +s는 +x 끝 쪽, -s는 -x 끝 쪽. ±P/2가 앞벽 중앙(간판 구역)이다.
 */
export const FRONT_ALPHA_MAX = (80 * Math.PI) / 180;

export interface Outline {
  halfL: number;
  halfD: number;
  seg: number;
  r: number;
  /** 둘레 길이 */
  P: number;
  /** 포트 허용 |s| 상한: 앞벽 직선부와 끝 반원 80도 이후(간판 구역)는 금지 */
  sMax: number;
}

export function makeOutline(halfL: number, halfD: number): Outline {
  const r = halfD;
  const seg = halfL - halfD;
  return { halfL, halfD, seg, r, P: 4 * seg + 2 * Math.PI * r, sMax: seg + r * (Math.PI / 2 + FRONT_ALPHA_MAX) };
}

/** 로컬 위치와 바깥 법선 */
export function outlineAt(o: Outline, s: number): { x: number; z: number; nx: number; nz: number } {
  const sg = s >= 0 ? 1 : -1;
  const a = Math.abs(s);
  const { seg, r } = o;
  if (a <= seg) return { x: sg * a, z: -r, nx: 0, nz: -1 };
  if (a <= seg + Math.PI * r) {
    const al = (a - seg) / r - Math.PI / 2;
    return { x: sg * (seg + r * Math.cos(al)), z: r * Math.sin(al), nx: sg * Math.cos(al), nz: Math.sin(al) };
  }
  const b = a - seg - Math.PI * r;
  return { x: sg * (seg - b), z: r, nx: 0, nz: 1 };
}

/** 로컬 점 (lx, lz)에 가장 가까운 둘레 좌표 s */
export function outlineNearestS(o: Outline, lx: number, lz: number): number {
  const sg = lx >= 0 ? 1 : -1;
  const ax = Math.abs(lx);
  const { seg, r } = o;
  if (ax <= seg) return lz < 0 ? sg * ax : sg * (2 * seg + Math.PI * r - ax);
  return sg * (seg + r * (Math.atan2(lz, ax - seg) + Math.PI / 2));
}

/** 스타디움까지 부호 있는 거리(<0이면 안쪽) */
export function sdOutline(o: Outline, lx: number, lz: number): number {
  const cx = Math.max(-o.seg, Math.min(o.seg, lx));
  return Math.hypot(lx - cx, lz) - o.r;
}

/** 월드 -> 캡슐 로컬 (fx/geo와 같은 회전 규약) */
export function toLocal(p: Pick<Placement, 'x' | 'z' | 'rotY'>, wx: number, wz: number): { x: number; z: number } {
  const c = Math.cos(p.rotY);
  const s = Math.sin(p.rotY);
  const dx = wx - p.x;
  const dz = wz - p.z;
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

/** 캡슐 로컬 -> 월드 */
export function toWorld(p: Pick<Placement, 'x' | 'z' | 'rotY'>, lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(p.rotY);
  const s = Math.sin(p.rotY);
  return { x: p.x + lx * c + lz * s, z: p.z - lx * s + lz * c };
}
