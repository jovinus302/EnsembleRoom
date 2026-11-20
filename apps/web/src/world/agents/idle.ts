import { clampFloor, type RoomPlan } from './plan';

/**
 * Agent idle 배회: 걷기(WALK) <-> 머물기(DWELL) 상태기계. 프레임 계산은 할당 없이(ref 위치 갱신) 하고,
 * 무작위는 agent id 해시로 시드한 mulberry32만 쓴다(Math.random 없음).
 * 위치 소유권은 Actor가 가진다: 다른 연출이 시작되면 Actor가 idleStop을 부르고 기존 damp 이동이 현재 위치에서 이어받는다.
 */

export const WALK = 0;
export const DWELL = 1;
/** 머무는 동안의 작은 동작 */
export const D_PEEK = 0;
export const D_NOD = 1;
export const D_AROUND = 2;
export const D_SOCIAL = 3;

export interface IdleState {
  rng: number;
  vmax: number;
  dwellMin: number;
  dwellSpan: number;
  ph: number;
  active: boolean;
  phase: number;
  nextAt: number;
  dwellStart: number;
  dwellUntil: number;
  walkStart: number;
  walkLimit: number;
  v: number;
  tx: number;
  tz: number;
  /** 도착 후 바라볼 방향 / 마지막 진행 방향 */
  yaw: number;
  spotIdx: number;
  lastIdx: number;
  dkind: number;
  socialId: string | null;
  plan: RoomPlan | null;
  /** 출력: 까딱임, 둘러보기·응시 방향(절대 yaw) */
  nod: number;
  lookYaw: number;
  // 사람 고개 돌림
  htStart: number;
  htNext: number;
  htDir: number;
}

function hash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rand(st: { rng: number }): number {
  st.rng = (st.rng + 0x6d2b79f5) | 0;
  let t = Math.imul(st.rng ^ (st.rng >>> 15), 1 | st.rng);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function createIdle(id: string): IdleState {
  const st: IdleState = {
    rng: hash(id),
    vmax: 0,
    dwellMin: 0,
    dwellSpan: 0,
    ph: 0,
    active: false,
    phase: DWELL,
    nextAt: 0,
    dwellStart: 0,
    dwellUntil: 0,
    walkStart: 0,
    walkLimit: 0,
    v: 0,
    tx: 0,
    tz: 0,
    yaw: 0,
    spotIdx: -1,
    lastIdx: -1,
    dkind: D_AROUND,
    socialId: null,
    plan: null,
    nod: 0,
    lookYaw: 0,
    htStart: -99,
    htNext: 0,
    htDir: 0,
  };
  // Agent마다 속도·머무는 시간·위상을 다르게
  st.vmax = 0.42 + rand(st) * 0.26;
  st.dwellMin = 2.4 + rand(st) * 2.2;
  st.dwellSpan = 2.2 + rand(st) * 2.6;
  st.ph = rand(st) * Math.PI * 2;
  st.htNext = 3 + rand(st) * 8;
  return st;
}

export function releaseIdle(st: IdleState, rt: { reserve: Map<number, string> }, id: string): void {
  if (st.spotIdx >= 0 && rt.reserve.get(st.spotIdx) === id) rt.reserve.delete(st.spotIdx);
  st.spotIdx = -1;
}

export function stopIdle(st: IdleState, rt: { reserve: Map<number, string> }, id: string, t: number): void {
  releaseIdle(st, rt, id);
  st.active = false;
  st.v = 0;
  st.nod = 0;
  st.nextAt = t + 0.8 + rand(st) * 1.4;
}

interface Pos {
  x: number;
  z: number;
}
interface Rt {
  plan: RoomPlan;
  reserve: Map<number, string>;
  positions: Map<string, { x: number; z: number }>;
}

// forEach 콜백이 클로저를 만들지 않도록 모듈 변수로 문맥을 넘긴다
let cId = '';
let cX = 0;
let cZ = 0;
let cNearD = 1e9;
let cNearId: string | null = null;
let cPushX = 0;
let cPushZ = 0;
const tmp = { x: 0, z: 0 };
function nearCb(p: { x: number; z: number }, oid: string) {
  if (oid === cId) return;
  const d = Math.hypot(p.x - cX, p.z - cZ);
  if (d < cNearD) {
    cNearD = d;
    cNearId = oid;
  }
}
function sepCb(p: { x: number; z: number }, oid: string) {
  if (oid === cId) return;
  const dx = cX - p.x;
  const dz = cZ - p.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.62 && d > 1e-4) {
    const k = (0.62 - d) / d;
    cPushX += dx * k;
    cPushZ += dz * k;
  }
}

function nearestOther(rt: Rt, id: string, x: number, z: number): { d: number; id: string | null } {
  cId = id;
  cX = x;
  cZ = z;
  cNearD = 1e9;
  cNearId = null;
  rt.positions.forEach(nearCb);
  return { d: cNearD, id: cNearId };
}

function startDwell(st: IdleState, t: number, kind: number, ownerId: string | null, rt: Rt, id: string, x: number, z: number): void {
  st.phase = DWELL;
  st.v = 0;
  st.dwellStart = t;
  st.dkind = kind;
  const base = st.dwellMin + rand(st) * st.dwellSpan;
  st.dwellUntil = t + (kind === D_AROUND ? base * 0.7 : base);
  st.socialId = null;
  if (kind === D_SOCIAL) {
    const own = ownerId ? `h:${ownerId}` : null;
    if (own && rt.positions.has(own)) st.socialId = own;
    else st.socialId = nearestOther(rt, id, x, z).id;
    if (!st.socialId) st.dkind = D_AROUND;
  }
}

function pickNext(st: IdleState, s: Pos, rt: Rt, id: string, ownerId: string | null, home: { x: number; z: number; yaw: number }, t: number): void {
  const plan = rt.plan;
  const n = plan.wander.length;
  releaseIdle(st, rt, id);
  for (let tries = 0; tries < 8; tries++) {
    const r = rand(st);
    let tx = 0;
    let tz = 0;
    let yaw = 0;
    let idx = -1;
    let kind = D_AROUND;
    if (r < 0.16 || n === 0) {
      // 자기 자리로 돌아가 소유자·주변을 본다
      tx = home.x;
      tz = home.z;
      yaw = home.yaw;
      kind = rand(st) < 0.65 ? D_SOCIAL : D_AROUND;
      if (Math.hypot(tx - s.x, tz - s.z) < 0.5) continue;
    } else if (r < 0.34) {
      // 느린 산책: 안전 영역 안의 임의 지점
      const f = plan.floor;
      clampFloor(f, (rand(st) * 2 - 1) * (f.half + f.rr * 0.6), (rand(st) * 2 - 1) * f.rr, 0.6, tmp);
      tx = tmp.x;
      tz = tmp.z;
      yaw = Math.atan2(tx - s.x, tz - s.z);
      kind = D_AROUND;
      if (Math.hypot(tx - s.x, tz - s.z) < 0.9) continue;
      let blocked = false;
      for (let i = 0; i < plan.obstacles.length; i++) {
        const o = plan.obstacles[i]!;
        if (Math.hypot(o.x - tx, o.z - tz) < o.r + 0.3) blocked = true;
      }
      if (blocked) continue;
    } else {
      idx = Math.floor(rand(st) * n);
      if (idx === st.lastIdx && n > 1) continue;
      const w = plan.wander[idx]!;
      const holder = rt.reserve.get(idx);
      if (holder && holder !== id) continue;
      tx = w.x;
      tz = w.z;
      yaw = w.yaw;
      if (Math.hypot(tx - s.x, tz - s.z) < 0.35) continue;
      const q = rand(st);
      kind = w.kind === 'seat' ? (q < 0.5 ? D_NOD : D_AROUND) : w.kind === 'prop' ? (q < 0.5 ? D_PEEK : D_NOD) : D_PEEK;
    }
    // 다른 캐릭터가 이미 서 있는 곳은 피한다
    const o = nearestOther(rt, id, tx, tz);
    if (o.d < 0.7) continue;
    st.tx = tx;
    st.tz = tz;
    st.yaw = yaw;
    st.dkind = kind;
    st.spotIdx = idx;
    if (idx >= 0) {
      rt.reserve.set(idx, id);
      st.lastIdx = idx;
    }
    st.phase = WALK;
    st.walkStart = t;
    st.walkLimit = (Math.hypot(tx - s.x, tz - s.z) / st.vmax) * 2.4 + 2.5;
    return;
  }
  // 갈 곳이 없으면 제자리에서 주변을 둘러본다
  st.tx = s.x;
  st.tz = s.z;
  startDwell(st, t, D_AROUND, ownerId, rt, id, s.x, s.z);
}

export function startIdle(st: IdleState, s: Pos, rt: Rt, id: string, ownerId: string | null, home: { x: number; z: number; yaw: number }, t: number): void {
  st.active = true;
  st.v = 0;
  st.yaw = 0;
  pickNext(st, s, rt, id, ownerId, home, t);
}

/** 한 프레임: s.x/s.z를 직접 갱신한다. 반환 후 st.phase / st.nod / st.lookYaw / st.socialId를 Actor가 읽는다 */
export function stepIdle(st: IdleState, s: Pos, rt: Rt, id: string, ownerId: string | null, home: { x: number; z: number; yaw: number }, t: number, dt: number): void {
  st.nod = 0;
  if (st.phase === WALK) {
    const dx = st.tx - s.x;
    const dz = st.tz - s.z;
    const d = Math.hypot(dx, dz);
    // 출발은 부드럽게 가속, 목적지 앞에서 감속
    const want = d < 0.03 ? 0 : Math.min(st.vmax, d * 1.5 + 0.03);
    const lam = want > st.v ? 1.8 : 3.2;
    st.v += (want - st.v) * (1 - Math.exp(-lam * dt));
    if (d > 1e-4) {
      const step = Math.min(st.v * dt, d);
      s.x += (dx / d) * step;
      s.z += (dz / d) * step;
      st.lookYaw = Math.atan2(dx, dz);
    }
    // 가구 충돌체 밀어내기(부드럽게) + 접선 방향으로 비켜 가기
    for (let i = 0; i < rt.plan.obstacles.length; i++) {
      const o = rt.plan.obstacles[i]!;
      const ox = s.x - o.x;
      const oz = s.z - o.z;
      const od = Math.hypot(ox, oz);
      if (od < o.r && od > 1e-4) {
        const push = Math.min(o.r - od, 1.6 * dt);
        const nx = ox / od;
        const nz = oz / od;
        s.x += nx * push;
        s.z += nz * push;
        // 진행 방향과 같은 쪽 접선으로 미끄러진다
        let tx = -nz;
        let tz = nx;
        if (tx * dx + tz * dz < 0) {
          tx = -tx;
          tz = -tz;
        }
        s.x += tx * push * 1.4;
        s.z += tz * push * 1.4;
      }
    }
    // 다른 캐릭터와 겹치지 않게 살짝 비킨다
    cId = id;
    cX = s.x;
    cZ = s.z;
    cPushX = 0;
    cPushZ = 0;
    rt.positions.forEach(sepCb);
    const pl = Math.hypot(cPushX, cPushZ);
    if (pl > 0) {
      const k = Math.min(pl, 1.2 * dt) / pl;
      s.x += cPushX * k;
      s.z += cPushZ * k;
    }
    clampFloor(rt.plan.floor, s.x, s.z, 0.5, tmp);
    s.x = tmp.x;
    s.z = tmp.z;
    const arrived = d < 0.05 && st.v < 0.1;
    if (arrived || t - st.walkStart > st.walkLimit) {
      startDwell(st, t, arrived ? st.dkind : D_AROUND, ownerId, rt, id, s.x, s.z);
      if (!arrived) st.yaw = st.lookYaw;
    }
    return;
  }
  // DWELL
  const dur = Math.max(0.1, st.dwellUntil - st.dwellStart);
  const u = Math.min(1, (t - st.dwellStart) / dur);
  switch (st.dkind) {
    case D_PEEK:
      st.nod = Math.sin(u * Math.PI) * 0.9;
      st.lookYaw = st.yaw;
      break;
    case D_NOD:
      st.nod = u > 0.2 && u < 0.8 ? Math.sin((u - 0.2) * Math.PI * 6) * 0.55 : 0;
      st.lookYaw = st.yaw;
      break;
    case D_AROUND:
      st.lookYaw = st.yaw + Math.sin(u * Math.PI * 2 + st.ph) * 1.15;
      break;
    default:
      st.lookYaw = st.yaw;
  }
  if (t >= st.dwellUntil) pickNext(st, s, rt, id, ownerId, home, t);
}
