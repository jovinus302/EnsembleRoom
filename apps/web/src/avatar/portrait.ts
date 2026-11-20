/**
 * 사람 프로필 초상(가상의 플랫 일러스트). 외부 이미지 없이 이름을 시드로 SVG를 결정적으로 만든다.
 * 2D(Avatar.tsx)와 3D(Actor.tsx 얼굴 텍스처)가 같은 소스를 쓴다. 실존 인물과 무관한 가상 캐릭터다.
 */

export type HairStyle = 'short' | 'side' | 'long' | 'bob' | 'bun' | 'curly' | 'buzz';
export type Neckline = 'crew' | 'v' | 'collar';
export type Mouth = 'smile' | 'grin' | 'soft';
export type Accessory = 'none' | 'round' | 'square' | 'freckles' | 'earrings' | 'mustache';

export interface PortraitSpec {
  skin: string;
  hair: string;
  hairStyle: HairStyle;
  cloth: string;
  neckline: Neckline;
  mouth: Mouth;
  accessory: Accessory;
  /** 눈 크기(1 보통, 1.25 크게) */
  eye: number;
  brow: number;
  /** 중년 표현: 입가 주름 + 목걸이 */
  mature?: boolean;
  blush: boolean;
}

const SKINS = ['#f6d5b8', '#efc29b', '#e0a982', '#c98b62', '#a66b45', '#7d4c33'];
const HAIRS = ['#1f1a1a', '#3a2a22', '#5b3a29', '#8a5a33', '#c9a45c', '#7a2e24', '#2c3447'];
const CLOTHS = ['#2f4b7c', '#2f6f5e', '#7a3e65', '#c2553f', '#e0b04a', '#4a4e69', '#3b7ea1', '#5d7a3a', '#6b4f9a', '#222836'];
const STYLES: HairStyle[] = ['short', 'side', 'long', 'bob', 'bun', 'curly', 'buzz'];
const NECKS: Neckline[] = ['crew', 'v', 'collar'];
const MOUTHS: Mouth[] = ['smile', 'grin', 'soft'];
const ACCS: Accessory[] = ['none', 'none', 'round', 'square', 'freckles', 'earrings'];

/** 시드 인물 4명: 서로 확실히 구분되는 수동 프리셋 (키: 소문자 이름/id 꼬리) */
const PRESETS: Record<string, PortraitSpec> = {
  alice: { skin: '#f6d5b8', hair: '#5b3a29', hairStyle: 'long', cloth: '#2f4b7c', neckline: 'crew', mouth: 'smile', accessory: 'earrings', eye: 1.15, brow: 1, blush: true },
  bob: { skin: '#e0a982', hair: '#1f1a1a', hairStyle: 'short', cloth: '#2f6f5e', neckline: 'collar', mouth: 'smile', accessory: 'round', eye: 1, brow: 1.4, blush: false },
  dana: { skin: '#8d5a3b', hair: '#2a1b16', hairStyle: 'curly', cloth: '#e0b04a', neckline: 'crew', mouth: 'grin', accessory: 'none', eye: 1.2, brow: 1, blush: false },
  mom: { skin: '#f3d3b8', hair: '#7a3e2c', hairStyle: 'bun', cloth: '#a65d7a', neckline: 'v', mouth: 'soft', accessory: 'square', eye: 1, brow: 0.9, mature: true, blush: true },
};
PRESETS['엄마'] = PRESETS.mom!;
PRESETS.dad = { skin: '#e3b48c', hair: '#8a8d96', hairStyle: 'buzz', cloth: '#3b7ea1', neckline: 'collar', mouth: 'soft', accessory: 'mustache', eye: 0.95, brow: 1.3, mature: true, blush: false };
PRESETS['아빠'] = PRESETS.dad;

function presetKey(name: string): string {
  return name.trim().toLowerCase().replace(/^(h:|u_)+/, '');
}

function fnv(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick<T>(arr: readonly T[], r: () => number): T {
  return arr[Math.floor(r() * arr.length) % arr.length] as T;
}

const specCache = new Map<string, PortraitSpec>();
/** 이름(또는 id)으로 결정적 초상 스펙 */
export function portraitSpec(name: string): PortraitSpec {
  const key = presetKey(name);
  const hit = specCache.get(key);
  if (hit) return hit;
  let spec = PRESETS[key];
  if (!spec) {
    const r = rng(fnv(key || '?'));
    spec = {
      skin: pick(SKINS, r),
      hair: pick(HAIRS, r),
      hairStyle: pick(STYLES, r),
      cloth: pick(CLOTHS, r),
      neckline: pick(NECKS, r),
      mouth: pick(MOUTHS, r),
      accessory: pick(ACCS, r),
      eye: r() < 0.5 ? 1 : 1.2,
      brow: 0.8 + r() * 0.7,
      blush: r() < 0.4,
    };
  }
  specCache.set(key, spec);
  return spec;
}

// ------------------------------------------------------------------ 색 유틸

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** a를 b쪽으로 t만큼 섞는다 */
export function mix(a: string, b: string, t: number): string {
  const x = hex(a);
  const y = hex(b);
  const o = x.map((v, i) => Math.round(v + (y[i]! - v) * t));
  return `#${o.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// ------------------------------------------------------------------ SVG

/** 머리 뒤쪽(긴 머리·단발) */
function hairBack(style: HairStyle, c: string): string {
  if (style === 'long') return `<path d="M27 46 C24 18 76 18 73 46 L78 86 L22 86Z" fill="${c}"/>`;
  if (style === 'bob') return `<path d="M26 46 C23 17 77 17 74 46 L74 70 C60 77 40 77 26 70Z" fill="${c}"/>`;
  if (style === 'bun') return `<circle cx="50" cy="14" r="8.5" fill="${c}"/>`;
  return '';
}

/** 머리 앞쪽(정수리·앞머리) */
function hairFront(style: HairStyle, c: string, skin: string): string {
  const outer = 'M30 50 C27 24 40 16 50 16 C60 16 73 24 70 50';
  switch (style) {
    case 'side':
      return `<path d="${outer} C68 40 58 31 45 35 C38 38 33 44 30 50Z" fill="${c}"/>`;
    case 'curly': {
      const dots: [number, number, number][] = [[32, 38, 8], [30, 49, 7], [38, 27, 9], [50, 22, 9.5], [62, 27, 9], [68, 38, 8], [70, 49, 7], [42, 32, 6], [58, 32, 6], [50, 31, 6]];
      return dots.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}"/>`).join('');
    }
    case 'buzz':
      return `<path d="${outer} C67 41 60 36 50 36 C40 36 33 41 30 50Z" fill="${mix(c, skin, 0.35)}"/>`;
    case 'bob':
      return `<path d="${outer} C68 40 58 31 45 35 C38 38 33 44 30 50Z" fill="${c}"/>`;
    default:
      return `<path d="${outer} C67 40 60 33 50 33 C40 33 33 40 30 50Z" fill="${c}"/>`;
  }
}

/** 초상 SVG 문자열. 배경은 정사각형으로 채우므로 컨테이너(원형)가 잘라낸다 */
export function portraitSvg(spec: PortraitSpec, bgColor: string, px = 128): string {
  const s = spec;
  const bg = mix(bgColor, '#ffffff', 0.38);
  const bg2 = mix(bgColor, '#ffffff', 0.18);
  const shade = mix(s.skin, '#6b3a22', 0.22);
  const ink = '#2b2118';
  const e = s.eye;
  const parts: string[] = [];
  parts.push(`<rect width="100" height="100" fill="${bg}"/>`);
  parts.push(`<circle cx="50" cy="52" r="40" fill="${bg2}"/>`);
  parts.push(hairBack(s.hairStyle, s.hair));
  // 목 + 어깨
  parts.push(`<rect x="43" y="60" width="14" height="22" rx="5" fill="${shade}"/>`);
  parts.push(`<path d="M6 100 C6 80 26 74 50 74 C74 74 94 80 94 100Z" fill="${s.cloth}"/>`);
  if (s.neckline === 'crew') parts.push(`<path d="M41 74.5 Q50 86 59 74.5Z" fill="${shade}"/>`);
  else if (s.neckline === 'v') parts.push(`<path d="M41 74.5 L50 92 L59 74.5Z" fill="${shade}"/>`);
  else {
    parts.push(`<path d="M43 74.5 L50 88 L57 74.5Z" fill="${shade}"/>`);
    parts.push(`<path d="M40 73 L50 90 L34 83Z" fill="#f4f6fb"/><path d="M60 73 L50 90 L66 83Z" fill="#f4f6fb"/>`);
  }
  if (s.mature && s.accessory !== 'mustache') {
    // 진주 목걸이
    for (let i = 0; i < 7; i++) {
      const a = Math.PI * (0.18 + (i / 6) * 0.64);
      parts.push(`<circle cx="${(50 + Math.cos(a) * 11).toFixed(1)}" cy="${(70 + Math.sin(a) * 9).toFixed(1)}" r="1.5" fill="#fbf7ef"/>`);
    }
  }
  // 귀 + 얼굴
  parts.push(`<ellipse cx="31.5" cy="49" rx="3.4" ry="4.6" fill="${s.skin}"/><ellipse cx="68.5" cy="49" rx="3.4" ry="4.6" fill="${s.skin}"/>`);
  parts.push(`<ellipse cx="50" cy="47" rx="19" ry="22" fill="${s.skin}"/>`);
  if (s.accessory === 'earrings') parts.push(`<circle cx="31" cy="55" r="1.9" fill="#f2c94c"/><circle cx="69" cy="55" r="1.9" fill="#f2c94c"/>`);
  parts.push(hairFront(s.hairStyle, s.hair, s.skin));
  // 눈썹·눈
  const bw = 1.3 * s.brow;
  parts.push(`<path d="M37 42 Q42 39.5 47 41.5 M53 41.5 Q58 39.5 63 42" stroke="${s.hairStyle === 'buzz' ? mix(s.hair, '#000000', 0.1) : s.hair}" stroke-width="${bw.toFixed(2)}" stroke-linecap="round" fill="none"/>`);
  parts.push(`<ellipse cx="42.5" cy="48.5" rx="${(2.1 * e).toFixed(2)}" ry="${(2.5 * e).toFixed(2)}" fill="${ink}"/><ellipse cx="57.5" cy="48.5" rx="${(2.1 * e).toFixed(2)}" ry="${(2.5 * e).toFixed(2)}" fill="${ink}"/>`);
  parts.push(`<circle cx="43.3" cy="47.5" r="0.8" fill="#fff"/><circle cx="58.3" cy="47.5" r="0.8" fill="#fff"/>`);
  // 코 + 입
  parts.push(`<path d="M50 50.5 Q47.6 56 50.5 56.6" stroke="${shade}" stroke-width="1.2" stroke-linecap="round" fill="none"/>`);
  if (s.mouth === 'grin') parts.push(`<path d="M42.5 59 Q50 67 57.5 59Z" fill="#a8453a"/><path d="M44.2 59.6 Q50 61.8 55.8 59.6 L55.2 61 Q50 62.8 44.8 61Z" fill="#fff"/>`);
  else if (s.mouth === 'smile') parts.push(`<path d="M43.5 60 Q50 66 56.5 60" stroke="#a8453a" stroke-width="1.8" stroke-linecap="round" fill="none"/>`);
  else parts.push(`<path d="M44.5 61 Q50 64.2 55.5 61" stroke="#a8453a" stroke-width="1.8" stroke-linecap="round" fill="none"/>`);
  if (s.blush) parts.push(`<ellipse cx="37.5" cy="56" rx="3.6" ry="2.2" fill="#e8806f" opacity="0.28"/><ellipse cx="62.5" cy="56" rx="3.6" ry="2.2" fill="#e8806f" opacity="0.28"/>`);
  if (s.mature) parts.push(`<path d="M41 58 Q39.6 61 41 64 M59 58 Q60.4 61 59 64" stroke="${shade}" stroke-width="0.9" stroke-linecap="round" fill="none"/>`);
  if (s.accessory === 'freckles') {
    const f: [number, number][] = [[39, 54], [42, 55.5], [37, 56], [61, 54], [58, 55.5], [63, 56]];
    parts.push(f.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="0.7" fill="${shade}"/>`).join(''));
  }
  if (s.accessory === 'mustache') parts.push(`<path d="M40.5 58.4 Q45 55.6 50 58 Q55 55.6 59.5 58.4 Q55 61 50 59 Q45 61 40.5 58.4Z" fill="${mix(s.hair, '#000000', 0.35)}"/>`);
  // 안경
  if (s.accessory === 'round') {
    parts.push(`<g fill="none" stroke="#1d2433" stroke-width="1.6"><circle cx="42.5" cy="48.5" r="6.4"/><circle cx="57.5" cy="48.5" r="6.4"/><path d="M48.9 48 Q50 46.8 51.1 48"/></g>`);
  } else if (s.accessory === 'square') {
    parts.push(`<g fill="none" stroke="#7a3e55" stroke-width="1.6" stroke-linejoin="round"><rect x="35.5" y="43.5" width="14" height="10.5" rx="3"/><rect x="50.5" y="43.5" width="14" height="10.5" rx="3"/><path d="M49.5 47.5 H50.5"/></g>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${px}" height="${px}">${parts.join('')}</svg>`;
}

const urlCache = new Map<string, string>();
/** 사용자별 data URL(캐시). <img src> 또는 Image 로딩에 쓴다 */
export function portraitDataUrl(name: string, bgColor: string, px = 256): string {
  const key = `${presetKey(name)}|${bgColor}|${px}`;
  let u = urlCache.get(key);
  if (!u) {
    u = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(portraitSvg(portraitSpec(name), bgColor, px))}`;
    urlCache.set(key, u);
  }
  return u;
}
