import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { footprintHalf } from './capsule/dims';
import { makeOutline, outlineAt, toWorld } from './capsule/outline';
import { layoutWorld, spreadMinGap } from './layout';
import { ARCH_H, TUBE_Y, routeTubes, sdFootprint } from './routing';
import { DEFAULT_AMBIENCE, MOCK_SCENES, buildMockRooms, type MockSceneName } from './lab/mockWorld';

const SCENES = Object.keys(MOCK_SCENES) as MockSceneName[];

function cases() {
  const out: { scene: MockSceneName; viewer: string }[] = [];
  for (const scene of SCENES) {
    for (const r of MOCK_SCENES[scene]) {
      if (r.kind === 'my' && r.ownerId) out.push({ scene, viewer: r.ownerId });
    }
  }
  return out;
}

function build(scene: MockSceneName, viewer: string) {
  const rooms = buildMockRooms(viewer, [], DEFAULT_AMBIENCE, scene);
  const layout = layoutWorld(viewer, rooms);
  const routes = routeTubes(layout);
  return { layout, routes };
}

/** 곡선을 u 간격으로 촘촘히 샘플링 */
function sample(curve: THREE.Curve<THREE.Vector3>, step: number) {
  const out: THREE.Vector3[] = [];
  const n = Math.ceil(1 / step);
  for (let i = 0; i <= n; i++) out.push(curve.getPointAt(Math.min(i / n, 1)));
  return out;
}

describe.each(cases())('routing $scene / $viewer', ({ scene, viewer }) => {
  const { layout, routes } = build(scene, viewer);

  it('1. 모든 tube에 route가 있고 곡선 끝이 포트와 일치', () => {
    expect(layout.tubes.length).toBeGreaterThan(0);
    for (const t of layout.tubes) {
      const r = routes.get(`${t.from}>${t.to}`);
      expect(r, `${t.from}>${t.to}`).toBeDefined();
      expect(r!.curve.getPointAt(0).distanceTo(r!.portA.pos)).toBeLessThan(1e-3);
      expect(r!.curve.getPointAt(1).distanceTo(r!.portB.pos)).toBeLessThan(1e-3);
    }
  });

  it('2. 시작/끝 접선이 포트 법선과 정렬', () => {
    for (const r of routes.values()) {
      expect(r.curve.getTangentAt(0).dot(r.portA.normal), r.key).toBeGreaterThanOrEqual(0.95);
      expect(-r.curve.getTangentAt(1).dot(r.portB.normal), r.key).toBeGreaterThanOrEqual(0.95);
    }
  });

  it('3. 다른 캡슐과의 거리, 자기 캡슐은 끝에서 떨어진 구간에서', () => {
    for (const r of routes.values()) {
      const len = r.curve.getLength();
      const pts = sample(r.curve, 0.02);
      pts.forEach((q, i) => {
        const s = (i / (pts.length - 1)) * len;
        for (const p of Object.values(layout.placements)) {
          const sd = sdFootprint(p, q.x, q.z);
          if (p.roomId === r.from || p.roomId === r.to) {
            if (s >= 1.0 && len - s >= 1.0) expect(sd, `${r.key} self ${p.roomId} s=${s.toFixed(2)}`).toBeGreaterThanOrEqual(0.4);
          } else {
            expect(sd, `${r.key} vs ${p.roomId} u=${(i / (pts.length - 1)).toFixed(2)}`).toBeGreaterThanOrEqual(0.75);
          }
        }
      });
    }
  });

  it('4. 관 쌍의 xz 교차점에서 높이차가 충분', () => {
    const list = [...routes.values()].map((r) => ({ r, pts: sample(r.curve, 0.005) }));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i]!.pts;
        const B = list[j]!.pts;
        for (let m = 0; m + 1 < A.length; m++) {
          for (let n = 0; n + 1 < B.length; n++) {
            const a0 = A[m]!;
            const a1 = A[m + 1]!;
            const b0 = B[n]!;
            const b1 = B[n + 1]!;
            if (Math.max(a0.x, a1.x) < Math.min(b0.x, b1.x) || Math.max(b0.x, b1.x) < Math.min(a0.x, a1.x)) continue;
            if (Math.max(a0.z, a1.z) < Math.min(b0.z, b1.z) || Math.max(b0.z, b1.z) < Math.min(a0.z, a1.z)) continue;
            const rx = a1.x - a0.x;
            const rz = a1.z - a0.z;
            const sx = b1.x - b0.x;
            const sz = b1.z - b0.z;
            const den = rx * sz - rz * sx;
            if (Math.abs(den) < 1e-12) continue;
            const t = ((b0.x - a0.x) * sz - (b0.z - a0.z) * sx) / den;
            const u = ((b0.x - a0.x) * rz - (b0.z - a0.z) * rx) / den;
            if (t < 0 || t > 1 || u < 0 || u > 1) continue;
            const ya = a0.y + t * (a1.y - a0.y);
            const yb = b0.y + u * (b1.y - b0.y);
            expect(Math.abs(ya - yb), `${list[i]!.r.key} x ${list[j]!.r.key}`).toBeGreaterThanOrEqual(0.97);
          }
        }
      }
    }
  });

  it('5. 같은 캡슐의 포트 간격과 sMax', () => {
    const byRoom = new Map<string, number[]>();
    for (const r of routes.values()) {
      for (const port of [r.portA, r.portB]) {
        const p = layout.placements[port.roomId]!;
        const o = makeOutline(p.dims.baseHalfLength, p.dims.baseHalfDepth);
        expect(Math.abs(port.s)).toBeLessThanOrEqual(o.sMax + 1e-9);
        byRoom.set(port.roomId, [...(byRoom.get(port.roomId) ?? []), port.s]);
      }
    }
    for (const [id, list] of byRoom) {
      list.sort((a, b) => a - b);
      for (let i = 1; i < list.length; i++) expect(list[i]! - list[i - 1]!, id).toBeGreaterThanOrEqual(1.0 - 1e-9);
    }
  });

  it('6. 고리 방지: 길이 <= 1.6*직선거리 + 4', () => {
    for (const r of routes.values()) {
      expect(r.length, r.key).toBeLessThanOrEqual(1.6 * r.portA.pos.distanceTo(r.portB.pos) + 4);
    }
  });

  it('7. 최대 높이', () => {
    for (const r of routes.values()) {
      for (const q of sample(r.curve, 0.01)) expect(q.y).toBeLessThanOrEqual(TUBE_Y + ARCH_H + 0.01);
    }
  });

  it('9. 캡슐 발자국끼리 겹치지 않는다', () => {
    const ps = Object.values(layout.placements);
    for (const a of ps) {
      const fp = footprintHalf(a.dims);
      const o = makeOutline(fp.hl, fp.hd);
      for (let k = 0; k < 96; k++) {
        const q = outlineAt(o, ((k / 96) * 2 - 1) * (o.P / 2));
        const w = toWorld(a, q.x, q.z);
        for (const b of ps) {
          if (b === a) continue;
          expect(sdFootprint(b, w.x, w.z), `${a.roomId} vs ${b.roomId}`).toBeGreaterThanOrEqual(1.0);
        }
      }
    }
  });
});

describe('8. 아치 개수', () => {
  it('seed와 wide(alice)는 아치 0개', () => {
    for (const scene of ['seed', 'wide'] as const) {
      const { routes } = build(scene, 'u_alice');
      expect([...routes.values()].filter((r) => r.arched).map((r) => r.key), scene).toEqual([]);
    }
  });
  it('k22는 아치 1개 이상', () => {
    for (const viewer of ['u_alice', 'u_bob', 'u_dana']) {
      const { routes } = build('k22', viewer);
      expect([...routes.values()].filter((r) => r.arched).length, viewer).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('10. spreadMinGap', () => {
  it('간격, 범위, 순서를 지킨다', () => {
    const cases: { d: number[]; g: number; lo?: number; hi?: number }[] = [
      { d: [0, 0, 0], g: 2 },
      { d: [-5, 0, 0.5, 9], g: 3 },
      { d: [10, 10, 10, 10], g: 1.3, lo: -4, hi: 4 },
      { d: [-9, -9, 9], g: 1.3, lo: -4, hi: 4 },
      { d: [1], g: 5, lo: -2, hi: 2 },
      { d: [-3, -2, -1, 0, 1, 2, 3], g: 1.3, lo: -4, hi: 4 },
    ];
    for (const c of cases) {
      const out = spreadMinGap(c.d, c.g, c.lo, c.hi);
      expect(out.length).toBe(c.d.length);
      const finite = c.lo !== undefined && c.hi !== undefined;
      const g = finite && c.d.length > 1 ? Math.min(c.g, (c.hi! - c.lo!) / (c.d.length - 1)) : c.g;
      for (let i = 1; i < out.length; i++) expect(out[i]! - out[i - 1]!).toBeGreaterThanOrEqual(g - 1e-9);
      if (finite) for (const v of out) {
        expect(v).toBeGreaterThanOrEqual(c.lo! - 1e-9);
        expect(v).toBeLessThanOrEqual(c.hi! + 1e-9);
      }
    }
  });
  it('간격이 이미 충분하면 그대로 둔다', () => {
    expect(spreadMinGap([-6, 0, 6], 2)).toEqual([-6, 0, 6]);
  });
  it('가운데로 모이는 해(평균 보존)', () => {
    const out = spreadMinGap([0, 0], 2);
    expect(out[0]).toBeCloseTo(-1);
    expect(out[1]).toBeCloseTo(1);
  });
});
