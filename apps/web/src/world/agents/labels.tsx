import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const FONT = '"Malgun Gothic","Noto Sans KR","Apple SD Gothic Neo",system-ui,sans-serif';

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
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

export type BubbleKind = 'thinking' | 'recalling' | 'writing' | 'said' | 'ask' | 'paused' | 'error';

export interface BubbleSpec {
  kind: BubbleKind;
  text: string;
  /** 테두리·강조 색 */
  color: string;
}

const CW = 384;
const CH = 168;

function drawBubble(g: CanvasRenderingContext2D, spec: BubbleSpec, t: number) {
  g.clearRect(0, 0, CW, CH);
  const dots = spec.kind === 'thinking' || spec.kind === 'recalling' || (spec.kind === 'writing' && !spec.text);
  const pad = 18;
  g.font = `700 27px ${FONT}`;
  const lines = dots ? [] : wrapLines(g, spec.text || (spec.kind === 'ask' ? '승인이 필요해요' : spec.kind === 'paused' ? '일시정지' : '…'), CW - pad * 2 - 12, 2);
  const textW = lines.reduce((m, l) => Math.max(m, g.measureText(l).width), 0);
  const w = dots ? 150 : Math.min(CW - 8, Math.max(130, textW + pad * 2 + 8));
  const h = dots ? 76 : 22 + lines.length * 34 + 14;
  const x = (CW - w) / 2;
  const y = CH - 22 - h;
  // 그림자 + 본체
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.35)';
  g.shadowBlur = 10;
  g.shadowOffsetY = 3;
  g.fillStyle = spec.kind === 'ask' ? '#fff0dc' : '#fffdf8';
  roundRect(g, x, y, w, h, 26);
  g.fill();
  g.restore();
  g.lineWidth = 5;
  g.strokeStyle = spec.color;
  roundRect(g, x, y, w, h, 26);
  g.stroke();
  // 꼬리
  g.fillStyle = spec.kind === 'ask' ? '#fff0dc' : '#fffdf8';
  g.beginPath();
  g.moveTo(CW / 2 - 12, y + h - 1);
  g.lineTo(CW / 2 + 12, y + h - 1);
  g.lineTo(CW / 2, y + h + 17);
  g.closePath();
  g.fill();
  g.strokeStyle = spec.color;
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(CW / 2 - 12, y + h + 1);
  g.lineTo(CW / 2, y + h + 17);
  g.lineTo(CW / 2 + 12, y + h + 1);
  g.stroke();
  if (dots) {
    for (let i = 0; i < 3; i++) {
      const ph = Math.sin(t * 6 - i * 0.9);
      g.fillStyle = spec.kind === 'recalling' ? '#7e5fd8' : spec.color;
      g.globalAlpha = 0.45 + 0.55 * Math.max(0, ph);
      g.beginPath();
      g.arc(CW / 2 + (i - 1) * 32, y + h / 2 - ph * 5, 9 + ph * 1.5, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  } else {
    g.fillStyle = '#2b2118';
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    lines.forEach((l, i) => g.fillText(l, CW / 2, y + 22 + 17 + i * 34 - (lines.length === 1 ? 4 : 0)));
    if (spec.kind === 'writing') {
      g.fillStyle = spec.color;
      g.fillRect(x + w - 26, y + h - 20, 12, 4);
    }
  }
}

/**
 * 3D 말풍선(캔버스 텍스처 스프라이트). 점 3개(생각), 스트리밍 텍스트, 승인 대기 표시를 그린다.
 * DOM이 아니라 씬 안의 스프라이트이므로 `Html`의 마운트·언마운트 문제가 없다. 항상 위에 보이도록 depthTest를 끈다.
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
  const last = useRef({ key: '', t: -1 });
  const animated = spec.kind === 'thinking' || spec.kind === 'recalling' || (spec.kind === 'writing' && !spec.text);
  useFrame((state) => {
    const key = `${spec.kind}|${spec.text}|${spec.color}`;
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
    <sprite position={position} scale={[width, (width * CH) / CW, 1]} renderOrder={30} center={[0.5, 0.0]}>
      <spriteMaterial map={tex} transparent depthTest={false} depthWrite={false} toneMapped={false} />
    </sprite>
  );
}

/** 이름표: 작은 알약. 나·소유자·방문 표식 */
export function NameTag({
  text,
  color,
  badge,
  me,
  position,
  scale = 1,
}: {
  text: string;
  color: string;
  badge?: string | null;
  me?: boolean;
  position: [number, number, number];
  scale?: number;
}) {
  const { tex, w, h } = useMemo(() => {
    const c = document.createElement('canvas');
    const g = c.getContext('2d')!;
    g.font = `800 25px ${FONT}`;
    const label = text;
    const tw = g.measureText(label).width;
    const bw = badge ? g.measureText(badge).width + 22 : 0;
    const dot = 26;
    c.width = Math.ceil(tw + bw + dot + 36);
    c.height = 52;
    const g2 = c.getContext('2d')!;
    g2.font = `800 25px ${FONT}`;
    g2.fillStyle = me ? 'rgba(255,250,235,0.96)' : 'rgba(28,18,12,0.78)';
    roundRect(g2, 1, 1, c.width - 2, c.height - 2, 25);
    g2.fill();
    g2.lineWidth = me ? 4 : 2.5;
    g2.strokeStyle = color;
    g2.stroke();
    g2.fillStyle = color;
    g2.beginPath();
    g2.arc(26, 26, 9, 0, Math.PI * 2);
    g2.fill();
    g2.textBaseline = 'middle';
    g2.fillStyle = me ? '#2b2118' : '#fff4e2';
    g2.fillText(label, 44, 28);
    if (badge) {
      const bx = 44 + tw + 8;
      g2.fillStyle = color;
      roundRect(g2, bx, 9, bw - 8, 34, 17);
      g2.fill();
      g2.fillStyle = '#1b1208';
      g2.font = `800 20px ${FONT}`;
      g2.fillText(badge, bx + 9, 27);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return { tex: t, w: c.width, h: c.height };
  }, [text, color, badge, me]);
  useEffect(() => () => tex.dispose(), [tex]);
  const k = 0.0058 * scale;
  return (
    <sprite position={position} scale={[w * k, h * k, 1]} renderOrder={28}>
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
