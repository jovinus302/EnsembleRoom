import type { ThemeId, ThemeVariant } from '@ensemble/shared';
import { MINI_SCALE, capsuleDims, type CapsuleDims } from '../capsule/dims';
import type { QualityTier } from '../quality';

/**
 * 캡슐 내부 세트 데이터 (S17). 좌표는 capsule/dims.ts의 내부 좌표계(바닥 윗면 중앙 원점, +x 길이, +y 위, +z 관객 쪽).
 * 소품 위치는 "바닥 중앙 피벗" 기준이고, 회전 0은 소품 앞면이 +z(관객 쪽)를 향한다.
 */
export type V3 = readonly [number, number, number];

export interface PropSpec {
  id: string;
  x: number;
  z: number;
  /** 놓인 높이(기본 0 = 바닥). 책상 위 소품은 책상 윗면 높이 */
  y?: number;
  /** y축 회전(도). 0이면 앞면이 +z */
  rot?: number;
  /** 추가 배율(MINI_SCALE에 곱한다). 숫자 또는 [x,y,z] */
  s?: number | V3;
  /** 0 = 항상, 1 = mid 이상, 2 = high 전용 */
  p?: 0 | 1 | 2;
  /** 천 재질 색 선택: a = 소유자(구성원) 색, b = 보조색 */
  tone?: 'a' | 'b';
  /** true면 좌표·크기를 방 확대(`scaleSpec`)에서 제외한다: 최종 월드 치수로 직접 쓴 소품(줄인 탁자와 그 위 물건) */
  abs?: boolean;
  /** 장애물 반경 배율(기준 소품 대비). scaleSpec이 확대한 소품은 자동으로 k가 들어간다 */
  sc?: number;
}

export interface InteriorSeat {
  index: number;
  /** 캐릭터가 서는 바닥 위치(내부 좌표계). 이 둘레 반경 `SEAT_CLEARANCE`는 소품 없이 비어 있다 */
  position: V3;
  /** 바라보는 방향의 y축 회전(라디안, 0 = +z 관객 쪽을 봄). 테이블을 향한다 */
  yaw: number;
  /** 근처 소품(의자·소파) 중심. Agent는 사람 옆 `agentOffset`에 선다 */
  agentOffset: V3;
}
export const SEAT_CLEARANCE = 0.34;

export interface BoardSlot {
  /** 카드가 붙는 중심(내부 좌표계) */
  position: V3;
  width: number;
  height: number;
}
export interface BoardAnchor {
  kind: 'frame' | 'whiteboard';
  /** 보드 면 중심 */
  position: V3;
  /** 면의 법선이 향하는 y회전(라디안). 벽에 걸려 있으므로 거의 0(= +z를 봄) */
  yaw: number;
  width: number;
  height: number;
  slots: BoardSlot[];
}

export interface MemoryShelfAnchor {
  /** 선반(기억 병이 놓이는 줄) 중심과 길이 */
  position: V3;
  yaw: number;
  length: number;
}

export interface InteriorSpec {
  props: PropSpec[];
  seats: InteriorSeat[];
  board: BoardAnchor;
  memoryShelf: MemoryShelfAnchor;
  /** 보드 도구(사다리·정산표·여행 계획) 소품이 놓이는 탁자 위 자리 [x, 윗면 높이, z]. 4개까지(5번째부터는 3D에 안 그린다) */
  toolSlots: V3[];
  /** 도구 소품 배율(탁자 크기에 맞춤) */
  toolScale: number;
  /** true면 toolSlots·toolScale이 최종 월드 치수다(scaleSpec이 키우지 않는다) */
  toolsAbs?: boolean;
  /** 중앙 탁자(최종 월드 좌표). 사람·Agent가 이 탁자를 둘러 서는 호의 중심과 크기를 정한다. 없으면 기본값 */
  table?: { cx: number; cz: number; hw: number; hd: number };
  /** 벽 색 팔레트 키와 바닥 판재 */
  floor: 'birch' | 'walnut' | 'oak' | 'concrete';
  wall: 'studio' | 'lounge' | 'home' | 'meeting';
  wallCap: number;
  /** 모든 소품에 곱하는 배율(MINI_SCALE 위에) */
  scale: number;
}

// ---------------------------------------------------------------- 벽 좌표

const WALL_INSET = 0.1;
const S = MINI_SCALE;
const rad = (d: number) => (d * Math.PI) / 180;

export interface WallFrame {
  x: number;
  z: number;
  /** 벽 안쪽 법선의 y회전(도): 이 값으로 놓으면 소품 앞면이 방 안쪽을 본다 */
  rot: number;
  nx: number;
  nz: number;
}

/** 바닥 스타디움의 뒤쪽 절반(왼쪽 끝 - 뒷벽 - 오른쪽 끝)을 따라가는 좌표. s = 뒷벽 중앙에서 잰 호 길이(왼쪽이 음수), off = 벽에서 안쪽으로의 거리 */
export function wallFrame(d: CapsuleDims, s: number, off = 0): WallFrame {
  const rr = d.floorHalfDepth - WALL_INSET;
  const half = d.length / 2;
  const sign = s < 0 ? -1 : 1;
  const a = Math.abs(s);
  let px: number;
  let pz: number;
  let nx: number;
  let nz: number;
  if (a <= half) {
    px = s;
    pz = -rr;
    nx = 0;
    nz = 1;
  } else {
    const th = Math.min((a - half) / rr, Math.PI / 2);
    px = sign * (half + rr * Math.sin(th));
    pz = -rr * Math.cos(th);
    nx = -sign * Math.sin(th);
    nz = Math.cos(th);
  }
  return { x: px + nx * off, z: pz + nz * off, rot: (Math.atan2(nx, nz) * 180) / Math.PI, nx, nz };
}

export function wallRadius(d: CapsuleDims) {
  return d.floorHalfDepth - WALL_INSET;
}
/** 벽 호 길이의 한쪽 최대(= 끝점까지) */
export function wallHalfSpan(d: CapsuleDims) {
  return d.length / 2 + (wallRadius(d) * Math.PI) / 2;
}

/** 내부 좌표 (x,z)에서 유리 천장까지의 높이(바닥 기준). 유리 안쪽 0.1 여유 */
export function glassClearance(d: CapsuleDims, x: number, z: number) {
  const a0 = d.axisHeight - d.floorHeight;
  const half = d.length / 2;
  const ex = Math.max(Math.abs(x) - half, 0);
  const r = Math.sqrt(Math.max(d.radius * d.radius - ex * ex, 0));
  return a0 + Math.sqrt(Math.max(r * r - z * z, 0)) - 0.1;
}

// ---------------------------------------------------------------- 높이 상수(미터 -> 월드)

/** studio/lounge(길쭉한 캡슐) 소품 배율. cafe는 소품마다 s=CS를 직접 준다 */
const K = 1.22;
const h = (m: number, k = 1) => m * S * k;
const hk = (m: number, k = 1) => m * S * K * k;

/** 소품 윗면 높이 */
export const TOP = {
  desk: hk(0.384),
  sideTable: hk(0.384),
  tableCoffee: hk(0.23),
  sofaSeat: hk(0.26),
  barCounter: h(0.42, 1.2),
  tableHome: h(0.327, 1.2),
  tableCross: h(0.347, 1.2),
  cabinetTv: hk(0.31),
  bookcaseOpen: hk(0.88),
  bookcaseClosed: hk(0.85),
  bookcaseWide: hk(0.79),
};

const yawToward = (fx: number, fz: number, tx: number, tz: number) => Math.atan2(tx - fx, tz - fz);

function seat(index: number, x: number, z: number, toX: number, toZ: number, agent: V3 = [0.85, 0, 0.12]): InteriorSeat {
  return { index, position: [x, 0, z], yaw: yawToward(x, z, toX, toZ), agentOffset: agent };
}

// ---------------------------------------------------------------- 스튜디오 (Alice My Room, long)

function studio(d: CapsuleDims, _k: number): InteriorSpec {
  const bz = (depth: number) => wallFrame(d, 0, depth / 2 + 0.03).z; // 뒷벽 직선부에 붙은 소품의 z
  const deskZ = bz(hk(0.392));
  const deskW = hk(0.734);
  const dx1 = -2.0;
  const dx2 = dx1 + deskW + 0.02;
  const wallZ = wallFrame(d, 0, 0).z;
  const props: PropSpec[] = [
    // 바닥: 러그(전체 아래), 그 위에 작업 구역
    { id: 'rug-rectangle', x: 0.45, z: 0.3, s: [1.25, 1, 1.2], tone: 'a' },
    { id: 'rug-rectangle', x: -1.5, z: -0.2, s: [0.95, 1, 0.8], tone: 'b', p: 1 },
    // 책상 두 개 + 모니터·키보드·램프
    { id: 'desk', x: dx1, z: deskZ },
    { id: 'desk', x: dx2, z: deskZ },
    { id: 'computer-screen', x: dx1 - 0.02, z: deskZ - 0.08, y: TOP.desk },
    { id: 'computer-screen', x: dx2 + 0.1, z: deskZ - 0.08, y: TOP.desk, rot: -8, p: 1 },
    { id: 'computer-keyboard', x: dx1, z: deskZ + 0.18, y: TOP.desk },
    { id: 'computer-mouse', x: dx1 + 0.42, z: deskZ + 0.2, y: TOP.desk, p: 1 },
    { id: 'laptop', x: dx2 - 0.05, z: deskZ + 0.1, y: TOP.desk, rot: 12, p: 1 },
    { id: 'lamp-square-table', x: dx1 - 0.45, z: deskZ - 0.05, y: TOP.desk },
    { id: 'books', x: dx2 + 0.38, z: deskZ + 0.15, y: TOP.desk, rot: 20, p: 2 },
    { id: 'chair-desk', x: dx1 + 0.35, z: deskZ + 0.62, rot: 180 + 14, tone: 'a' },
    { id: 'chair-desk', x: dx2 - 0.15, z: deskZ + 0.72, rot: 180 - 22, tone: 'b', p: 1 },
    // 가운데: 보드 아래 보조 테이블
    { id: 'side-table', x: 0.62, z: bz(hk(0.22)), p: 1, s: [1.0, 1, 1.15] },
    { id: 'plant-small-1', x: 0.4, z: bz(hk(0.22)) + 0.02, y: TOP.sideTable, p: 1 },
    { id: 'books', x: 0.85, z: bz(hk(0.22)) + 0.04, y: TOP.sideTable, rot: -12, p: 2 },
    // 오른쪽: 책장 세 칸 + 위의 소품
    { id: 'bookcase-open', x: 1.72, z: bz(hk(0.25)) },
    { id: 'bookcase-open', x: 2.42, z: bz(hk(0.25)) },
    { id: 'bookcase-open', x: 3.1, z: bz(hk(0.25)) + 0.12, rot: 14, p: 1 },
    { id: 'books', x: 1.72, z: bz(hk(0.25)), y: TOP.bookcaseOpen, rot: 8, p: 1 },
    { id: 'plant-small-2', x: 2.42, z: bz(hk(0.25)), y: TOP.bookcaseOpen, p: 1 },
    { id: 'books', x: 3.1, z: bz(hk(0.25)) + 0.12, y: TOP.bookcaseOpen, rot: -14, p: 2 },
    // 스피커 한 쌍
    { id: 'speaker', x: -0.02, z: bz(hk(0.148)), p: 1 },
    { id: 'speaker', x: 1.3, z: bz(hk(0.148)), p: 1 },
    // 구석 소품
    { id: 'lamp-round-floor', x: -3.0, z: -0.55, rot: 20 },
    { id: 'potted-plant', x: -3.1, z: 0.45, p: 1 },
    { id: 'potted-plant', x: 3.2, z: 0.15, p: 0 },
    { id: 'rug-rectangle', x: 1.9, z: 0.95, s: [0.7, 1, 0.55], tone: 'b' },
    { id: 'cardboard-box-open', x: 1.1, z: 1.0, rot: 25, s: 0.8, p: 2 },
    { id: 'laptop', x: 1.9, z: 0.98, y: 0.02, rot: -20, s: 0.8, p: 2 },
    { id: 'coat-rack-standing', x: 3.35, z: -0.55, p: 2 },
    { id: 'cardboard-box-open', x: 2.75, z: 0.85, rot: -18, p: 2 },
    { id: 'books', x: -2.45, z: 0.95, rot: 30, p: 2 },
    { id: 'plant-small-3', x: 1.35, z: 1.02, p: 2 },
  ];
  void wallZ;
  const boardY = 1.02;
  const boardZ = wallFrame(d, 0, 0.06).z;
  return {
    props,
    seats: [seat(0, dx1 + 0.25, 0.28, dx1 + 0.25, deskZ), seat(1, 0.45, 0.62, 0.45, wallZ)],
    board: makeBoard('frame', 0.42, boardY, boardZ, 1.15, 0.7, 3, 1),
    memoryShelf: { position: [2.2, TOP.bookcaseOpen * 0.55, bz(hk(0.25)) + 0.2], yaw: 0, length: 1.7 },
    toolSlots: [
      [dx2 - 0.42, TOP.desk, deskZ + 0.2],
      [dx2 + 0.38, TOP.desk, deskZ + 0.2],
      [0.62, TOP.sideTable, bz(hk(0.22)) + 0.04],
      [dx1 + 0.5, TOP.desk, deskZ + 0.22],
    ],
    toolScale: 1.0,
    floor: 'birch',
    wall: 'studio',
    wallCap: 1.62,
    scale: K,
  };
}

// ---------------------------------------------------------------- 라운지 (Bob My Room, long)

function lounge(d: CapsuleDims, _k: number): InteriorSpec {
  const bz = (depth: number) => wallFrame(d, 0, depth / 2 + 0.03).z;
  const wallZ = wallFrame(d, 0, 0).z;
  const sofaX = -1.75;
  const sofaZ = bz(hk(0.41));
  const props: PropSpec[] = [
    { id: 'rug-round', x: -0.6, z: 0.25, s: 2.2, tone: 'b' },
    // 소파 + 쿠션 + 낮은 테이블
    { id: 'lounge-sofa', x: sofaX, z: sofaZ, tone: 'a' },
    { id: 'pillow', x: sofaX - 0.38, z: sofaZ + 0.06, y: hk(0.2), rot: 8, tone: 'b' },
    { id: 'pillow-blue', x: sofaX + 0.4, z: sofaZ + 0.08, y: hk(0.2), rot: -10, p: 1 },
    { id: 'table-coffee', x: sofaX, z: 0.82, p: 0, s: [1, 1, 0.9] },
    { id: 'books', x: sofaX - 0.2, z: 0.82, y: TOP.tableCoffee, rot: 25, p: 1 },
    { id: 'plant-small-2', x: sofaX + 0.35, z: 0.82, y: TOP.tableCoffee, p: 1 },
    // 사이드 테이블 + 스탠드
    { id: 'side-table-drawers', x: -0.42, z: bz(hk(0.22)), p: 0 },
    { id: 'lamp-round-table', x: -0.42, z: bz(hk(0.22)) + 0.02, y: TOP.sideTable },
    // 서재: 책장 + 라디오·화분
    { id: 'bookcase-closed-wide', x: 0.95, z: bz(hk(0.25)) },
    { id: 'bookcase-closed-wide', x: 2.4, z: bz(hk(0.25)) + 0.04, rot: 4 },
    { id: 'radio', x: 0.6, z: bz(hk(0.25)), y: TOP.bookcaseWide, p: 1 },
    { id: 'books', x: 1.3, z: bz(hk(0.25)), y: TOP.bookcaseWide, rot: 12, p: 1 },
    { id: 'plant-small-2', x: 2.4, z: bz(hk(0.25)) + 0.04, y: TOP.bookcaseWide, p: 1 },
    { id: 'books', x: 2.75, z: bz(hk(0.25)) + 0.04, y: TOP.bookcaseWide, rot: -10, p: 2 },
    // 안락의자·플로어 스탠드·화분
    { id: 'lounge-chair-relax', x: 1.75, z: 0.3, rot: 24, tone: 'b' },
    { id: 'pillow', x: 1.75, z: 0.26, y: hk(0.22), rot: 24, p: 2 },
    { id: 'table-coffee', x: 0.95, z: 0.95, s: [0.55, 1, 0.55], p: 2 },
    { id: 'lamp-round-floor', x: -3.05, z: -0.35, rot: 12 },
    { id: 'potted-plant', x: -3.1, z: 0.55, p: 1 },
    { id: 'potted-plant', x: 3.2, z: -0.4, p: 0 },
    { id: 'speaker-small', x: 3.15, z: 0.45, rot: -30, p: 2 },
    { id: 'television-vintage', x: 0.4, z: 0.95, y: hk(0.31, 0.55), s: 0.5, p: 2 },
  ];
  return {
    props,
    seats: [seat(0, sofaX - 0.4, -0.22, sofaX, 0.6), seat(1, sofaX + 0.45, -0.22, sofaX, 0.6)],
    board: makeBoard('frame', sofaX, 1.18, wallFrame(d, 0, 0.06).z, 1.45, 0.62, 3, 1),
    memoryShelf: { position: [1.3, TOP.bookcaseWide * 0.6, bz(hk(0.25)) + 0.2], yaw: 0, length: 2.2 },
    toolSlots: [
      [sofaX - 0.36, TOP.tableCoffee, 0.8],
      [sofaX + 0.04, TOP.tableCoffee, 0.86],
      [sofaX + 0.42, TOP.tableCoffee, 0.8],
      [-0.42, TOP.sideTable, bz(hk(0.22)) + 0.14],
    ],
    toolScale: 0.8,
    floor: 'walnut',
    wall: 'lounge',
    wallCap: 1.62,
    scale: K,
  };
}

// ---------------------------------------------------------------- 카페 (Our Rooms, plump)

const CS = 1.2; // 카페 소품 배율(Our 캡슐은 1.6배 크다)
const ch = (m: number) => m * S * CS;

function cafeCommon(d: CapsuleDims, side: -1 | 1, counterRot = 0): PropSpec[] {
  // 호를 따라 놓이는 주방 카운터. side=-1 왼쪽 끝, +1 오른쪽 끝
  const out: PropSpec[] = [];
  const modW = ch(0.43);
  const base = 2.05; // 직선부 끝에서 시작
  const mods = [0, 1, 2];
  for (const i of mods) {
    const s = side * (base + i * modW + modW / 2 + 0.12);
    const f = wallFrame(d, s, ch(0.21) + 0.04);
    out.push({ id: 'kitchen-bar', x: f.x, z: f.z, rot: f.rot + counterRot, s: CS });
    if (i === 1) out.push({ id: 'kitchen-coffee-machine', x: f.x, z: f.z, y: ch(0.42) - 0.01, rot: f.rot, s: CS });
    if (i === 0) out.push({ id: 'kitchen-blender', x: f.x, z: f.z, y: ch(0.42) - 0.01, rot: f.rot, s: CS, p: 1 });
    if (i === 2) out.push({ id: 'toaster', x: f.x, z: f.z, y: ch(0.42) - 0.01, rot: f.rot, s: CS, p: 2 });
    if (i < 2) {
      const up = wallFrame(d, s, ch(0.1) + 0.04);
      out.push({ id: 'kitchen-cabinet-upper', x: up.x, z: up.z, y: 1.15, rot: up.rot, s: CS, p: i === 0 ? 0 : 1 });
    }
  }
  const e = wallFrame(d, side * (base + 3 * modW + 0.2), ch(0.1));
  out.push({ id: 'kitchen-bar-end', x: e.x, z: e.z, rot: e.rot, s: CS, p: 1 });
  return out;
}

/** 줄인 탁자 배율: 이전 월드 치수 대비 길이·깊이 72% */
const TABLE_U = 0.72;

function cafeHome(d: CapsuleDims, k: number): InteriorSpec {
  const wallZ = wallFrame(d, 0, 0).z;
  const tz = 0.05; // 탁자 중심(최종 월드 좌표)
  const U = TABLE_U;
  const tableS: V3 = [1.3 * CS * U, CS, 1.4 * CS * U];
  const tableHW = (0.841 * S * tableS[0]) / 2;
  const tableHD = (0.447 * S * tableS[2]) / 2;
  const props: PropSpec[] = [
    { id: 'rug-rectangle', x: 0, z: 0.15, s: [1.8, 1, 1.75], tone: 'a' },
    ...cafeCommon(d, -1),
    // 줄인 식탁(최종 치수) + 양끝 의자. 사람은 식탁 둘레의 호(agents/plan.ts)에 선다
    { id: 'table-cloth', x: 0, z: tz, s: tableS, tone: 'a', abs: true, sc: U },
    { id: 'chair-cushion', x: -(tableHW + 0.38), z: tz, rot: 90, s: CS, tone: 'b', abs: true, p: 1 },
    { id: 'chair-cushion', x: tableHW + 0.38, z: tz, rot: -90, s: CS, tone: 'b', abs: true, p: 1 },
    // 거실: 오른쪽 호에 소파, 앞에 러그와 낮은 테이블
    { id: 'rug-round', x: 2.9, z: 0.55, s: 2.1, tone: 'b' },
    ...(() => {
      const f = wallFrame(d, 2.9, h(0.205, CS) + 0.04);
      const f2 = wallFrame(d, 2.9, h(0.205, CS) * 2.0);
      return [
        { id: 'lounge-sofa', x: f.x, z: f.z, rot: f.rot, s: CS, tone: 'a' as const },
        { id: 'pillow', x: f.x - 0.4, z: f.z + 0.04, y: ch(0.2), rot: f.rot, s: CS, tone: 'b' as const, p: 1 as const },
        { id: 'bear', x: f.x + 0.35, z: f.z + 0.1, y: ch(0.2), rot: f.rot, s: CS * 0.7, p: 1 as const },
        { id: 'table-coffee', x: f2.x + 0.5, z: f2.z + 1.0, rot: f.rot * 0.4, s: CS * 0.95, p: 0 as const },
      ];
    })(),
    { id: 'bench-cushion', x: wallFrame(d, 1.35, 0.3).x, z: wallFrame(d, 1.35, 0.3).z, s: CS, tone: 'b', p: 1 },
    { id: 'lamp-round-floor', x: 1.95, z: -1.65, rot: 10, s: CS },
    { id: 'potted-plant', x: 3.85, z: -0.35, s: CS, p: 1 },
    { id: 'potted-plant', x: -3.75, z: 1.05, s: CS, p: 1 },
    { id: 'plant-small-1', x: -1.3, z: 1.0, y: 0, s: CS, p: 2 },
    { id: 'trashcan', x: -3.15, z: 1.65, s: CS, p: 2 },
    { id: 'lamp-wall', x: wallFrame(d, -1.0, 0.04).x, z: wallFrame(d, -1.0, 0.04).z, y: 1.55, s: CS, p: 2 },
    { id: 'lamp-wall', x: wallFrame(d, 1.0, 0.04).x, z: wallFrame(d, 1.0, 0.04).z, y: 1.55, s: CS, p: 2 },
  ];
  // 좌석 0..3은 탁자 둘레(최종 좌표를 기준 좌표로 환산), 4·5는 소파 쪽. 캐릭터 배치는 plan.ts의 호가 하고, 좌석은 idle 배회·디버그용이다
  const sf = (i: number, x: number, z: number) => seat(i, x / k, z / k, 0, tz / k);
  const seats = [
    sf(0, -tableHW - 0.5, tz - 0.9),
    sf(1, tableHW + 0.5, tz - 0.9),
    sf(2, -tableHW - 0.5, tz + 0.9),
    sf(3, tableHW + 0.5, tz + 0.9),
    seat(4, 2.35, 0.2, 3.0, 1.2),
    seat(5, 3.35, 0.95, 2.8, 1.0),
  ];
  return {
    props,
    seats,
    board: makeBoard('frame', 0, 1.55, wallFrame(d, 0, 0.06).z, 2.1, 0.8, 3, 1),
    memoryShelf: { position: [-0.9, 1.1, wallZ + 0.2], yaw: 0, length: 1.4 },
    // 줄어든 상판(1.3 x 0.76) 위: 앞뒤로 엇갈려 4개
    toolSlots: [
      [-0.42, TOP.tableHome, tz - 0.1],
      [-0.14, TOP.tableHome, tz + 0.12],
      [0.14, TOP.tableHome, tz - 0.1],
      [0.42, TOP.tableHome, tz + 0.12],
    ],
    toolScale: 1.0,
    toolsAbs: true,
    table: { cx: 0, cz: tz, hw: tableHW, hd: tableHD },
    floor: 'oak',
    wall: 'home',
    wallCap: 2.1,
    scale: 1,
  };
}

function cafeMeeting(d: CapsuleDims, k: number): InteriorSpec {
  const wallZ = wallFrame(d, 0, 0).z;
  const tz = 0.1; // 탁자 중심(최종 월드 좌표)
  const U = TABLE_U;
  const tw = ch(0.852) * U; // 3칸 중 한 칸의 폭
  const tableS: V3 = [CS * U, CS, CS * 1.3 * U];
  const tableHW = (3 * tw) / 2;
  const tableHD = (0.447 * S * tableS[2]) / 2;
  const props: PropSpec[] = [
    { id: 'rug-rectangle', x: 0, z: 0.2, s: [2.4, 1, 2.2], tone: 'b' },
    ...cafeCommon(d, 1),
    // 줄인 긴 탁자 3칸(최종 치수). 의자는 양끝만: 사람은 탁자 뒤·옆 호에 서므로 앞뒤 의자는 시야와 자리를 가린다
    { id: 'table-cross', x: -tw, z: tz, s: tableS, abs: true, sc: U },
    { id: 'table-cross', x: 0, z: tz, s: tableS, abs: true, sc: U },
    { id: 'table-cross', x: tw, z: tz, s: tableS, abs: true, sc: U },
    { id: 'laptop', x: -tw * 1.15, z: tz + 0.2, y: TOP.tableCross, rot: 8, s: CS * 0.8, abs: true, p: 0 },
    { id: 'laptop', x: tw * 1.15, z: tz + 0.2, y: TOP.tableCross, rot: -8, s: CS * 0.8, abs: true, p: 1 },
    { id: 'books', x: tw * 0.15, z: tz - 0.2, y: TOP.tableCross, rot: 15, s: CS * 0.8, abs: true, p: 2 },
    { id: 'chair-modern-cushion', x: -(tableHW + 0.4), z: tz, rot: 90, s: CS, tone: 'b', abs: true, p: 1 },
    { id: 'chair-modern-cushion', x: tableHW + 0.4, z: tz, rot: -90, s: CS, tone: 'b', abs: true, p: 1 },
    // 벽: 발표 화면 + 스피커 + 화분
    { id: 'speaker', x: wallFrame(d, -1.95, 0.2).x, z: wallFrame(d, -1.95, 0.2).z, s: CS, p: 1 },
    { id: 'speaker', x: wallFrame(d, 1.9, 0.2).x, z: wallFrame(d, 1.9, 0.2).z, s: CS, p: 1 },
    { id: 'potted-plant', x: wallFrame(d, -2.6, 0.35).x, z: wallFrame(d, -2.6, 0.35).z, s: CS },
    { id: 'potted-plant', x: -3.85, z: 0.9, s: CS, p: 1 },
    { id: 'potted-plant', x: 3.55, z: 1.55, s: CS, p: 2 },
    { id: 'lamp-round-floor', x: wallFrame(d, -3.4, 0.3).x, z: wallFrame(d, -3.4, 0.3).z, s: CS },
    { id: 'lamp-round-floor', x: wallFrame(d, 4.55, 0.35).x, z: wallFrame(d, 4.55, 0.35).z, s: CS, p: 1 },
    { id: 'television-modern', x: wallFrame(d, -3.3, 0.15).x + 0.2, z: wallFrame(d, -3.3, 0.15).z, y: 1.15, rot: wallFrame(d, -3.3, 0).rot, s: CS * 0.8, p: 2 },
    { id: 'trashcan', x: -3.3, z: 1.55, s: CS, p: 2 },
  ];
  // 좌석은 탁자 둘레(최종 좌표를 기준 좌표로 환산). 캐릭터 배치는 plan.ts의 호가 하고, 좌석은 idle 배회·디버그용이다
  const sf = (i: number, x: number, z: number) => seat(i, x / k, z / k, 0, tz / k);
  const seats: InteriorSeat[] = [
    sf(0, -tw, tz - 0.9),
    sf(1, 0, tz - 0.9),
    sf(2, tw, tz - 0.9),
    sf(3, -tw, tz + 0.9),
    sf(4, 0, tz + 0.95),
    sf(5, tw, tz + 0.9),
    sf(6, -tableHW - 0.8, tz),
    sf(7, tableHW + 0.8, tz),
  ];
  return {
    props,
    seats,
    board: makeBoard('whiteboard', 0, 1.2, wallFrame(d, 0, 0.06).z, 3.0, 1.3, 4, 2),
    memoryShelf: { position: [3.1, 1.2, wallFrame(d, 3.1, 0.2).z], yaw: 0, length: 1.2 },
    // 줄어든 상판(3.1 x 0.7) 위 가운데 줄
    toolSlots: [
      [-0.85, TOP.tableCross, tz - 0.02],
      [-0.28, TOP.tableCross, tz - 0.02],
      [0.28, TOP.tableCross, tz - 0.02],
      [0.85, TOP.tableCross, tz - 0.02],
    ],
    toolScale: 1.3,
    toolsAbs: true,
    table: { cx: 0, cz: tz, hw: tableHW, hd: tableHD },
    floor: 'concrete',
    wall: 'meeting',
    wallCap: 2.15,
    scale: 1,
  };
}

function makeBoard(kind: BoardAnchor['kind'], x: number, y: number, z: number, w: number, hh: number, cols: number, rows: number): BoardAnchor {
  const slots: BoardSlot[] = [];
  const padX = w * 0.06;
  const padY = hh * 0.1;
  const gap = w * 0.03;
  const cw = (w - padX * 2 - gap * (cols - 1)) / cols;
  const chh = (hh - padY * 2 - gap * (rows - 1)) / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      slots.push({
        position: [x - w / 2 + padX + cw / 2 + c * (cw + gap), y + hh / 2 - padY - chh / 2 - r * (chh + gap), z + 0.025],
        width: cw,
        height: chh,
      });
    }
  }
  return { kind, position: [x, y, z + 0.02], yaw: 0, width: w, height: hh, slots };
}


// ---------------------------------------------------------------- 방 확대

function scaleS(sv: PropSpec['s'], k: number): number | V3 {
  if (sv === undefined) return k;
  if (typeof sv === 'number') return sv * k;
  return [sv[0] * k, sv[1] * k, sv[2] * k];
}

/** 기준 치수로 짠 세트를 k배 키운다: 위치·높이·소품 크기를 모두 k배(벽·바닥은 이미 새 dims로 그려진다). abs 소품과 toolsAbs 도구 자리는 그대로 둔다 */
export function scaleSpec(spec: InteriorSpec, k: number): InteriorSpec {
  if (k === 1) return spec;
  const v3 = (v: V3): V3 => [v[0] * k, v[1] * k, v[2] * k];
  return {
    ...spec,
    props: spec.props.map((p) => {
      if (p.abs) return p;
      const q: PropSpec = { ...p, x: p.x * k, z: p.z * k, s: scaleS(p.s, k), sc: (p.sc ?? 1) * k };
      if (p.y !== undefined) q.y = p.y * k;
      return q;
    }),
    seats: spec.seats.map((s) => ({ ...s, position: v3(s.position), agentOffset: v3(s.agentOffset) })),
    board: {
      ...spec.board,
      position: v3(spec.board.position),
      width: spec.board.width * k,
      height: spec.board.height * k,
      slots: spec.board.slots.map((sl) => ({ ...sl, position: v3(sl.position), width: sl.width * k, height: sl.height * k })),
    },
    memoryShelf: { ...spec.memoryShelf, position: v3(spec.memoryShelf.position), length: spec.memoryShelf.length * k },
    toolSlots: spec.toolsAbs ? spec.toolSlots : spec.toolSlots.map(v3),
    toolScale: spec.toolsAbs ? spec.toolScale : spec.toolScale * k,
    wallCap: spec.wallCap * k,
  };
}

// ---------------------------------------------------------------- 공개 API

const cache = new Map<string, InteriorSpec>();

/** 테마·variant·캡슐 비율로 정해지는 실내 세트(품질 필터 전). 결과는 캐시된다 */
export function interiorSpec(theme: ThemeId, variant: ThemeVariant | null, dims: CapsuleDims): InteriorSpec {
  const key = `${theme}|${variant ?? ''}|${dims.proportion}`;
  let spec = cache.get(key);
  if (!spec) {
    // 소품 좌표는 기준 치수(배율 1)로 짠 뒤 캡슐이 커진 만큼 키운다. 단 abs 소품(줄인 탁자)은 최종 치수 그대로
    const d0 = capsuleDims(dims.proportion, 1);
    const k = dims.radius / d0.radius;
    const built = theme === 'studio' ? studio(d0, k) : theme === 'lounge' ? lounge(d0, k) : variant === 'meeting' ? cafeMeeting(d0, k) : cafeHome(d0, k);
    spec = scaleSpec(built, k);
    cache.set(key, spec);
  }
  return spec;
}

export function tierAllows(p: 0 | 1 | 2 | undefined, tier: QualityTier): boolean {
  const lvl = p ?? 0;
  return tier === 'high' ? true : tier === 'mid' ? lvl <= 1 : lvl === 0;
}

/** 이 테마가 쓰는 GLB id 목록(중복 제거) */
export function interiorPropIds(spec: InteriorSpec): string[] {
  return [...new Set(spec.props.map((p) => p.id))];
}

/** S18용: 캐릭터가 서는 자리(내부 좌표계). 개수는 `themeSeats(theme, variant)`와 같다 */
export function interiorSeats(theme: ThemeId, variant: ThemeVariant | null, dims: CapsuleDims): InteriorSeat[] {
  return interiorSpec(theme, variant, dims).seats;
}
/** S18/S19용: 카드가 붙는 보드(벽 액자/화이트보드) 앵커 */
export function interiorBoard(theme: ThemeId, variant: ThemeVariant | null, dims: CapsuleDims): BoardAnchor {
  return interiorSpec(theme, variant, dims).board;
}
/** 보드 도구 소품 자리(내부 좌표계) */
export function interiorToolSlots(theme: ThemeId, variant: ThemeVariant | null, dims: CapsuleDims): V3[] {
  return interiorSpec(theme, variant, dims).toolSlots;
}
export function interiorMemoryShelf(theme: ThemeId, variant: ThemeVariant | null, dims: CapsuleDims): MemoryShelfAnchor {
  return interiorSpec(theme, variant, dims).memoryShelf;
}

export { rad as _rad };
