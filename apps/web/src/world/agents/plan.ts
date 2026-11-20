import type { CapsuleDims } from '../capsule/dims';
import type { InteriorSpec } from '../interiors/layouts';
import { arcLayout, type ArcUnit } from './arc';
import type { CharacterInput } from './types';

/** 캡슐 로컬 좌표(바닥 윗면 원점)의 좌석·보드·문 배치 계획 */
export interface Spot {
  x: number;
  z: number;
  /** 바라보는 방향(라디안, 0 = +z) */
  yaw: number;
}

export interface RoomPlan {
  home: Map<string, Spot>;
  /** Agent가 쓸 때 서는 보드 앞 자리 (id별) */
  board: Map<string, Spot>;
  /** 소유자가 비운 좌석 (대리 참여 실루엣) */
  emptySeats: { userId: string; spot: Spot }[];
  shelf: { x: number; y: number; z: number };
  boardCenter: { x: number; y: number; z: number };
  /** idle 배회용: 가구·보드·선반 앞 머물 지점(정적). 인덱스가 예약 키 */
  wander: WanderSpot[];
  /** 바닥 위 가구의 원형 충돌체(정적) */
  obstacles: Obstacle[];
  /** 캡슐 바닥 스타디움 치수(안전 영역 계산용) */
  floor: { half: number; rr: number };
}

export interface WanderSpot extends Spot {
  kind: 'prop' | 'seat' | 'board' | 'shelf';
}
export interface Obstacle {
  x: number;
  z: number;
  r: number;
}

/** 바닥 스타디움 안쪽(벽에서 margin만큼 띄운) 영역으로 (x,z)를 밀어 넣는다. out에 쓴다 */
export function clampFloor(f: { half: number; rr: number }, x: number, z: number, margin: number, out: { x: number; z: number }): void {
  const r = f.rr - margin;
  const zc = Math.max(-r, Math.min(r, z));
  const ex = Math.abs(x) - f.half;
  let ox = x;
  let oz = zc;
  if (ex > 0) {
    const d = Math.hypot(ex, zc);
    if (d > r) {
      const k = r / d;
      ox = Math.sign(x) * (f.half + ex * k);
      oz = zc * k;
    }
  }
  out.x = ox;
  out.z = oz;
}

const OBSTACLE_RULES: [RegExp, number][] = [
  [/^desk$/, 0.5],
  [/sofa/, 0.62],
  [/lounge-chair/, 0.45],
  [/^table-cross/, 0.8],
  [/^table-(coffee|cloth|home)/, 0.62],
  [/^side-table/, 0.35],
  [/bookcase/, 0.42],
  [/^kitchen-(bar|bar-end|cabinet)/, 0.4],
  [/^(potted-plant|lamp-round-floor|coat-rack|trashcan|speaker)/, 0.28],
  [/^(bench|cardboard-box)/, 0.35],
];
function obstacleR(id: string): number {
  for (const [re, r] of OBSTACLE_RULES) if (re.test(id)) return r;
  return 0;
}
const VISIT_RULES = /^(desk|lounge-sofa|lounge-chair|table-coffee|table-cloth|table-cross|bookcase|side-table|kitchen-coffee-machine|kitchen-bar$|potted-plant|plant-small|television|bench|coat-rack)/;

export function doorSpot(d: CapsuleDims, side: -1 | 1): Spot {
  return { x: side * (d.floorHalfLength - 1.0), z: d.floorHalfDepth * 0.3, yaw: side > 0 ? -Math.PI / 2 : Math.PI / 2 };
}

const dist = (a: Spot, x: number, z: number) => Math.hypot(a.x - x, a.z - z);

interface PlanUnit {
  /** 구성원 id(왼쪽 → 오른쪽). null은 소유자가 비운 자리의 실루엣 */
  ids: (string | null)[];
  /** ids에 null이 있을 때 그 자리 소유자 */
  silUser?: string;
  ra?: boolean;
  rank: number;
}

/**
 * Our/DM 방: 탁자를 둘러 선 호 위에 [사람, 그 사람의 Personal Agent] 쌍으로 세운다(agents/arc.ts).
 * 쌍은 구성원 순서(memberIds)로, Room Agent는 줄 가운데에, 다른 방에서 온 손님 Agent는 줄 양끝에 선다.
 * 대리 참여 Agent는 비운 자리의 실루엣(emptySeats) 바로 옆에 선다.
 */
export function planArc(
  chars: readonly CharacterInput[],
  room: { memberIds: readonly string[] },
  spec: InteriorSpec,
  d: CapsuleDims,
  emptySeats: RoomPlan['emptySeats'],
): Map<string, Spot> {
  const rank = (uid: string | null): number => {
    const i = uid ? room.memberIds.indexOf(uid) : -1;
    return i >= 0 ? i : 1000;
  };
  const byId = (a: CharacterInput, b: CharacterInput) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const humans = chars.filter((c) => c.kind === 'human').sort((a, b) => rank(a.ownerId) - rank(b.ownerId) || byId(a, b));
  const agents = chars.filter((c) => c.kind === 'agent').sort(byId);
  const ras = chars.filter((c) => c.kind === 'room_agent').sort(byId);
  const ownerOf = (a: CharacterInput) => a.seatUserId ?? a.ownerId;
  const used = new Set<string>();

  const core: PlanUnit[] = [];
  for (const h of humans) {
    const ag = agents.find((a) => !used.has(a.id) && !a.visiting && ownerOf(a) !== null && ownerOf(a) === h.ownerId);
    if (ag) used.add(ag.id);
    core.push({ ids: ag ? [h.id, ag.id] : [h.id], rank: rank(h.ownerId) });
  }
  for (const a of agents) {
    if (used.has(a.id) || !a.representing || !ownerOf(a)) continue;
    used.add(a.id);
    core.push({ ids: [null, a.id], silUser: ownerOf(a)!, rank: rank(ownerOf(a)) });
  }
  core.sort((x, y) => x.rank - y.rank);
  const units = [...core];
  // Room Agent: 줄 가운데
  const mid = Math.floor(core.length / 2);
  units.splice(mid, 0, ...ras.map((r): PlanUnit => ({ ids: [r.id], ra: true, rank: 0 })));
  // 손님 Agent(방문·주인 없음): 양끝에 번갈아
  let g = 0;
  for (const a of agents) {
    if (used.has(a.id)) continue;
    const u: PlanUnit = { ids: [a.id], rank: 0 };
    if (g++ % 2 === 0) units.unshift(u);
    else units.push(u);
  }

  const table = spec.table ?? { cx: 0, cz: 0.1, hw: 1.0, hd: 0.5 };
  const arcUnits: ArcUnit[] = units.map((u) => ({ n: u.ids.length as 1 | 2, ...(u.ra ? { ra: true } : {}) }));
  const pts = arcLayout(arcUnits, table, { half: d.length / 2, rr: d.floorHalfDepth });
  const out = new Map<string, Spot>();
  const tmp = { x: 0, z: 0 };
  const floor = { half: d.length / 2, rr: d.floorHalfDepth };
  units.forEach((u, i) => {
    u.ids.forEach((id, j) => {
      const p = pts[i]![j]!;
      clampFloor(floor, p.x, p.z, 0.5, tmp);
      const spot: Spot = { x: tmp.x, z: tmp.z, yaw: p.yaw };
      if (id) out.set(id, spot);
      else if (u.silUser) emptySeats.push({ userId: u.silUser, spot });
    });
  });
  return out;
}

export function planRoom(
  chars: readonly CharacterInput[],
  room: { kind: 'my' | 'our' | 'dm'; ownerId: string | null; memberIds: readonly string[] },
  spec: InteriorSpec,
  d: CapsuleDims,
): RoomPlan {
  const seats = spec.seats;
  const taken = new Set<number>();
  const home = new Map<string, Spot>();
  const board = new Map<string, Spot>();
  const emptySeats: RoomPlan['emptySeats'] = [];

  const seatSpot = (i: number): Spot => {
    const s = seats[i % seats.length]!;
    return { x: s.position[0], z: s.position[2], yaw: s.yaw };
  };
  const ownerSeat = (uid: string | null): number | null => {
    if (!uid || seats.length === 0) return null;
    if (room.kind === 'my') return uid === room.ownerId ? 0 : null;
    const i = room.memberIds.indexOf(uid);
    return i >= 0 ? i % seats.length : null;
  };
  const freeSeat = (): number | null => {
    for (let i = 0; i < seats.length; i++) if (!taken.has(i)) return i;
    return null;
  };

  // Our/DM은 탁자를 둘러 선 호, My Room은 좌석(책상 의자 등)
  const arcHome = room.kind === 'my' ? null : planArc(chars, room, spec, d, emptySeats);
  // 사람
  const humans = chars.filter((c) => c.kind === 'human');
  for (const c of humans) {
    const arcSpot = arcHome?.get(c.id);
    if (arcSpot) {
      home.set(c.id, arcSpot);
      continue;
    }
    let i = ownerSeat(c.ownerId);
    if (i === null || taken.has(i)) i = freeSeat();
    if (i === null) {
      home.set(c.id, { x: 0, z: d.floorHalfDepth * 0.2, yaw: 0 });
      continue;
    }
    taken.add(i);
    home.set(c.id, seatSpot(i));
  }
  // 보드 앞 자리
  const b = spec.board;
  const nx = Math.sin(b.yaw);
  const nz = Math.cos(b.yaw);
  const lx = Math.cos(b.yaw);
  const lz = -Math.sin(b.yaw);
  const spotAt = (k: number): Spot => {
    const px = b.position[0] + nx * 0.85 + lx * k;
    const pz = b.position[2] + nz * 0.85 + lz * k;
    return { x: px, z: pz, yaw: Math.atan2(-nx, -nz) };
  };
  const agents = chars.filter((c) => c.kind !== 'human');
  let writerIdx = 0;
  for (const c of agents) {
    let spot: Spot | null = arcHome?.get(c.id) ?? null;
    if (c.kind === 'room_agent') {
      spot ??= spotAt(-0.6);
      board.set(c.id, spotAt(-0.45));
    } else if (spot) {
      // 호에서 이미 자리가 정해짐
    } else if (c.representing) {
      const i = ownerSeat(c.seatUserId);
      if (i !== null && !taken.has(i)) {
        taken.add(i);
        spot = seatSpot(i);
        emptySeats.push({ userId: c.seatUserId!, spot });
      }
    } else if (!c.visiting) {
      const i = ownerSeat(c.seatUserId);
      if (i !== null) {
        const s = seats[i % seats.length]!;
        spot = { x: s.position[0] + s.agentOffset[0], z: s.position[2] + s.agentOffset[2], yaw: s.yaw };
      }
    }
    if (!spot) {
      const i = freeSeat();
      if (i !== null) {
        taken.add(i);
        spot = seatSpot(i);
      } else {
        const side = writerIdx % 2 === 0 ? -1 : 1;
        const dr = doorSpot(d, side);
        spot = { x: dr.x - side * 0.6, z: dr.z + 0.5, yaw: 0 };
      }
    }
    home.set(c.id, spot);
    if (c.kind !== 'room_agent') {
      board.set(c.id, spotAt(0.7 + 0.55 * writerIdx));
      writerIdx++;
    }
  }
  // 바닥 겹침 방지: 너무 가까운 자리는 살짝 벌린다
  const placed: Spot[] = [];
  for (const [id, s] of home) {
    for (const p of placed) {
      if (dist(p, s.x, s.z) < 0.4) {
        s.x += 0.42;
        s.z += 0.1;
      }
    }
    placed.push(s);
    home.set(id, s);
  }
  const sh = spec.memoryShelf;

  // ---- idle 배회 지점: layouts는 읽기만 한다
  const floor = { half: d.length / 2, rr: d.floorHalfDepth };
  const obstacles: Obstacle[] = [];
  for (const p of spec.props) {
    if (p.y && p.y > 0.05) continue;
    for (const [re, r] of OBSTACLE_RULES) {
      if (re.test(p.id)) {
        obstacles.push({ x: p.x, z: p.z, r: r * (p.sc ?? 1) });
        break;
      }
    }
  }
  const humanHomes: Spot[] = [];
  for (const c of humans) {
    const hs = home.get(c.id);
    if (hs) humanHomes.push(hs);
  }
  const wander: WanderSpot[] = [];
  const tmp = { x: 0, z: 0 };
  const tryAdd = (x: number, z: number, yaw: number, kind: WanderSpot['kind'], ignore?: { x: number; z: number }) => {
    clampFloor(floor, x, z, 0.55, tmp);
    if (Math.hypot(tmp.x - x, tmp.z - z) > 0.18) return;
    for (const o of obstacles) {
      if (ignore && o.x === ignore.x && o.z === ignore.z) continue;
      if (Math.hypot(o.x - tmp.x, o.z - tmp.z) < o.r + 0.12) return;
    }
    for (const hs of humanHomes) if (dist(hs, tmp.x, tmp.z) < 0.7) return;
    for (const w of wander) if (Math.hypot(w.x - tmp.x, w.z - tmp.z) < 0.7) return;
    wander.push({ x: tmp.x, z: tmp.z, yaw, kind });
  };
  for (const k of [-0.9, 0.0, 0.9]) {
    const sp = spotAt(k);
    tryAdd(sp.x, sp.z, sp.yaw, 'board');
  }
  tryAdd(sh.position[0] + Math.sin(sh.yaw) * 0.75, sh.position[2] + Math.cos(sh.yaw) * 0.75, Math.atan2(-Math.sin(sh.yaw), -Math.cos(sh.yaw)), 'shelf');
  for (const p of spec.props) {
    if ((p.y && p.y > 0.05) || !VISIT_RULES.test(p.id)) continue;
    const rr = ((p.rot ?? 0) * Math.PI) / 180;
    const fx = Math.sin(rr);
    const fz = Math.cos(rr);
    const sc = p.sc ?? 1;
    const off = Math.max((/desk|bookcase|kitchen/.test(p.id) ? 0.85 : 0.75) * (1 + (sc - 1) * 0.5), obstacleR(p.id) * sc + 0.12);
    tryAdd(p.x + fx * off, p.z + fz * off, Math.atan2(-fx, -fz), 'prop', p);
  }
  for (const sd of seats) {
    const sp = seatSpot(sd.index);
    tryAdd(sp.x, sp.z, sp.yaw, 'seat');
  }
  return {
    home,
    board,
    emptySeats,
    shelf: { x: sh.position[0], y: sh.position[1], z: sh.position[2] },
    boardCenter: { x: b.position[0], y: b.position[1], z: b.position[2] },
    wander,
    obstacles,
    floor,
  };
}
