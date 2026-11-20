import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Placement } from './layout';
import { applyFrost, createShellMaterial } from './capsule/GlassMaterial';

export const TUBE_R = 0.36;
const R = TUBE_R;
/** 튜브 중심선 높이: 모래 위에 낮게 놓인다 */
export const TUBE_Y = R + 0.03;
/** 받침(트레이) 벽에서 튜브가 나오는 포트 높이 */
const PORT_Y = TUBE_Y;

/** 캡슐 로컬 좌표에서 받침 스타디움까지의 부호 있는 거리(<0이면 안쪽) */
function sdBase(p: Placement, wx: number, wz: number, grow = 0): number {
  const c = Math.cos(-p.rotY);
  const s = Math.sin(-p.rotY);
  const dx = wx - p.x;
  const dz = wz - p.z;
  const lx = dx * c + dz * s;
  const lz = -dx * s + dz * c;
  const rr = p.dims.floorHalfDepth;
  const seg = p.dims.floorHalfLength - rr;
  const cx = Math.max(-seg, Math.min(seg, lx));
  return Math.hypot(lx - cx, lz) - rr - grow;
}

export interface PortSpec {
  /** 받침의 어느 쪽 끝인가(로컬 x 부호) */
  end: -1 | 1;
  /** 끝 반원 위의 각도(라디안, 0 = 끝점, +는 앞(+z)쪽) */
  angle: number;
}

/** 받침의 둥근 끝 위 포트(월드 좌표)와 바깥 법선. 간판이 있는 앞면 중앙을 피해 끝단 옆면에 낸다 */
function portAt(p: Placement, spec: PortSpec) {
  const rr = p.dims.floorHalfDepth;
  const seg = p.dims.floorHalfLength - rr;
  const ca = Math.cos(spec.angle);
  const sa = Math.sin(spec.angle);
  const lx = spec.end * (seg + rr * ca);
  const lz = rr * sa;
  const nlx = spec.end * ca;
  const nlz = sa;
  const c = Math.cos(p.rotY);
  const s = Math.sin(p.rotY);
  return {
    pos: new THREE.Vector3(p.x + lx * c + lz * s, PORT_Y, p.z - lx * s + lz * c),
    normal: new THREE.Vector3(nlx * c + nlz * s, 0, -nlx * s + nlz * c),
  };
}

/**
 * 캡슐마다 튜브 포트를 끝단에 배정한다: 상대가 있는 쪽 끝, 한쪽에 몰리면 반대쪽 끝, 같은 끝이면 앞뒤로 각도를 벌린다.
 * 키: `${from}>${to}|from` 와 `${from}>${to}|to` (튜브 방향 기준 출발/도착 쪽 포트)
 */
export function assignPorts(tubes: readonly { from: string; to: string }[], placements: Readonly<Record<string, Placement>>): Map<string, PortSpec> {
  const out = new Map<string, PortSpec>();
  const byRoom = new Map<string, { key: string; lx: number; lz: number }[]>();
  for (const t of tubes) {
    const a = placements[t.from];
    const b = placements[t.to];
    if (!a || !b) continue;
    const add = (me: Placement, other: Placement, key: string) => {
      const c = Math.cos(-me.rotY);
      const s = Math.sin(-me.rotY);
      const dx = other.x - me.x;
      const dz = other.z - me.z;
      const list = byRoom.get(me.roomId) ?? [];
      list.push({ key, lx: dx * c + dz * s, lz: -dx * s + dz * c });
      byRoom.set(me.roomId, list);
    };
    add(a, b, `${t.from}>${t.to}|from`);
    add(b, a, `${t.from}>${t.to}|to`);
  }
  for (const list of byRoom.values()) {
    const ends: Record<string, typeof list> = { '-1': [], '1': [] };
    const undecided: typeof list = [];
    for (const e of list) (Math.abs(e.lx) < 1.5 ? undecided : ends[e.lx < 0 ? '-1' : '1']!).push(e);
    for (const e of undecided) (ends['-1']!.length < ends['1']!.length ? ends['-1']! : ends['1']!).push(e);
    for (const end of [-1, 1] as const) {
      const g = ends[String(end)]!.sort((p, q) => p.lz - q.lz);
      const step = Math.min(0.8, 1.6 / Math.max(g.length, 1));
      g.forEach((e, i) => out.set(e.key, { end, angle: (i - (g.length - 1) / 2) * step }));
    }
  }
  return out;
}

/** 곡선이 다른 캡슐 받침(여유 포함)을 파고드는 정도. 0이면 깨끗하다 */
function intrusion(curve: THREE.Curve<THREE.Vector3>, others: readonly Placement[]): number {
  let worst = 0;
  for (let i = 1; i < 40; i++) {
    const q = curve.getPoint(i / 40);
    for (const o of others) worst = Math.max(worst, -sdBase(o, q.x, q.z, 1.3));
  }
  return worst;
}

/** 튜브 중심선. GlassTube와 캐릭터 이동(agents/Trips)이 같은 곡선을 쓴다 */
export function computeTubeCurve(
  from: Placement,
  to: Placement,
  portA: PortSpec,
  portB: PortSpec,
  obstacles: readonly Placement[] = [],
) {
  const dir = new THREE.Vector2(to.x - from.x, to.z - from.z);
  const dist = dir.length();
  dir.normalize();
  const a = portAt(from, portA);
  const b = portAt(to, portB);
  const span = a.pos.distanceTo(b.pos);
  const k = Math.min(Math.max(span * 0.38, 2.2), 14);
  const side = new THREE.Vector3(-dir.y, 0, dir.x);
  const others = obstacles.filter((o) => o.roomId !== from.roomId && o.roomId !== to.roomId);
  const make = (bend: number) => {
    const bs = side.clone().multiplyScalar(bend);
    const c1 = a.pos.clone().addScaledVector(a.normal, k).add(bs);
    const c2 = b.pos.clone().addScaledVector(b.normal, k).add(bs);
    return new THREE.CubicBezierCurve3(a.pos.clone(), c1, c2, b.pos.clone());
  };
  const base = Math.min(1.4, dist * 0.04);
  let best = make(base);
  let bestScore = intrusion(best, others);
  for (const bend of [-base, base * 3, -base * 3, 7, -7, 12, -12, 18, -18]) {
    if (bestScore <= 0) break;
    const c = make(bend);
    const sc = intrusion(c, others);
    if (sc < bestScore) {
      best = c;
      bestScore = sc;
    }
  }
  return { curve: best, a, b, intruded: bestScore };
}

const lookMatrix = (tangent: THREE.Vector3) => new THREE.Matrix4().lookAt(new THREE.Vector3(), tangent, new THREE.Vector3(0, 1, 0));

/**
 * 유리 튜브 통로 (계획 8.3). 두 캡슐 받침(트레이) 옆면의 포트(링 조인트)에서 나와 모래 위를 낮게 지나 상대 포트로 이어진다.
 * 실내를 관통하지 않고, 다른 캡슐 받침을 피해 휘어진다. 안쪽 바닥 띠가 출발 쪽 색에서 도착 쪽 색으로 그라데이션된다.
 * 튜브는 항상 맑은 가짜 유리다(투과 슬롯을 쓰지 않는다).
 */
export function GlassTube({
  from,
  to,
  colorA,
  colorB,
  dim = 1,
  obstacles = [],
  portA,
  portB,
}: {
  from: Placement;
  to: Placement;
  colorA: string;
  colorB: string;
  /** 0~1: 포커스 중 시야를 가리지 않도록 흐리게 (1=기본) */
  dim?: number;
  /** 튜브가 피해 가야 할 다른 캡슐들 */
  obstacles?: readonly Placement[];
  portA: PortSpec;
  portB: PortSpec;
}) {
  const built = useMemo(() => {
    const { curve, a, b, intruded } = computeTubeCurve(from, to, portA, portB, obstacles);
    const tubular = 80;
    const radial = 20;
    const outer = new THREE.TubeGeometry(curve, tubular, R, radial, false);
    // 안쪽 바닥 띠: 같은 곡선을 아래로 내린 얇은 튜브(출발 색 -> 도착 색)
    const stripPts = curve.getPoints(tubular).map((p) => p.clone().setY(0.2));
    const strip = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(stripPts), tubular, 0.17, 8, false);
    const vcount = strip.getAttribute('position').count;
    const cA = new THREE.Color(colorA);
    const cB = new THREE.Color(colorB);
    const arr = new Float32Array(vcount * 3);
    const perRing = 8 + 1;
    const tmp = new THREE.Color();
    for (let i = 0; i < vcount; i++) {
      const t = Math.min(Math.floor(i / perRing) / tubular, 1);
      tmp.copy(cA).lerp(cB, t);
      arr[i * 3] = tmp.r;
      arr[i * 3 + 1] = tmp.g;
      arr[i * 3 + 2] = tmp.b;
    }
    strip.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    // 포트: 받침 벽에 박힌 짧은 슬리브 + 색 링
    const ports = [
      { p: a, color: colorA },
      { p: b, color: colorB },
    ].map(({ p, color }) => {
      const m = lookMatrix(p.normal);
      const sleeve = new THREE.CylinderGeometry(R + 0.07, R + 0.07, 0.34, 28, 1, true);
      sleeve.rotateX(Math.PI / 2); // 축 = z
      sleeve.applyMatrix4(m);
      sleeve.translate(p.pos.x + p.normal.x * 0.05, p.pos.y, p.pos.z + p.normal.z * 0.05);
      const ring = new THREE.TorusGeometry(R + 0.075, 0.075, 12, 40);
      ring.applyMatrix4(m);
      ring.translate(p.pos.x + p.normal.x * 0.2, p.pos.y, p.pos.z + p.normal.z * 0.2);
      const ring2 = new THREE.TorusGeometry(R + 0.04, 0.04, 10, 36);
      ring2.applyMatrix4(m);
      ring2.translate(p.pos.x + p.normal.x * 0.06, p.pos.y, p.pos.z + p.normal.z * 0.06);
      return { sleeve, ring, ring2, color };
    });
    return { outer, strip, ports, intruded };
  }, [from, to, colorA, colorB, obstacles, portA, portB]);

  const front = useMemo(() => createShellMaterial(THREE.FrontSide), []);
  const back = useMemo(() => createShellMaterial(THREE.BackSide), []);
  const tint = useMemo(() => new THREE.Color(colorA).lerp(new THREE.Color(colorB), 0.5), [colorA, colorB]);
  const stripMat = useMemo(
    () => new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, color: new THREE.Color(1.7, 1.7, 1.7), transparent: true }),
    [],
  );
  const sleeveMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#6b4328', roughness: 0.5, metalness: 0.2, side: THREE.DoubleSide }), []);
  const cur = useRef(dim);
  useFrame((_, dt) => {
    cur.current = THREE.MathUtils.damp(cur.current, dim, 6, dt);
    const k = cur.current;
    applyFrost(front, 0, tint, 0, false, false);
    applyFrost(back, 0, tint, 0, true, false);
    front.opacity = 0.12 * k;
    back.opacity = 0.1 * k;
    front.shell.rimStrength.value = 1.4 * k;
    back.shell.rimStrength.value *= k;
    stripMat.opacity = 0.25 + 0.75 * k;
  });
  useEffect(
    () => () => {
      built.outer.dispose();
      built.strip.dispose();
      built.ports.forEach((p) => {
        p.sleeve.dispose();
        p.ring.dispose();
        p.ring2.dispose();
      });
    },
    [built],
  );

  return (
    <group>
      <mesh geometry={built.outer} material={back} renderOrder={4} />
      <mesh geometry={built.strip} material={stripMat} renderOrder={3} />
      <mesh geometry={built.outer} material={front} renderOrder={11} />
      {built.ports.map((p, i) => (
        <group key={i}>
          <mesh geometry={p.sleeve} material={sleeveMat} />
          <mesh geometry={p.ring}>
            <meshBasicMaterial color={p.color} toneMapped={false} />
          </mesh>
          <mesh geometry={p.ring2}>
            <meshBasicMaterial color="#fff1d6" toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
