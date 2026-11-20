import type { CapsuleDims } from '../capsule/dims';
import type { InteriorSpec } from '../interiors/layouts';
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
}

export function doorSpot(d: CapsuleDims, side: -1 | 1): Spot {
  return { x: side * (d.floorHalfLength - 1.0), z: d.floorHalfDepth * 0.3, yaw: side > 0 ? -Math.PI / 2 : Math.PI / 2 };
}

const dist = (a: Spot, x: number, z: number) => Math.hypot(a.x - x, a.z - z);

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

  // 사람
  const humans = chars.filter((c) => c.kind === 'human');
  for (const c of humans) {
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
    let spot: Spot | null = null;
    if (c.kind === 'room_agent') {
      spot = spotAt(-0.6);
      board.set(c.id, spotAt(-0.45));
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
  return {
    home,
    board,
    emptySeats,
    shelf: { x: sh.position[0], y: sh.position[1], z: sh.position[2] },
    boardCenter: { x: b.position[0], y: b.position[1], z: b.position[2] },
  };
}
