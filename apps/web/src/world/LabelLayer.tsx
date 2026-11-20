import { useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

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
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            display: 'none',
            alignItems: 'center',
            gap: 6,
            padding: '3px 10px 3px 8px',
            borderRadius: 999,
            background: 'rgba(28,18,12,0.78)',
            border: `1px solid ${it.attention ? '#ffb45a' : 'rgba(255,238,214,0.35)'}`,
            color: '#fff4e2',
            font: '600 13px/1.2 "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif',
            whiteSpace: 'nowrap',
            letterSpacing: '0.01em',
            boxShadow: it.attention ? '0 0 10px rgba(255,180,90,0.7)' : '0 1px 6px rgba(0,0,0,0.35)',
            willChange: 'transform',
          }}
        >
          <span style={{ width: 9, height: 9, borderRadius: 9, background: it.color, boxShadow: `0 0 6px ${it.color}`, flex: 'none' }} />
          {it.label}
          {it.badge && (
            <span
              data-testid="label-badge"
              style={{
                font: '700 10.5px/1.2 "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif',
                color: it.badge.color,
                border: `1px solid ${it.badge.color}`,
                borderRadius: 999,
                padding: '1px 6px',
                background: 'rgba(255,255,255,0.08)',
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
