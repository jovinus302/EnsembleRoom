import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { hexToRgb, rgbToHex } from '@ensemble/shared';

/** 캔버스 라벨 글꼴: 앱에 self-host된 DM Sans / Pretendard Variable / JetBrains Mono */
const FONT = '"DM Sans","Pretendard Variable",Pretendard,"Malgun Gothic",sans-serif';
const MONO = '"JetBrains Mono","Pretendard Variable",monospace';

/** 2D 말풍선과 같은 팔레트(themes.css --bubble-base / --fg) */
const BASE = '#0e2838';
const FG = '#d9f3f7';
const AMBER = '#ffb45a';
const PAUSED = '#8dbed2';
const ERR = '#ff5964';

/** sRGB 공간 혼합: CSS `color-mix(in srgb, a t%, b)`와 같은 결과 (THREE.Color.lerp는 linear라 쓰지 않는다) */
export function mixSrgb(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex({ r: x.r * t + y.r * (1 - t), g: x.g * t + y.g * (1 - t), b: x.b * t + y.b * (1 - t) });
}

/** 폰트 로드 대기. 로드가 끝나면 fontsVersion이 올라가 텍스처를 다시 그린다(폴백 글꼴로 굳는 것 방지) */
let fontsVersion = 0;
const fontListeners = new Set<() => void>();
if (typeof document !== 'undefined' && document.fonts) {
  Promise.all([
    document.fonts.load('600 30px "Pretendard Variable"'),
    document.fonts.load('500 30px "Pretendard Variable"'),
    document.fonts.load('600 30px "DM Sans"'),
    document.fonts.load('500 30px "DM Sans"'),
    document.fonts.load('600 22px "JetBrains Mono"'),
  ])
    .catch(() => undefined)
    .then(() => document.fonts.ready)
    .then(() => {
      fontsVersion++;
      fontListeners.forEach((f) => f());
    });
}
function useFontsVersion(): number {
  const [v, setV] = useState(fontsVersion);
  useEffect(() => {
    const f = () => setV(fontsVersion);
    fontListeners.add(f);
    f();
    return () => {
      fontListeners.delete(f);
    };
  }, []);
  return v;
}

function wrapLines(g: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const ch of [...text]) {
    const t = cur + ch;
    if (g.measureText(t).width > maxW && cur) {
      lines.push(cur);
      cur = ch === ' ' ? '' : ch;
      if (lines.length === maxLines) break;
    } else cur = t;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  return lines.slice(0, maxLines);
}

function setSpacing(g: CanvasRenderingContext2D, px: number) {
  if ('letterSpacing' in g) (g as unknown as { letterSpacing: string }).letterSpacing = `${px}px`;
}

export type BubbleKind = 'thinking' | 'recalling' | 'writing' | 'said' | 'ask' | 'paused' | 'error';

export interface BubbleSpec {
  kind: BubbleKind;
  text: string;
  /** 발화자 색(승인·일시정지·오류는 종류별 고정색이 우선) */
  color: string;
  /** 태그 줄. 예: "✦ ALICE의 AGENT · WRITING". 없으면 종류 라벨만(`said`는 생략) */
  tag?: string;
  /** 전송 실패: 점선 테두리 */
  fail?: boolean;
}

/** 캔버스 2배 해상도. 디자인 px 1 = U 캔버스 px (화면 크기는 기존 말풍선과 비슷하게 유지) */
const CW = 768;
const CH = 384;
const U = 3.6;
const PAD_L = 12;
const PAD_B = 44;

const KIND_LABEL: Record<BubbleKind, string> = { thinking: 'THINKING', recalling: 'RECALLING', writing: 'WRITING', said: '', ask: '승인 필요', paused: 'PAUSED', error: 'ERROR' };

function accentOf(spec: BubbleSpec): string {
  return spec.kind === 'ask' ? AMBER : spec.kind === 'paused' ? PAUSED : spec.kind === 'error' ? ERR : spec.color;
}

function drawBubble(g: CanvasRenderingContext2D, spec: BubbleSpec, t: number) {
  g.clearRect(0, 0, CW, CH);
  const c = accentOf(spec);
  const dots = spec.kind === 'thinking' || spec.kind === 'recalling' || (spec.kind === 'writing' && !spec.text);
  const tagText = (spec.tag ?? KIND_LABEL[spec.kind]).toUpperCase();
  const padX = 14 * U;
  const padY = 10 * U;
  const bar = spec.kind === 'said' && !spec.tag ? 0 : 3 * U;
  const bodyPx = 15 * U;
  const tagPx = 11 * U;
  const maxInner = CW - PAD_L - 40 - padX * 2 - bar;
  g.textAlign = 'left';
  g.font = `500 ${bodyPx}px ${FONT}`;
  const lines = dots ? [] : wrapLines(g, spec.text || (spec.kind === 'ask' ? '승인이 필요해요' : spec.kind === 'paused' ? '일시정지' : '…'), maxInner - (spec.kind === 'writing' ? 14 * U : 0), 2);
  const textW = lines.reduce((m, l) => Math.max(m, g.measureText(l).width), 0);
  g.font = `600 ${tagPx}px ${MONO}`;
  const lsp = 0.08 * tagPx;
  setSpacing(g, lsp);
  const tagW = tagText ? g.measureText(tagText).width : 0;
  setSpacing(g, 0);
  const tagH = tagText ? tagPx * 1.4 + 2 : 0;
  const dotsW = 3 * 6 * U + 2 * 5 * U;
  const innerW = Math.min(maxInner, Math.max(dots ? dotsW : textW + (spec.kind === 'writing' ? 12 * U : 0), tagW, 40 * U));
  const w = innerW + padX * 2 + bar;
  const lineH = bodyPx * 1.5;
  const h = padY * 2 + tagH + (dots ? 6 * U + 8 : lines.length * lineH);
  const x = PAD_L;
  const y = CH - PAD_B - h;
  const R = 16 * U;
  const Rt = 4 * U;
  const path = (inset: number) => {
    g.beginPath();
    g.roundRect(x + inset, y + inset, w - inset * 2, h - inset * 2, [R, R, R, Rt]);
  };
  // 그림자(.in3d) + 불투명 tonal 바탕
  g.save();
  g.shadowColor = 'rgba(40,20,0,0.28)';
  g.shadowBlur = 8 * U;
  g.shadowOffsetY = 3 * U;
  g.fillStyle = mixSrgb(c, BASE, 0.2);
  path(0);
  g.fill();
  g.restore();
  // 왼쪽 띠(agent 계열)
  if (bar) {
    g.save();
    path(0);
    g.clip();
    g.fillStyle = c;
    g.fillRect(x, y, bar, h);
    g.restore();
  }
  g.lineWidth = 2;
  g.strokeStyle = spec.fail ? ERR : mixSrgb(c, BASE, 0.38);
  if (spec.fail) g.setLineDash([12, 8]);
  path(1);
  g.stroke();
  g.setLineDash([]);

  const tx = x + bar + padX;
  let cy = y + padY;
  g.textBaseline = 'middle';
  if (tagText) {
    g.font = `600 ${tagPx}px ${MONO}`;
    g.fillStyle = mixSrgb(c, FG, 0.8);
    setSpacing(g, lsp);
    g.fillText(tagText, tx, cy + tagH / 2 - 1);
    setSpacing(g, 0);
    cy += tagH;
  }
  if (dots) {
    for (let i = 0; i < 3; i++) {
      const ph = Math.sin(t * ((Math.PI * 2) / 1.2) - i * 0.9);
      g.fillStyle = c;
      g.globalAlpha = 0.45 + 0.55 * Math.max(0, ph);
      g.beginPath();
      g.arc(tx + 3 * U + i * 11 * U, cy + 3 * U + 4 - Math.max(0, ph) * 3 * U, 3 * U, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  } else {
    g.font = `500 ${bodyPx}px ${FONT}`;
    g.fillStyle = FG;
    lines.forEach((l, i) => g.fillText(l, tx, cy + lineH * (i + 0.5)));
    if (spec.kind === 'writing' && t % 1 < 0.5) {
      const last = lines.length - 1;
      const lw = g.measureText(lines[last] ?? '').width;
      g.fillStyle = c;
      g.beginPath();
      g.roundRect(tx + lw + 5, cy + lineH * last + (lineH - 15 * U) / 2, 7 * U, 15 * U, 4);
      g.fill();
    }
  }
}

/**
 * 3D 말풍선(캔버스 텍스처 스프라이트). 2D 채팅 말풍선(.tg-bubble)과 같은 규칙: 불투명 tonal 바탕, 아래-왼쪽만 4px 모서리, 꼬리 없음.
 * 아래-왼쪽 모서리가 캐릭터 머리 위(스프라이트 원점)에 온다. depthTest를 꺼 항상 위에 보인다.
 */
export function Bubble({ spec, width = 2.5, position }: { spec: BubbleSpec; width?: number; position: [number, number, number] }) {
  const canvas = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = CW;
    c.height = CH;
    return c;
  }, []);
  const tex = useMemo(() => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [canvas]);
  useEffect(() => () => tex.dispose(), [tex]);
  const fv = useFontsVersion();
  const last = useRef({ key: '', t: -1 });
  const animated = spec.kind === 'thinking' || spec.kind === 'recalling' || spec.kind === 'writing';
  useFrame((state) => {
    const key = `${spec.kind}|${spec.text}|${spec.color}|${spec.tag ?? ''}|${spec.fail ? 1 : 0}|${fv}`;
    const t = state.clock.elapsedTime;
    const l = last.current;
    if (key !== l.key || (animated && t - l.t > 0.09)) {
      const g = canvas.getContext('2d');
      if (!g) return;
      drawBubble(g, spec, t);
      tex.needsUpdate = true;
      l.key = key;
      l.t = t;
    }
  });
  return (
    <sprite position={position} scale={[width, (width * CH) / CW, 1]} renderOrder={30} center={[PAD_L / CW, PAD_B / CH]}>
      <spriteMaterial map={tex} transparent depthTest={false} depthWrite={false} toneMapped={false} />
    </sprite>
  );
}

export type TagVariant = 'human' | 'agent' | 'room';

function polyPath(g: CanvasRenderingContext2D, cx: number, cy: number, d: number, p: [number, number][]) {
  g.beginPath();
  p.forEach(([px, py], i) => g[i === 0 ? 'moveTo' : 'lineTo'](cx - d / 2 + px * d, cy - d / 2 + py * d));
  g.closePath();
}
const OCTA: [number, number][] = [[0.3, 0], [0.7, 0], [1, 0.3], [1, 0.7], [0.7, 1], [0.3, 1], [0, 0.7], [0, 0.3]];
const HEXA: [number, number][] = [[0.25, 0.04], [0.75, 0.04], [1, 0.5], [0.75, 0.96], [0.25, 0.96], [0, 0.5]];

/** 모서리를 깎은 각진 몸통(Agent 이름표) */
function chamferRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: number) {
  g.beginPath();
  g.moveTo(x + c, y);
  g.lineTo(x + w - c, y);
  g.lineTo(x + w, y + c);
  g.lineTo(x + w, y + h - c);
  g.lineTo(x + w - c, y + h);
  g.lineTo(x + c, y + h);
  g.lineTo(x, y + h - c);
  g.lineTo(x, y + c);
  g.closePath();
}

/**
 * 이름표(.tg-nametag). 같은 tonal 공식: 바탕 color 16%, 테두리 color 40%, 글자 fg.
 * 사람 = 둥근 알약 + 원 점, Agent = 각진 몸통 + 팔각 아이콘, Room Agent = 각진 몸통 + 육각 아이콘.
 * 나는 테두리가 color 100%.
 */
export function NameTag({
  text,
  color,
  badge,
  me,
  position,
  scale = 1,
  variant = 'human',
  onMeasure,
  compact,
  subtleBadge,
  onHover,
}: {
  text: string;
  color: string;
  badge?: string | null;
  me?: boolean;
  position: [number, number, number];
  scale?: number;
  variant?: TagVariant;
  /** 월드 크기(가로·세로)를 알려 준다: 라벨 겹침 회피용 */
  onMeasure?: (w: number, h: number) => void;
  /** Agent·Room Agent: 아이콘만 있는 작은 칩 */
  compact?: boolean;
  /** 배지를 칩 없이 작은 보조 글자(#8dbed2)로 */
  subtleBadge?: boolean;
  onHover?: (over: boolean) => void;
}) {
  const fv = useFontsVersion();
  const { tex, w, h } = useMemo(() => {
    const c = document.createElement('canvas');
    const g = c.getContext('2d')!;
    const NAME_FONT = `600 50px ${FONT}`;
    const BADGE_FONT = `600 27px ${MONO}`;
    const label = compact ? '' : text;
    g.font = NAME_FONT;
    const tw = g.measureText(label).width;
    g.font = BADGE_FONT;
    const bTxt = badge ? badge.toUpperCase() : '';
    const bTw = bTxt ? g.measureText(bTxt).width : 0;
    const chipW = bTxt && !compact ? (subtleBadge ? bTw : bTw + 32) : 0;
    const human = variant === 'human';
    const textX = 69;
    c.width = compact ? 112 : Math.ceil(textX + tw + (chipW ? 16 + chipW : 0) + 34);
    c.height = 104;
    const g2 = c.getContext('2d')!;
    const W = c.width;
    const H = c.height;
    const bg = mixSrgb(color, BASE, 0.16);
    const bd = me ? color : mixSrgb(color, BASE, 0.4);
    const bw = me ? 6 : 4;
    g2.fillStyle = bg;
    g2.strokeStyle = bd;
    g2.lineWidth = bw;
    const body = () => {
      if (human) {
        g2.beginPath();
        g2.roundRect(bw / 2, bw / 2, W - bw, H - bw, H / 2);
      } else chamferRect(g2, bw / 2, bw / 2, W - bw, H - bw, 24);
    };
    body();
    g2.fill();
    body();
    g2.stroke();
    g2.fillStyle = color;
    const ix = compact ? W / 2 : 34;
    if (human) {
      g2.beginPath();
      g2.arc(ix, H / 2, 15, 0, Math.PI * 2);
      g2.fill();
    } else if (variant === 'room') {
      polyPath(g2, ix, H / 2, 36, HEXA);
      g2.fill();
    } else {
      polyPath(g2, ix, H / 2, 34, OCTA);
      g2.fill();
    }
    g2.textBaseline = 'middle';
    g2.textAlign = 'left';
    if (!compact) {
      g2.font = NAME_FONT;
      g2.fillStyle = FG;
      g2.fillText(label, textX, H / 2 + 2);
      if (bTxt) {
        const bx = textX + tw + 16;
        g2.font = BADGE_FONT;
        if (subtleBadge) {
          g2.fillStyle = PAUSED;
          g2.fillText(bTxt, bx, H / 2 + 2);
        } else {
          g2.fillStyle = mixSrgb(FG, bg, 0.08);
          g2.beginPath();
          g2.roundRect(bx, H / 2 - 22, chipW, 44, 22);
          g2.fill();
          g2.fillStyle = FG;
          g2.fillText(bTxt, bx + 16, H / 2 + 2);
        }
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return { tex: t, w: c.width, h: c.height };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, color, badge, me, variant, compact, subtleBadge, fv]);
  useEffect(() => () => tex.dispose(), [tex]);
  const k = 0.0029 * scale;
  useEffect(() => {
    onMeasure?.(w * k, h * k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, h, k]);
  return (
    <sprite position={position} scale={[w * k, h * k, 1]} renderOrder={28} onPointerOver={onHover ? () => onHover(true) : undefined} onPointerOut={onHover ? () => onHover(false) : undefined}>
      <spriteMaterial map={tex} transparent depthTest={false} depthWrite={false} toneMapped={false} />
    </sprite>
  );
}

let dashTex: THREE.CanvasTexture | null = null;
/** 방문 배지용 점선 링 텍스처 */
export function dashedRingTexture(): THREE.CanvasTexture {
  if (dashTex) return dashTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.strokeStyle = '#fff';
  g.lineWidth = 12;
  g.setLineDash([22, 16]);
  g.beginPath();
  g.arc(128, 128, 112, 0, Math.PI * 2);
  g.stroke();
  dashTex = new THREE.CanvasTexture(c);
  return dashTex;
}
