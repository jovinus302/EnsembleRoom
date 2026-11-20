import { describe, expect, it } from 'vitest';
import { capsuleDims } from '../capsule/dims';
import { interiorSpec, TOP } from '../interiors/layouts';
import { arcLayout, PAIR, UNIT_GAP } from './arc';
import { planRoom, type RoomPlan } from './plan';
import type { CharacterInput } from './types';

const base = (p: Partial<CharacterInput> & Pick<CharacterInput, 'id' | 'kind' | 'name' | 'roomId'>): CharacterInput => ({
  color: '#888888',
  ownerId: null,
  isMe: false,
  activity: 'idle',
  mode: 'accompanied',
  recalling: false,
  representing: false,
  visiting: false,
  handoverPending: false,
  target: null,
  targetCharId: null,
  cue: null,
  speech: null,
  awaitingApproval: false,
  detail: 'full',
  seatUserId: null,
  ...p,
});

const ROOM = 'our_x';
const uids = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);

function team(n: number, opts: { away?: number[]; roomAgent?: boolean; guests?: number; represent?: number[] } = {}): CharacterInput[] {
  const out: CharacterInput[] = [];
  uids(n).forEach((u, i) => {
    const away = opts.away?.includes(i);
    const represent = opts.represent?.includes(i);
    if (!represent) {
      out.push(base({ id: away ? `ha:${u}:${ROOM}` : `h:${u}`, kind: 'human', name: u, roomId: ROOM, ownerId: u, seatUserId: u, away: !!away }));
    }
    out.push(
      base({ id: `ag_${u}`, kind: 'agent', name: `${u} Agent`, roomId: ROOM, ownerId: u, seatUserId: u, representing: !!represent, mode: represent ? 'representing' : 'accompanied' }),
    );
  });
  if (opts.roomAgent !== false) out.push(base({ id: 'ra', kind: 'room_agent', name: 'Room Agent', roomId: ROOM }));
  for (let g = 0; g < (opts.guests ?? 0); g++) {
    out.push(base({ id: `guest${g}`, kind: 'agent', name: `guest${g}`, roomId: ROOM, ownerId: `x${g}`, seatUserId: `x${g}`, visiting: true, mode: 'visiting' }));
  }
  return out;
}

const dimsOur = capsuleDims('plump');
const VARIANTS = ['meeting', 'home'] as const;

function plan(chars: CharacterInput[], variant: (typeof VARIANTS)[number], n: number): RoomPlan {
  const spec = interiorSpec('cafe', variant, dimsOur);
  return planRoom(chars, { kind: 'our', ownerId: null, memberIds: uids(n) }, spec, dimsOur);
}

const d = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

describe.each(VARIANTS)('Our Room 배치 (%s)', (variant) => {
  // HUMAN_CAP = 6까지, Room Agent·손님 Agent 포함
  describe.each([1, 2, 3, 4, 5, 6])('사람 %i명', (n) => {
    const cases: [string, CharacterInput[]][] = [
      ['평상시', team(n)],
      ['손님 Agent 포함', team(n, { guests: 2 })],
      ['한 명 자리 비움', team(n, { away: [0] })],
      ['한 명 대리 참여', team(n, { represent: [n - 1] })],
    ];
    it.each(cases)('캐릭터끼리 몸이 겹치지 않는다: %s', (_name, chars) => {
      const p = plan(chars, variant, n);
      const homes = chars.map((c) => ({ id: c.id, ...p.home.get(c.id)! }));
      const sils = p.emptySeats.map((e) => ({ id: `sil:${e.userId}`, ...e.spot }));
      const all = [...homes, ...sils];
      let min = Infinity;
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) min = Math.min(min, d(all[i]!, all[j]!));
      expect(min).toBeGreaterThanOrEqual(0.7);
    });

    it('모든 자리가 바닥 안쪽이다', () => {
      const chars = team(n, { guests: 2 });
      const p = plan(chars, variant, n);
      const half = dimsOur.length / 2;
      const rr = dimsOur.floorHalfDepth;
      for (const c of chars) {
        const s = p.home.get(c.id)!;
        const ex = Math.max(Math.abs(s.x) - half, 0);
        expect(Math.hypot(ex, s.z), c.id).toBeLessThanOrEqual(rr - 0.4);
      }
    });

    it('Personal Agent는 소유자 바로 옆이고, 짝 사이가 다른 쌍과의 거리보다 가깝다', () => {
      const chars = team(n);
      const p = plan(chars, variant, n);
      for (const u of uids(n)) {
        const h = p.home.get(`h:${u}`)!;
        const a = p.home.get(`ag_${u}`)!;
        const pairD = d(h, a);
        expect(pairD).toBeLessThanOrEqual(PAIR + 1e-6);
        // 소유자에게 가장 가까운 캐릭터는 자기 Agent
        let nearest = '';
        let nd = Infinity;
        for (const c of chars) {
          if (c.id === `h:${u}`) continue;
          const dd = d(h, p.home.get(c.id)!);
          if (dd < nd) (nd = dd), (nearest = c.id);
        }
        expect(nearest).toBe(`ag_${u}`);
        // 다른 쌍의 구성원은 짝보다 확실히 멀다
        for (const c of chars) {
          if (c.id === `h:${u}` || c.id === `ag_${u}` || c.id === 'ra') continue;
          expect(d(h, p.home.get(c.id)!)).toBeGreaterThan(pairD + 0.3);
        }
      }
    });
  });

  it('Room Agent는 줄 가운데 쪽에 선다', () => {
    const chars = team(3);
    const p = plan(chars, variant, 3);
    const ra = p.home.get('ra')!;
    expect(Math.abs(ra.x)).toBeLessThan(2.2);
  });

  it('자리 비움 사람의 Agent는 그 자리 바로 옆에 선다(대리 참여 포함)', () => {
    const chars = team(3, { represent: [1] });
    const p = plan(chars, variant, 3);
    const sil = p.emptySeats.find((e) => e.userId === 'u1')!;
    expect(sil).toBeDefined();
    expect(d(sil.spot, p.home.get('ag_u1')!)).toBeLessThanOrEqual(PAIR + 1e-6);
  });

  it('쌍 사이 간격은 쌍 안보다 넓다', () => {
    const chars = team(4);
    const p = plan(chars, variant, 4);
    const a = p.home.get('ag_u0')!;
    const h1 = p.home.get('h:u1')!;
    expect(d(a, h1)).toBeGreaterThan(PAIR);
    expect(UNIT_GAP).toBeGreaterThan(PAIR);
  });
});

describe('arcLayout', () => {
  it('유닛이 없으면 빈 배열', () => {
    expect(arcLayout([], { cx: 0, cz: 0, hw: 1, hd: 0.5 }, { half: 2, rr: 3 })).toEqual([]);
  });
  it('모든 점이 이웃과 겹치지 않는다(쌍 6 + Room Agent + 손님 2)', () => {
    const units = [
      { n: 1 as const },
      ...Array.from({ length: 3 }, () => ({ n: 2 as const })),
      { n: 1 as const, ra: true },
      ...Array.from({ length: 3 }, () => ({ n: 2 as const })),
      { n: 1 as const },
    ];
    const pts = arcLayout(units, { cx: 0, cz: 0.1, hw: 1.5, hd: 0.35 }, { half: dimsOur.length / 2, rr: dimsOur.floorHalfDepth }).flat();
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) expect(d(pts[i]!, pts[j]!)).toBeGreaterThanOrEqual(0.7);
  });
});

describe('줄어든 탁자와 보드 도구 소품', () => {
  it.each(VARIANTS)('%s: 도구 자리 4개가 줄어든 상판 위에 있다', (variant) => {
    const spec = interiorSpec('cafe', variant, dimsOur);
    expect(spec.table).toBeDefined();
    const t = spec.table!;
    expect(spec.toolSlots).toHaveLength(4);
    const top = variant === 'meeting' ? TOP.tableCross : TOP.tableHome;
    for (const [x, y, z] of spec.toolSlots) {
      expect(y).toBeCloseTo(top, 5);
      expect(Math.abs(x - t.cx)).toBeLessThanOrEqual(t.hw - 0.1);
      expect(Math.abs(z - t.cz)).toBeLessThanOrEqual(t.hd);
    }
  });

  it('탁자는 이전 치수(길이 4.3 / 깊이 0.98, 가족 1.84 x 1.05)의 70~75%', () => {
    const m = interiorSpec('cafe', 'meeting', dimsOur).table!;
    expect((2 * m.hw) / 4.29).toBeGreaterThan(0.7);
    expect((2 * m.hw) / 4.29).toBeLessThan(0.75);
    expect((2 * m.hd) / 0.98).toBeGreaterThan(0.7);
    expect((2 * m.hd) / 0.98).toBeLessThan(0.75);
    const h = interiorSpec('cafe', 'home', dimsOur).table!;
    expect((2 * h.hw) / 1.84).toBeGreaterThan(0.7);
    expect((2 * h.hw) / 1.84).toBeLessThan(0.75);
  });

  it('도구 자리가 탁자 소품(abs)과 같은 좌표계다: 가운데 탁자 소품의 위치가 확대되지 않았다', () => {
    const spec = interiorSpec('cafe', 'meeting', dimsOur);
    const tables = spec.props.filter((p) => p.id === 'table-cross');
    expect(tables).toHaveLength(3);
    for (const t of tables) expect(Math.abs(t.z - spec.table!.cz)).toBeLessThan(1e-9);
  });
});
