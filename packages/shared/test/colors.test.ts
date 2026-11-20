import { describe, expect, it } from 'vitest';
import {
  PALETTE,
  USER_COLORS,
  USER_COLOR_CHOICES,
  capsuleSpec,
  hexToOklch,
  isReservedColor,
  mixOklch,
  normalizeHex,
  oklchToHex,
  ourColor,
  ringGradientStops,
  themeSeats,
  THEMES,
} from '../src';

describe('colors', () => {
  it('hex ↔ oklch 왕복 오차가 작다', () => {
    for (const hex of [...Object.values(PALETTE), ...USER_COLOR_CHOICES, '#000000', '#ffffff', '#808080']) {
      const back = oklchToHex(hexToOklch(hex));
      const d = [1, 3, 5].map((i) => Math.abs(parseInt(hex.slice(i, i + 2), 16) - parseInt(back.slice(i, i + 2), 16)));
      expect(Math.max(...d)).toBeLessThanOrEqual(1);
    }
  });

  it('흰색은 L=1, 검정은 L=0, 무채색은 채도 0', () => {
    expect(hexToOklch('#ffffff').l).toBeCloseTo(1, 2);
    expect(hexToOklch('#000000').l).toBeCloseTo(0, 2);
    expect(hexToOklch('#808080').c).toBeLessThan(0.001);
  });

  it('3자리와 대문자 hex를 정규화한다', () => {
    expect(normalizeHex('#FA0')).toBe('#ffaa00');
    expect(normalizeHex('3BAF96')).toBe('#3baf96');
    expect(() => normalizeHex('zzz')).toThrow();
  });

  it('단일 색 혼합은 그 색을 돌려준다', () => {
    expect(mixOklch([USER_COLORS.coral])).toBe(USER_COLORS.coral);
  });

  it('우리 색 = 혼합: 순서 무관, 두 색 사이의 명도, 가중치 반영', () => {
    const ab = ourColor([USER_COLORS.coral, USER_COLORS.sky]);
    const ba = ourColor([USER_COLORS.sky, USER_COLORS.coral]);
    expect(ab).toBe(ba);
    expect(ab).not.toBe(USER_COLORS.coral);
    expect(ab).not.toBe(USER_COLORS.sky);

    const l = [USER_COLORS.coral, USER_COLORS.sky].map((c) => hexToOklch(c).l);
    const lm = hexToOklch(ab).l;
    expect(lm).toBeGreaterThanOrEqual(Math.min(...l) - 0.01);
    expect(lm).toBeLessThanOrEqual(Math.max(...l) + 0.01);

    // 가중치를 한쪽으로 몰면 그 색에 가까워진다
    const nearCoral = mixOklch([USER_COLORS.coral, USER_COLORS.sky], [9, 1]);
    const dist = (x: string, y: string) => {
      const a = hexToOklch(x);
      const b = hexToOklch(y);
      return Math.hypot(a.l - b.l, a.c * Math.cos((a.h * Math.PI) / 180) - b.c * Math.cos((b.h * Math.PI) / 180), a.c * Math.sin((a.h * Math.PI) / 180) - b.c * Math.sin((b.h * Math.PI) / 180));
    };
    expect(dist(nearCoral, USER_COLORS.coral)).toBeLessThan(dist(nearCoral, USER_COLORS.sky));
  });

  it('빈 목록은 에러', () => {
    expect(() => mixOklch([])).toThrow();
  });

  it('민트와 오렌지는 예약 색이고 사용자 색에는 없다', () => {
    expect(isReservedColor(PALETTE.agentMint)).toBe(true);
    expect(isReservedColor('#FFB45A')).toBe(true);
    for (const c of USER_COLOR_CHOICES) expect(isReservedColor(c)).toBe(false);
  });

  it('링 그라데이션은 한 바퀴 돌아 처음 색으로 닫힌다', () => {
    expect(ringGradientStops([USER_COLORS.coral, USER_COLORS.sky])).toEqual([USER_COLORS.coral, USER_COLORS.sky, USER_COLORS.coral]);
    expect(ringGradientStops([USER_COLORS.coral])).toEqual([USER_COLORS.coral]);
  });
});

describe('themes', () => {
  it('좌석 수와 variant', () => {
    expect(themeSeats('studio')).toBe(THEMES.studio.seats);
    expect(themeSeats('cafe')).toBe(6);
    expect(themeSeats('cafe', 'meeting')).toBe(8);
    expect(themeSeats('studio', 'home')).toBe(THEMES.studio.seats); // variant는 cafe에만 의미가 있다
  });

  it('캡슐 외형: Our는 1.6배 통통, My/Your는 길쭉', () => {
    expect(capsuleSpec('our')).toEqual({ proportion: 'plump', scale: 1.6 });
    expect(capsuleSpec('my')).toEqual({ proportion: 'long', scale: 1 });
  });
});
