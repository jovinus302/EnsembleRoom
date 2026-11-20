/**
 * 중앙 탁자를 둘러 선 호(arc) 배치. three를 끌어오지 않는 순수 함수라서 단위 테스트가 쉽다.
 *
 * 탁자 뒤 가운데(-z 쪽)에서 시작해 좌우 옆으로 퍼지는 타원 호 위에, 유닛을 한 줄로 세운다.
 *  - 유닛: [사람, 그 사람의 Personal Agent] 한 쌍(n=2), 혼자 서는 Agent(n=1), Room Agent(ra, n=1)
 *  - 한 쌍 안은 `PAIR` 간격, 쌍과 쌍 사이는 `UNIT_GAP`(쌍 안보다 확실히 넓다), Room Agent 앞뒤는 `RA_GAP`
 *  - 호 길이가 모자라면 타원을 키우고, 그래도 모자라면 호를 더 넓은 각도까지 쓰고, 마지막에 간격을 줄인다
 *  - 전체 줄은 호 가운데를 중심으로 놓는다 → Room Agent(가운데 삽입)가 상석 근처에 선다
 */
export interface ArcUnit {
  /** 이 유닛에 서는 인원 수(1 또는 2) */
  n: 1 | 2;
  /** Room Agent: 앞뒤 간격을 `RA_GAP`으로 */
  ra?: boolean;
}
export interface ArcPoint {
  x: number;
  z: number;
  /** 바라보는 방향(라디안, 0 = +z). 탁자 쪽과 관객 쪽의 중간 */
  yaw: number;
}
export interface ArcTable {
  cx: number;
  cz: number;
  hw: number;
  hd: number;
}
/** 바닥 스타디움: half = 직선부 반길이, rr = 반폭(= 끝 반원 반지름) */
export interface ArcFloor {
  half: number;
  rr: number;
}

/** 한 쌍(사람-Agent) 안의 간격 */
export const PAIR = 1.0;
/** 쌍과 쌍(또는 혼자 서는 유닛) 사이 간격: 쌍 안보다 넓어서 누가 누구의 Agent인지 읽힌다 */
export const UNIT_GAP = 1.55;
/** Room Agent와 이웃 사이 간격 */
export const RA_GAP = 1.3;
/** 간격을 줄이더라도 이 비율 밑으로는 줄이지 않는다 */
const MIN_FACTOR = 0.78;
/** 시선: 탁자 중심에서 관객(+z) 쪽으로 이만큼 앞을 본다 → 뒤에 선 이는 관객, 옆에 선 이는 비스듬히 탁자 */
const LOOK_AHEAD = 1.9;
const WALL_MARGIN = 0.6;
/** 여유가 있을 때 줄이 차지하려는 호 각도(좌우 합쳐 ±WIDE_DEG)와 간격 최대 배율 */
const WIDE_DEG = 95;
const MAX_STRETCH = 1.9;

const STEPS = 360;

/** 줄 길이를 쌍 안(pair)과 간격(gap)으로 나눠 센다 */
function lengths(units: readonly ArcUnit[]): { pair: number; gap: number } {
  let pair = 0;
  let gap = 0;
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    pair += (u.n - 1) * PAIR;
    const nx = units[i + 1];
    if (nx) gap += u.ra || nx.ra ? RA_GAP : UNIT_GAP;
  }
  return { pair, gap };
}

interface Table {
  a: number;
  b: number;
  phiMax: number;
  /** 누적 호 길이: s[i]는 phi = -phiMax + i*dPhi 까지(왼쪽 끝에서 잰 길이) */
  s: Float64Array;
  total: number;
}

function buildTable(a: number, b: number, phiMax: number): Table {
  const s = new Float64Array(STEPS + 1);
  const dPhi = (2 * phiMax) / STEPS;
  let px = a * Math.sin(-phiMax);
  let pz = -b * Math.cos(-phiMax);
  for (let i = 1; i <= STEPS; i++) {
    const phi = -phiMax + i * dPhi;
    const x = a * Math.sin(phi);
    const z = -b * Math.cos(phi);
    s[i] = s[i - 1]! + Math.hypot(x - px, z - pz);
    px = x;
    pz = z;
  }
  return { a, b, phiMax, s, total: s[STEPS]! };
}

/** 호 가운데에서 잰 부호 있는 길이(+는 오른쪽, +x) → 각도 */
function phiAt(t: Table, sc: number): number {
  const target = Math.min(Math.max(t.total / 2 + sc, 0), t.total);
  let lo = 0;
  let hi = STEPS;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t.s[mid]! <= target) lo = mid;
    else hi = mid;
  }
  const seg = t.s[hi]! - t.s[lo]!;
  const u = seg > 1e-9 ? (target - t.s[lo]!) / seg : 0;
  return -t.phiMax + ((lo + u) * 2 * t.phiMax) / STEPS;
}

/** 유닛 목록을 호 위에 세운다. 반환은 유닛별 구성원 위치 배열(왼쪽에서 오른쪽 순서) */
export function arcLayout(units: readonly ArcUnit[], table: ArcTable, floor: ArcFloor): ArcPoint[][] {
  if (units.length === 0) return [];
  const xMax = Math.max(floor.half + floor.rr - 0.95, 2.2);
  const zFront = Math.max(floor.rr - WALL_MARGIN - Math.abs(table.cz) - 0.2, 1.2);
  const a0 = Math.min(Math.max(table.hw + 1.7, 3.3), xMax);
  const b0 = Math.min(Math.max(table.hd + 1.3, 1.9), zFront);

  const { pair, gap } = lengths(units);
  const need = pair + gap;
  let chosen: Table | null = null;
  outer: for (const deg of [125, 150, 172]) {
    const phiMax = (deg * Math.PI) / 180;
    for (let g = 1; g <= 1.6001; g += 0.1) {
      const t = buildTable(Math.min(a0 * g, xMax), Math.min(b0 * g, zFront), phiMax);
      chosen = t;
      if (need <= t.total) break outer;
    }
  }
  const t = chosen!;
  // 호에 여유가 있으면 쌍 사이 간격만 늘려 반원으로 둘러 서게 한다(쌍 안은 그대로). 모자라면 전체를 줄인다
  let fp = 1;
  let fg = 1;
  if (need > t.total) {
    fp = fg = Math.max(MIN_FACTOR, t.total / need);
  } else if (units.length > 2 && gap > 0) {
    const wide = buildTable(t.a, t.b, (WIDE_DEG * Math.PI) / 180);
    fg = Math.min(MAX_STRETCH, Math.max(1, 1 + (wide.total - need) / gap));
  }
  const len = pair * fp + gap * fg;

  const out: ArcPoint[][] = [];
  let s = -len / 2;
  const look = { x: table.cx, z: table.cz + LOOK_AHEAD };
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    const row: ArcPoint[] = [];
    for (let j = 0; j < u.n; j++) {
      const phi = phiAt(t, s + j * PAIR * fp);
      const x = table.cx + t.a * Math.sin(phi);
      const z = table.cz - t.b * Math.cos(phi);
      row.push({ x, z, yaw: Math.atan2(look.x - x, look.z - z) });
    }
    out.push(row);
    s += (u.n - 1) * PAIR * fp;
    const nx = units[i + 1];
    if (nx) s += (u.ra || nx.ra ? RA_GAP : UNIT_GAP) * fg;
  }
  return out;
}
