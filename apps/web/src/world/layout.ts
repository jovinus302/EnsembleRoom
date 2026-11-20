import { worldTopology, type RoomRef } from '@ensemble/shared';
import { capsuleDims, footprintHalf, totalLength, type CapsuleDims } from './capsule/dims';

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
const TOE_IN = 0.7;
/** 3행 z: 나(앞) / 우리 / 상대(뒤). 간격 18 / 23 (캡슐이 CAPSULE_SCALE만큼 커져 행 사이도 같이 벌렸다) */
const Z_MINE = 14;
const Z_OUR = -4;
const Z_YOURS = -27;
/** 행이 x에서 멀어질수록 뒤로 휜다: z -= ARC * |x| */
const ARC = 0.08;
const OUR_GAP = 4.4;
const YOURS_GAP = 4.2;
const PERM_MAX = 6;

/**
 * 순서를 유지하면서 이웃 간격 >= gap, 범위 [lo, hi] 안, 제곱 편차 합이 최소인 위치를 낸다.
 * y_i = desired_i - i*g에 등조 회귀(PAV)를 적용하는 방식이다. desired는 오름차순이어야 한다.
 */
export function spreadMinGap(desired: readonly number[], gap: number, lo = -Infinity, hi = Infinity): number[] {
  const n = desired.length;
  if (n === 0) return [];
  const finite = isFinite(lo) && isFinite(hi);
  const g = n > 1 && finite ? Math.min(gap, (hi - lo) / (n - 1)) : gap;
  const blocks: { sum: number; cnt: number }[] = [];
  for (let i = 0; i < n; i++) {
    blocks.push({ sum: desired[i]! - i * g, cnt: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1]!;
      const a = blocks[blocks.length - 2]!;
      if (a.sum / a.cnt <= b.sum / b.cnt) break;
      blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, cnt: a.cnt + b.cnt });
    }
  }
  const out: number[] = [];
  const top = hi - (n - 1) * g;
  for (const b of blocks) {
    const fit = b.sum / b.cnt;
    const q = Math.min(Math.max(fit, lo), top);
    for (let k = 0; k < b.cnt; k++) out.push(q + out.length * g);
  }
  return out;
}

interface Edge {
  o: number; // ours 인덱스
  b: number; // 상대 방 인덱스
}

interface Arrangement {
  oursOrder: number[];
  bOrder: number[];
  xo: number[]; // ours 인덱스별 x
  xb: number[]; // 상대 방 인덱스별 x
  score: [number, number, number];
}

/** 2층(Our-상대) 교차 수: 끝점을 공유하지 않는 간선 쌍 중 순서가 뒤집힌 것 */
function countCrossings(edges: readonly Edge[], xo: readonly number[], xb: readonly number[]): number {
  let c = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e = edges[i]!;
      const f = edges[j]!;
      if (e.o === f.o || e.b === f.b) continue;
      if ((xo[e.o]! - xo[f.o]!) * (xb[e.b]! - xb[f.b]!) < 0) c++;
    }
  }
  return c;
}

function lexLess(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]! - 1e-9) return true;
    if (a[i]! > b[i]! + 1e-9) return false;
  }
  return false;
}

function arrange(oursOrder: readonly number[], nB: number, edges: readonly Edge[], sOur: number, sYours: number): Arrangement {
  const n = oursOrder.length;
  const xo: number[] = new Array(n).fill(0);
  oursOrder.forEach((oi, pos) => {
    xo[oi] = (pos - (n - 1) / 2) * sOur;
  });
  const sum: number[] = new Array(nB).fill(0);
  const cnt: number[] = new Array(nB).fill(0);
  for (const e of edges) {
    sum[e.b]! += xo[e.o]!;
    cnt[e.b]! += 1;
  }
  const bary = sum.map((v, i) => (cnt[i]! ? v / cnt[i]! : 0));
  const bOrder = Array.from({ length: nB }, (_, i) => i).sort((a, b) => bary[a]! - bary[b]! || a - b);
  const placed = spreadMinGap(
    bOrder.map((b) => bary[b]!),
    sYours,
  );
  const xb: number[] = new Array(nB).fill(0);
  bOrder.forEach((b, k) => {
    xb[b] = placed[k]!;
  });
  const cross = countCrossings(edges, xo, xb);
  let dist = 0;
  for (const e of edges) dist += Math.abs(xo[e.o]! - xb[e.b]!);
  let disp = 0;
  oursOrder.forEach((oi, pos) => {
    disp += Math.abs(oi - pos);
  });
  return { oursOrder: [...oursOrder], bOrder, xo, xb, score: [cross, dist, disp] };
}

function bestArrangement(nO: number, nB: number, edges: readonly Edge[], sOur: number, sYours: number): Arrangement {
  const ident = Array.from({ length: nO }, (_, i) => i);
  if (nO <= PERM_MAX) {
    let best: Arrangement | null = null;
    // 사전식 순서로 모든 순열을 탐색(결정적). 동점이면 먼저 나온 순열 유지
    const perm: number[] = [];
    const used: boolean[] = new Array(nO).fill(false);
    const rec = () => {
      if (perm.length === nO) {
        const a = arrange(perm, nB, edges, sOur, sYours);
        if (!best || lexLess(a.score, best.score)) best = a;
        return;
      }
      for (let i = 0; i < nO; i++) {
        if (used[i]) continue;
        used[i] = true;
        perm.push(i);
        rec();
        perm.pop();
        used[i] = false;
      }
    };
    rec();
    return best ?? arrange(ident, nB, edges, sOur, sYours);
  }
  // 큰 n: barycenter 정렬을 번갈아 4회, 교차가 가장 적은 결과
  let cur = arrange(ident, nB, edges, sOur, sYours);
  let best = cur;
  for (let it = 0; it < 4; it++) {
    const sum: number[] = new Array(nO).fill(0);
    const cnt: number[] = new Array(nO).fill(0);
    for (const e of edges) {
      sum[e.o]! += cur.xb[e.b]!;
      cnt[e.o]! += 1;
    }
    const key = (oi: number) => (cnt[oi] ? sum[oi]! / cnt[oi]! : cur.xo[oi]!);
    const order = [...cur.oursOrder].sort((a, b) => key(a) - key(b) || a - b);
    cur = arrange(order, nB, edges, sOur, sYours);
    if (lexLess(cur.score, best.score)) best = cur;
  }
  return best;
}

/**
 * 시점(viewer) 중심 배치 (계획 8.3). 3행: 내 캡슐(앞, 중앙) / Our(가운데) / 상대 캡슐(뒤).
 * Our 순서는 2층 교차 수가 최소가 되도록 정하고, 상대 캡슐 x는 연결된 Our의 평균(barycenter)에서
 * 순서를 지키는 최소 간격으로 배치한다. 한 캡슐이 여러 Our 뒤에 걸치면 한 번만 놓고 튜브는 모두 연결한다.
 * 같은 월드라도 viewerId에 따라 완전히 다르게 놓인다.
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
    const rotY = Math.atan2(-x, VIEW_POINT_Z - z) * TOE_IN;
    placements[roomId] = { roomId, x, z, rotY, dims, row };
    order.push(roomId);
  };

  if (topo.front) put(topo.front, 0, Z_MINE, 0);

  const ours = topo.ours.filter((o) => byId.has(o.roomId));
  const nO = ours.length;
  const sOur = 2 * footprintHalf(capsuleDims('plump')).hl + OUR_GAP;
  const sYours = 2 * footprintHalf(capsuleDims('long')).hl + YOURS_GAP;

  // 상대 방: 첫 등장 순. 내 방은 제외
  const bIds: string[] = [];
  const edges: Edge[] = [];
  ours.forEach((o, oi) => {
    const seen = new Set<string>();
    for (const b of o.behind) {
      if (b === topo.front || !byId.has(b) || seen.has(b)) continue;
      seen.add(b);
      let bi = bIds.indexOf(b);
      if (bi < 0) {
        bi = bIds.length;
        bIds.push(b);
      }
      edges.push({ o: oi, b: bi });
    }
  });

  if (nO > 0) {
    const arr = bestArrangement(nO, bIds.length, edges, sOur, sYours);
    for (const oi of arr.oursOrder) {
      const x = arr.xo[oi]!;
      put(ours[oi]!.roomId, x, Z_OUR - ARC * Math.abs(x), 1);
    }
    for (const bi of arr.bOrder) {
      const x = arr.xb[bi]!;
      put(bIds[bi]!, x, Z_YOURS - ARC * Math.abs(x), 2);
    }
  }

  const tubes = topo.tubes.filter((t) => placements[t.from] && placements[t.to]);

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of Object.values(placements)) {
    const fp = footprintHalf(p.dims);
    const half = Math.max(totalLength(p.dims) / 2, fp.hl);
    const depth = Math.max(p.dims.radius, fp.hd);
    minX = Math.min(minX, p.x - half);
    maxX = Math.max(maxX, p.x + half);
    minZ = Math.min(minZ, p.z - depth);
    maxZ = Math.max(maxZ, p.z + depth);
  }
  if (!isFinite(minX)) {
    minX = -8;
    maxX = 8;
    minZ = -8;
    maxZ = 8;
  }
  return { placements, tubes, order, bounds: { minX, maxX, minZ, maxZ } };
}
