import { worldTopology, type RoomRef } from '@ensemble/shared';
import { capsuleDims, totalLength, type CapsuleDims } from './capsule/dims';

export interface Placement {
  roomId: string;
  x: number;
  z: number;
  /** y축 회전(라디안). 앞면(+z)이 관객 쪽을 향하도록 살짝 모은다 */
  rotY: number;
  dims: CapsuleDims;
  row: 0 | 1 | 2;
}

export interface TubeLink {
  from: string;
  to: string;
}

export interface WorldLayout {
  placements: Record<string, Placement>;
  tubes: TubeLink[];
  order: string[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

const VIEW_POINT_Z = 40; // 캡슐 앞면이 향할 가상의 관객 위치
const FRONT_Z = 8;
const ROW_GAP = 22;
const OUR_SPACING = 12;
const BEHIND_SPACING = 11;

/**
 * 시점(viewer) 중심 배치 (계획 8.3). 내 캡슐이 카메라 앞 중앙, Our가 그 뒤 부채꼴,
 * 각 Our 뒤에 그 Our의 다른 구성원 캡슐. 같은 월드라도 viewerId에 따라 완전히 다르게 놓인다.
 * 한 캡슐이 여러 Our의 뒤에 걸치면 처음 나온 Our 뒤에 한 번만 놓고, 튜브는 모두 연결한다.
 */
export function layoutWorld(viewerId: string, rooms: readonly RoomRef[]): WorldLayout {
  const topo = worldTopology(viewerId, rooms);
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const placements: Record<string, Placement> = {};
  const order: string[] = [];

  const put = (roomId: string, x: number, z: number, row: 0 | 1 | 2) => {
    const room = byId.get(roomId);
    if (!room || placements[roomId]) return;
    const dims = capsuleDims(room.kind === 'our' ? 'plump' : 'long');
    // 앞면이 가상의 관객 위치를 향하도록 아주 조금 회전 (멀리 있는 캡슐일수록 약하게)
    const rotY = Math.atan2(-x, VIEW_POINT_Z - z) * 0.7;
    placements[roomId] = { roomId, x, z, rotY, dims, row };
    order.push(roomId);
  };

  if (topo.front) put(topo.front, 0, FRONT_Z, 0);

  const n = topo.ours.length;
  topo.ours.forEach((o, i) => {
    const x = (i - (n - 1) / 2) * OUR_SPACING;
    const z = FRONT_Z - ROW_GAP - Math.abs(x) * 0.12;
    put(o.roomId, x, z, 1);
    const fresh = o.behind.filter((b) => !placements[b]);
    fresh.forEach((b, j) => {
      const bx = x + (j - (fresh.length - 1) / 2) * BEHIND_SPACING;
      put(b, bx, z - ROW_GAP + 1.5, 2);
    });
  });

  const tubes = topo.tubes.filter((t) => placements[t.from] && placements[t.to]);

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of Object.values(placements)) {
    const half = totalLength(p.dims) / 2;
    minX = Math.min(minX, p.x - half);
    maxX = Math.max(maxX, p.x + half);
    minZ = Math.min(minZ, p.z - p.dims.radius);
    maxZ = Math.max(maxZ, p.z + p.dims.radius);
  }
  if (!isFinite(minX)) {
    minX = -8;
    maxX = 8;
    minZ = -8;
    maxZ = 8;
  }
  return { placements, tubes, order, bounds: { minX, maxX, minZ, maxZ } };
}
