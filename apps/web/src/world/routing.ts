import * as THREE from 'three';
import { footprintHalf } from './capsule/dims';
import { makeOutline, outlineAt, outlineNearestS, sdOutline, toLocal, toWorld, type Outline } from './capsule/outline';
import { spreadMinGap, type Placement, type WorldLayout } from './layout';

/**
 * 유리 관 경로의 단일 소스(계획 8.3). 렌더(GlassTube)와 캐릭터 이동(curves 맵)이 모두 이 모듈의 결과만 쓴다.
 * 순수 함수라 three 장면 없이 테스트할 수 있다.
 */
export const TUBE_R = 0.36;
/** 튜브 중심선 높이: 모래 위에 낮게 놓인다 */
export const TUBE_Y = TUBE_R + 0.03;

const K_RATIO = 0.4;
const K_MIN = 1.0;
const K_MAX = 6;
const LEAD = 1.44;
const CLEAR = 0.9;
export const ARCH_H = 1.1;
export const ARCH_W = 3.0;
const SAMPLES_PER_UNIT = 3;
const SEG_MIN = 24;
const SEG_MAX = 72;
const PORT_GAP = 1.3;
const MAX_WAYPOINTS = 2;

export interface TubePort {
  roomId: string;
  /** 받침 벽 스타디움 둘레 좌표(outline.ts) */
  s: number;
  pos: THREE.Vector3;
  normal: THREE.Vector3;
}

export interface TubeRoute {
  key: string;
  from: string;
  to: string;
  curve: THREE.CatmullRomCurve3;
  portA: TubePort;
  portB: TubePort;
  segments: number;
  length: number;
  /** 다른 관 위로 아치로 넘어가는가 */
  arched: boolean;
  /** 다른 캡슐 여유 구역을 침범하는 남은 양(0이면 깨끗) */
  intruded: number;
}

/** 발자국(받침 slab 포함) 스타디움까지 부호 있는 거리(<0이면 안쪽) */
export function sdFootprint(p: Placement, wx: number, wz: number): number {
  const fp = footprintHalf(p.dims);
  const l = toLocal(p, wx, wz);
  return sdOutline(makeOutline(fp.hl, fp.hd), l.x, l.z);
}

const baseOutline = (p: Placement): Outline => makeOutline(p.dims.baseHalfLength, p.dims.baseHalfDepth);

function portWorld(p: Placement, o: Outline, s: number) {
  const q = outlineAt(o, s);
  const w = toWorld(p, q.x, q.z);
  const c = Math.cos(p.rotY);
  const sn = Math.sin(p.rotY);
  return {
    pos: new THREE.Vector3(w.x, TUBE_Y, w.z),
    normal: new THREE.Vector3(q.nx * c + q.nz * sn, 0, -q.nx * sn + q.nz * c),
  };
}

interface End {
  key: string;
  roomId: string;
  otherId: string;
  tubeKey: string;
  which: 'a' | 'b';
  s: number;
}

/** 캡슐마다 포트를 둘레 위에 배정: 상대 쪽 최근접점에서 시작해 최소 간격으로 펼친다. 2패스 */
function assignPorts(layout: WorldLayout): Map<string, End> {
  const ends: End[] = [];
  for (const t of layout.tubes) {
    const tubeKey = `${t.from}>${t.to}`;
    ends.push({ key: `${tubeKey}|a`, roomId: t.from, otherId: t.to, tubeKey, which: 'a', s: 0 });
    ends.push({ key: `${tubeKey}|b`, roomId: t.to, otherId: t.from, tubeKey, which: 'b', s: 0 });
  }
  const byRoom = new Map<string, End[]>();
  for (const e of ends) {
    const list = byRoom.get(e.roomId) ?? [];
    list.push(e);
    byRoom.set(e.roomId, list);
  }
  const byKey = new Map(ends.map((e) => [e.key, e]));
  const otherEnd = (e: End) => byKey.get(`${e.tubeKey}|${e.which === 'a' ? 'b' : 'a'}`)!;

  const run = (target: (e: End) => { x: number; z: number }) => {
    const want = new Map<string, number>();
    for (const e of ends) {
      const p = layout.placements[e.roomId]!;
      const o = baseOutline(p);
      const t = target(e);
      const l = toLocal(p, t.x, t.z);
      want.set(e.key, Math.max(-o.sMax, Math.min(o.sMax, outlineNearestS(o, l.x, l.z))));
    }
    for (const [roomId, list] of byRoom) {
      const o = baseOutline(layout.placements[roomId]!);
      list.sort((a, b) => want.get(a.key)! - want.get(b.key)! || (a.key < b.key ? -1 : 1));
      const spread = spreadMinGap(
        list.map((e) => want.get(e.key)!),
        PORT_GAP,
        -o.sMax,
        o.sMax,
      );
      list.forEach((e, i) => {
        e.s = spread[i]!;
      });
    }
  };

  run((e) => {
    const q = layout.placements[e.otherId]!;
    return { x: q.x, z: q.z };
  });
  run((e) => {
    const oe = otherEnd(e);
    const q = layout.placements[oe.roomId]!;
    const w = portWorld(q, baseOutline(q), oe.s);
    return { x: w.pos.x, z: w.pos.z };
  });
  return byKey;
}

/** xz 선분 교차: [a0,a1] x [b0,b1] -> (t,u) 또는 null */
function segHit(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number) {
  const rx = bx - ax;
  const rz = bz - az;
  const sx = dx - cx;
  const sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / den;
  const u = ((cx - ax) * rz - (cz - az) * rx) / den;
  if (t < 0 || t >= 1 || u < 0 || u >= 1) return null;
  return { t, u };
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

interface Work {
  key: string;
  from: string;
  to: string;
  rank: 0 | 1;
  order: number;
  pts: THREE.Vector3[];
  cum: number[];
  len: number;
  /** 이 관이 올라가야 하는 교차 위치(호 길이) */
  lifts: number[];
  portA: TubePort;
  portB: TubePort;
  intruded: number;
}

export function routeTubes(layout: WorldLayout): Map<string, TubeRoute> {
  const ends = assignPorts(layout);
  const placements = Object.values(layout.placements);
  const works: Work[] = [];

  layout.tubes.forEach((t, order) => {
    const key = `${t.from}>${t.to}`;
    const pa = layout.placements[t.from];
    const pb = layout.placements[t.to];
    const ea = ends.get(`${key}|a`);
    const eb = ends.get(`${key}|b`);
    if (!pa || !pb || !ea || !eb) return;
    const wa = portWorld(pa, baseOutline(pa), ea.s);
    const wb = portWorld(pb, baseOutline(pb), eb.s);
    const a = wa.pos;
    const b = wb.pos;
    const na = wa.normal;
    const nb = wb.normal;
    const span = Math.max(Math.hypot(b.x - a.x, b.z - a.z), 1e-3);
    const dir = new THREE.Vector3((b.x - a.x) / span, 0, (b.z - a.z) / span);
    const kBase = Math.min(Math.max(K_RATIO * span, K_MIN), K_MAX);
    const ka = na.dot(dir) < 0.2 ? K_MIN : kBase;
    const kb = nb.dot(dir) > -0.2 ? K_MIN : kBase;

    const bezier = new THREE.CubicBezierCurve3(
      a.clone(),
      a.clone().addScaledVector(na, ka),
      b.clone().addScaledVector(nb, kb),
      b.clone(),
    );
    const others = placements.filter((o) => o.roomId !== t.from && o.roomId !== t.to);
    const evaluate = (guide: THREE.Curve<THREE.Vector3>) => {
      let min = Infinity;
      let who: Placement | null = null;
      let at: THREE.Vector3 | null = null;
      for (const q of guide.getSpacedPoints(48)) {
        for (const o of others) {
          const d = sdFootprint(o, q.x, q.z) - CLEAR;
          if (d < min) {
            min = d;
            who = o;
            at = q;
          }
        }
      }
      return { min, who, at };
    };
    const waypoint = (o: Placement, q: THREE.Vector3) => {
      const fp = footprintHalf(o.dims);
      const seg = fp.hl - fp.hd;
      const l = toLocal(o, q.x, q.z);
      const cx = Math.max(-seg, Math.min(seg, l.x));
      let dx = l.x - cx;
      let dz = l.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-3) {
        dx = 0;
        dz = l.z < 0 ? -1 : 1;
      } else {
        dx /= len;
        dz /= len;
      }
      const reach = fp.hd + CLEAR + 0.5;
      const w = toWorld(o, cx + dx * reach, dz * reach);
      return new THREE.Vector3(w.x, TUBE_Y, w.z);
    };
    const lead = Math.min(LEAD, 0.3 * span);
    const project = (v: THREE.Vector3) => (v.x - a.x) * dir.x + (v.z - a.z) * dir.z;
    const makeGuide = (wps: THREE.Vector3[]) => {
      const sorted = [...wps].sort((p, q) => project(p) - project(q));
      return new THREE.CatmullRomCurve3(
        [a.clone(), a.clone().addScaledVector(na, lead), ...sorted, b.clone().addScaledVector(nb, lead), b.clone()],
        false,
        'centripetal',
      );
    };

    let guide: THREE.Curve<THREE.Vector3> = bezier;
    let ev = evaluate(guide);
    let best = { guide, min: ev.min };
    const wps: THREE.Vector3[] = [];
    for (let it = 0; it < MAX_WAYPOINTS && ev.min < 0 && ev.who && ev.at; it++) {
      wps.push(waypoint(ev.who, ev.at));
      guide = makeGuide(wps);
      ev = evaluate(guide);
      if (ev.min > best.min) best = { guide, min: ev.min };
    }

    const glen = best.guide.getLength();
    const segments = Math.min(Math.max(Math.ceil(glen * SAMPLES_PER_UNIT), SEG_MIN), SEG_MAX);
    const pts = best.guide.getSpacedPoints(segments).map((p) => new THREE.Vector3(p.x, TUBE_Y, p.z));
    pts[0]!.copy(a);
    pts[segments]!.copy(b);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + pts[i]!.distanceTo(pts[i - 1]!));
    works.push({
      key,
      from: t.from,
      to: t.to,
      rank: pa.row === 0 ? 0 : 1,
      order,
      pts,
      cum,
      len: cum[cum.length - 1]!,
      lifts: [],
      portA: { roomId: t.from, s: ea.s, pos: a.clone(), normal: na.clone() },
      portB: { roomId: t.to, s: eb.s, pos: b.clone(), normal: nb.clone() },
      intruded: Math.max(0, -best.min),
    });
  });

  // 관-관 교차: 한 쪽을 아치로 올린다
  for (let i = 0; i < works.length; i++) {
    for (let j = i + 1; j < works.length; j++) {
      const A = works[i]!;
      const B = works[j]!;
      for (let m = 0; m + 1 < A.pts.length; m++) {
        const p0 = A.pts[m]!;
        const p1 = A.pts[m + 1]!;
        const minX = Math.min(p0.x, p1.x);
        const maxX = Math.max(p0.x, p1.x);
        const minZ = Math.min(p0.z, p1.z);
        const maxZ = Math.max(p0.z, p1.z);
        for (let n = 0; n + 1 < B.pts.length; n++) {
          const q0 = B.pts[n]!;
          const q1 = B.pts[n + 1]!;
          if (Math.max(q0.x, q1.x) < minX || Math.min(q0.x, q1.x) > maxX) continue;
          if (Math.max(q0.z, q1.z) < minZ || Math.min(q0.z, q1.z) > maxZ) continue;
          const h = segHit(p0.x, p0.z, p1.x, p1.z, q0.x, q0.z, q1.x, q1.z);
          if (!h) continue;
          const sA = A.cum[m]! + h.t * (A.cum[m + 1]! - A.cum[m]!);
          const sB = B.cum[n]! + h.u * (B.cum[n + 1]! - B.cum[n]!);
          // 올릴 관 선택: rank가 높은 쪽(= 내 방에서 나오지 않은 관), 같으면 뒤에 나온 관
          let up = A;
          let down = B;
          let sUp = sA;
          let sDown = sB;
          if (A.rank !== B.rank) {
            if (A.rank < B.rank) [up, down, sUp, sDown] = [B, A, sB, sA];
          } else if (B.order > A.order) {
            [up, down, sUp, sDown] = [B, A, sB, sA];
          }
          const nearEnd = (w: Work, s: number) => Math.min(s, w.len - s) < ARCH_W + 0.6;
          if (nearEnd(up, sUp) && !nearEnd(down, sDown) && down.rank !== 0) {
            [up, down, sUp, sDown] = [down, up, sDown, sUp];
          }
          up.lifts.push(sUp);
        }
      }
    }
  }

  const out = new Map<string, TubeRoute>();
  for (const w of works) {
    let arched = false;
    if (w.lifts.length) {
      arched = true;
      const sorted = [...w.lifts].sort((p, q) => p - q);
      const spans: { lo: number; hi: number }[] = [];
      for (const s of sorted) {
        const last = spans[spans.length - 1];
        if (last && s - last.hi < 2 * ARCH_W) last.hi = s;
        else spans.push({ lo: s, hi: s });
      }
      for (let i = 0; i < w.pts.length; i++) {
        const s = w.cum[i]!;
        let bump = 0;
        for (const sp of spans) {
          const t = Math.max(0, sp.lo - s, s - sp.hi) / ARCH_W;
          bump = Math.max(bump, t < 1 ? 0.5 * (1 + Math.cos(Math.PI * t)) : 0);
        }
        w.pts[i]!.y = TUBE_Y + ARCH_H * bump * smoothstep(0, 1.2, Math.min(s, w.len - s));
      }
    }
    const curve = new THREE.CatmullRomCurve3(w.pts, false, 'centripetal');
    curve.arcLengthDivisions = Math.max(200, w.pts.length * 4);
    out.set(w.key, {
      key: w.key,
      from: w.from,
      to: w.to,
      curve,
      portA: w.portA,
      portB: w.portB,
      segments: w.pts.length - 1,
      length: curve.getLength(),
      arched,
      intruded: w.intruded,
    });
  }
  return out;
}

/** 캐릭터 이동·FX가 쓰는 곡선 맵 (키는 route.key와 같다) */
export function routeCurves(routes: ReadonlyMap<string, TubeRoute>): Map<string, THREE.Curve<THREE.Vector3>> {
  const out = new Map<string, THREE.Curve<THREE.Vector3>>();
  for (const [k, r] of routes) out.set(k, r.curve);
  return out;
}
