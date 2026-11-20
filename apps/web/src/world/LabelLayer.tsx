import { useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { ink } from '../theme';

/**
 * 조망용 이름 칩. 캔버스 안(drei Html)이 아니라 **캔버스 밖 DOM 레이어**에 그린다:
 *  - 블룸·유리·튜브에 가려지지 않고(계획 8.7 가독성), R3F 루트 안에서 별도 React 루트가 생기지 않는다
 *    (품질 단계 전환으로 Canvas가 다시 마운트될 때 `Html`이 렌더 중에 unmount되며 나던 오류를 없앤다).
 *  - 칩은 각 캡슐 지붕 위에 두고, 화면에서 겹치면 위로 밀어 올려 충돌을 피한다.
 */
export interface LabelItem {
  id: string;
  label: string;
  color: string;
  /** 월드 좌표의 앵커(캡슐 지붕 위) */
  anchor: [number, number, number];
  active: boolean;
  /** 승인 대기 등 강조 */
  attention: boolean;
  /** 라벨 옆 작은 표식(예: 내 Agent 방문 중) */
  badge?: { text: string; color: string };
  /** 1인 방(소유자 실루엣) / 여럿의 방(겹친 색 점 + 인원 수) */
  people?: { kind: 'one' | 'many'; colors: string[] };
}

export type LabelEls = Map<string, HTMLElement>;

const v = new THREE.Vector3();

/** Canvas 안에서 매 프레임 앵커를 화면에 투영해 DOM 칩의 transform을 직접 쓴다 */
export function LabelProjector({ items, els, hidden }: { items: readonly LabelItem[]; els: RefObject<LabelEls>; hidden: boolean }) {
  const size = useThree((s) => s.size);
  const sizes = useRef(new Map<string, { w: number; h: number }>());
  useFrame((state) => {
    const map = els.current;
    if (!map) return;
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const cam = state.camera;
    const proj = items
      .map((it) => {
        v.set(...it.anchor).project(cam);
        return { it, x: (v.x * 0.5 + 0.5) * size.width, y: (-v.y * 0.5 + 0.5) * size.height, z: v.z, behind: v.z > 1 };
      })
      // 화면 아래(가까운 캡슐)부터 자리를 잡는다: 앞줄 칩이 제자리를 지키고 뒷줄이 비켜 간다
      .sort((a, b) => b.y - a.y);
    for (const p of proj) {
      const el = map.get(p.it.id);
      if (!el) continue;
      if (hidden || p.behind) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = 'flex';
      let sz = sizes.current.get(p.it.id);
      if (!sz || el.offsetWidth !== sz.w) {
        sz = { w: el.offsetWidth || 90, h: el.offsetHeight || 26 };
        sizes.current.set(p.it.id, sz);
      }
      let y = p.y - 6;
      const x0 = p.x - sz.w / 2;
      for (let n = 0; n < 8; n++) {
        const hit = placed.find((r) => x0 < r.x1 + 4 && x0 + sz.w > r.x0 - 4 && y - sz.h < r.y1 + 3 && y > r.y0 - 3);
        if (!hit) break;
        y = hit.y0 - 4;
      }
      placed.push({ x0, x1: x0 + sz.w, y0: y - sz.h, y1: y });
      el.style.transform = `translate(${Math.round(x0)}px, ${Math.round(y - sz.h)}px)${p.it.active ? ' scale(1.06)' : ''}`;
    }
  });
  return null;
}

/** DOM 칩 레이어. 위치는 LabelProjector가 정한다 */
export function LabelLayer({ items, els }: { items: readonly LabelItem[]; els: RefObject<LabelEls> }) {
  return (
    <div aria-hidden="true" style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 2 }}>
      {items.map((it) => (
        <div
          key={it.id}
          ref={(el) => {
            const m = els.current;
            if (!m) return;
            if (el) m.set(it.id, el);
            else m.delete(it.id);
          }}
          data-world-label={it.id}
          className="world-label"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            display: 'none',
            alignItems: 'center',
            gap: 6,
            padding: '3px 10px 3px 8px',
            borderRadius: 999,
            background: 'var(--label-bg)',
            border: `1px solid ${it.attention ? 'var(--label-attn-border)' : 'var(--label-border)'}`,
            color: 'var(--label-fg)',
            font: '600 13px/1.2 "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif',
            whiteSpace: 'nowrap',
            letterSpacing: '0.01em',
            boxShadow: it.attention ? 'var(--label-attn-shadow)' : 'var(--label-shadow)',
            willChange: 'transform',
          }}
        >
          {it.people?.kind === 'many' ? <PeopleDots colors={it.people.colors} /> : it.people?.kind === 'one' ? <PersonIcon color={it.people.colors[0] ?? it.color} /> : (
            <span style={{ width: 9, height: 9, borderRadius: 9, background: it.color, boxShadow: `0 0 6px ${it.color}`, flex: 'none' }} />
          )}
          {it.label}
          {it.people?.kind === 'many' && (
            <span data-testid="label-people-count" style={{ font: '700 11px/1 system-ui, sans-serif', color: 'var(--label-fg-dim)' }}>
              {it.people.colors.length}
            </span>
          )}
          {it.badge && (
            <span
              data-testid="label-badge"
              style={{
                font: '700 10.5px/1.2 "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif',
                color: ink(it.badge.color),
                border: `1px solid ${it.badge.color}`,
                borderRadius: 999,
                padding: '1px 6px',
                background: 'var(--label-chip-bg)',
              }}
            >
              {it.badge.text}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** 1인: 소유자 색 실루엣(머리 + 어깨), 10px */
function PersonIcon({ color }: { color: string }) {
  return (
    <svg data-testid="label-people-one" width="10" height="10" viewBox="0 0 10 10" style={{ flex: 'none', filter: `drop-shadow(0 0 3px ${color})` }}>
      <circle cx="5" cy="3" r="2.2" fill={color} />
      <path d="M0.8 10 C0.8 6.6 2.6 5.6 5 5.6 C7.4 5.6 9.2 6.6 9.2 10 Z" fill={color} />
    </svg>
  );
}

/** 여럿: 겹친 8px 색 점(최대 5) */
function PeopleDots({ colors }: { colors: readonly string[] }) {
  return (
    <span data-testid="label-people-many" style={{ display: 'inline-flex', flex: 'none', paddingRight: 3 }}>
      {colors.slice(0, 5).map((c, i) => (
        <span
          key={i}
          style={{ width: 8, height: 8, borderRadius: 8, background: c, border: '1px solid var(--label-dot-border)', marginLeft: i === 0 ? 0 : -3, boxSizing: 'content-box' }}
        />
      ))}
    </span>
  );
}
