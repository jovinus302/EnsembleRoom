/**
 * 팔레트와 oklch 혼합 (계획 8.3).
 * 민트는 Room Agent·시스템 전용, 오렌지는 승인 전용 예약 색이다. 사용자 색으로 쓰지 않는다.
 */

export const PALETTE = {
  /** Agent·시스템 (컨셉 문서) */
  agentMint: '#3baf96',
  agentMintLight: '#64e4bd',
  /** Room Agent(유령형 패밀리) 고정색 라임 */
  roomAgentLime: '#b8e86a',
  /** Skill (1차 범위 밖, 예약) */
  skillPurple: '#8f7dbd',
  /** 승인 전용 */
  approvalOrange: '#ffb45a',
} as const;

export const RESERVED_COLORS: readonly string[] = [
  PALETTE.agentMint,
  PALETTE.agentMintLight,
  PALETTE.roomAgentLime,
  PALETTE.skillPurple,
  PALETTE.approvalOrange,
];

/** 사용자 고유 색 (시드: Alice 코랄, Bob 스카이, 엄마 핑크, Dana 옐로, 아빠 그린) */
export const USER_COLORS = {
  coral: '#ff7f6e',
  sky: '#5db8f0',
  pink: '#e58fb5',
  yellow: '#f2d04e',
  green: '#5fc46e',
} as const;

export const USER_COLOR_CHOICES: readonly string[] = Object.values(USER_COLORS);

export function isReservedColor(hex: string): boolean {
  const h = normalizeHex(hex);
  return RESERVED_COLORS.some((c) => c === h);
}

/* ---------------------------- 변환 ---------------------------- */

export interface Rgb {
  r: number; // 0..1 (sRGB)
  g: number;
  b: number;
}
export interface Oklch {
  l: number; // 0..1
  c: number; // 0..~0.4
  h: number; // degrees 0..360
}

export function normalizeHex(hex: string): string {
  let h = hex.trim().toLowerCase();
  if (!h.startsWith('#')) h = `#${h}`;
  if (/^#[0-9a-f]{3}$/.test(h)) h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  if (!/^#[0-9a-f]{6}$/.test(h)) throw new Error(`invalid hex color: ${hex}`);
  return h;
}

export function hexToRgb(hex: string): Rgb {
  const h = normalizeHex(hex);
  return {
    r: parseInt(h.slice(1, 3), 16) / 255,
    g: parseInt(h.slice(3, 5), 16) / 255,
    b: parseInt(h.slice(5, 7), 16) / 255,
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const to = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);

interface Oklab {
  l: number;
  a: number;
  b: number;
}

function rgbToOklab(rgb: Rgb): Oklab {
  const r = toLinear(rgb.r);
  const g = toLinear(rgb.g);
  const b = toLinear(rgb.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToRgb({ l, a, b }: Oklab): Rgb {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return {
    r: toSrgb(clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_)),
    g: toSrgb(clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_)),
    b: toSrgb(clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_)),
  };
}

export function hexToOklch(hex: string): Oklch {
  const { l, a, b } = rgbToOklab(hexToRgb(hex));
  const c = Math.hypot(a, b);
  const h = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return { l, c, h: c < 1e-6 ? 0 : h };
}

export function oklchToHex({ l, c, h }: Oklch): string {
  const rad = (h * Math.PI) / 180;
  return rgbToHex(oklabToRgb({ l, a: c * Math.cos(rad), b: c * Math.sin(rad) }));
}

/**
 * 구성원 색을 oklch로 혼합한다. L과 C는 가중 평균, 색상(h)은 C로 가중한 원형 평균(벡터 합)이라
 * 반대 색상끼리도 탁해지지 않고 단일 색으로 수렴한다. 순서와 무관하고 단일 색이면 그 색을 돌려준다.
 */
export function mixOklch(colors: readonly string[], weights?: readonly number[]): string {
  if (colors.length === 0) throw new Error('mixOklch: no colors');
  const ws = colors.map((_, i) => weights?.[i] ?? 1);
  const total = ws.reduce((s, w) => s + w, 0);
  let l = 0;
  let a = 0;
  let b = 0;
  colors.forEach((hex, i) => {
    const o = hexToOklch(hex);
    const w = ws[i]! / total;
    const rad = (o.h * Math.PI) / 180;
    l += o.l * w;
    a += o.c * Math.cos(rad) * w;
    b += o.c * Math.sin(rad) * w;
  });
  const c = Math.hypot(a, b);
  const h = c < 1e-6 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return oklchToHex({ l, c, h });
}

/** 우리 색 = 구성원 색의 혼합 */
export function ourColor(memberColors: readonly string[]): string {
  return mixOklch(memberColors);
}

/** 유리 테두리 그라데이션 링용: 구성원 색을 순서대로 돌려준다(CSS conic/linear gradient 입력) */
export function ringGradientStops(memberColors: readonly string[]): string[] {
  const stops = memberColors.map(normalizeHex);
  return stops.length > 1 ? [...stops, stops[0]!] : stops;
}
