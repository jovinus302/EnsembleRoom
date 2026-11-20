import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSession } from '../store/session';
import { hasSeenTour, markTourSeen, useTour } from './tourStore';
import { btn } from '../ui/tg';
import { TOURS, type TourId, type TourStep } from './tourSteps';

const PAD = 6;
const CARD_W = 340;
const GAP = 14;
const EDGE = 12;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 대상이 화면에 있고 다른 요소(모달 등)에 가려지지 않았을 때만 상자를 돌려준다. */
function resolveTarget(step: TourStep): { el: HTMLElement; box: Box } | null {
  for (const sel of step.target ?? []) {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;
    if (!step.skipOcclusion) {
      const cx = Math.min(Math.max(r.left + r.width / 2, 1), vw - 1);
      const cy = Math.min(Math.max(r.top + r.height / 2, 1), vh - 1);
      const top = document.elementsFromPoint(cx, cy).find((n) => !(n as HTMLElement).closest?.('[data-tour-ui]'));
      if (top && !(el.contains(top) || top.contains(el))) continue;
    }
    const left = Math.max(r.left, 0);
    const topPx = Math.max(r.top, 0);
    return {
      el,
      box: { left, top: topPx, width: Math.min(r.right, vw) - left, height: Math.min(r.bottom, vh) - topPx },
    };
  }
  return null;
}

/** 대상 옆(오른쪽 → 왼쪽 → 아래 → 위)에 카드를 두고, 들어갈 데가 없으면 대상 안쪽 아래에 둔다. */
function placeCard(box: Box, w: number, h: number): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampX = (x: number) => Math.min(Math.max(x, EDGE), vw - w - EDGE);
  const clampY = (y: number) => Math.min(Math.max(y, EDGE), vh - h - EDGE);
  const cx = box.left + box.width / 2 - w / 2;
  const cy = box.top + box.height / 2 - h / 2;
  const right = box.left + box.width + PAD + GAP;
  if (right + w + EDGE <= vw) return { left: right, top: clampY(cy) };
  const left = box.left - PAD - GAP - w;
  if (left >= EDGE) return { left, top: clampY(cy) };
  const below = box.top + box.height + PAD + GAP;
  if (below + h + EDGE <= vh) return { left: clampX(cx), top: below };
  const above = box.top - PAD - GAP - h;
  if (above >= EDGE) return { left: clampX(cx), top: above };
  return { left: clampX(cx), top: clampY(box.top + box.height - h - GAP) };
}

function TourOverlay({ id, userId }: { id: TourId; userId: string }) {
  const { steps, label } = TOURS[id];
  const [index, setIndex] = useState(0);
  const [target, setTarget] = useState<Box | null>(null);
  const [size, setSize] = useState({ w: CARD_W, h: 240 });
  const cardRef = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const step = steps[index]!;
  const last = index === steps.length - 1;

  const finish = useCallback(
    (how: 'done' | 'skipped') => {
      markTourSeen(userId, id, how);
      useTour.getState().close();
    },
    [userId, id],
  );
  const go = useCallback(
    (to: number) => {
      if (to < 0) return;
      if (to >= steps.length) return finish('done');
      setIndex(to);
    },
    [steps.length, finish],
  );

  // 대상 위치 추적: 단계가 바뀔 때, 리사이즈·스크롤 때, 그리고 레이아웃이 비동기로 바뀔 때를 위해 짧은 주기로 다시 잰다.
  useLayoutEffect(() => {
    resolveTarget(step)?.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const measure = () => {
      const b = resolveTarget(step)?.box ?? null;
      setTarget((prev) => {
        if (prev === b) return prev;
        if (prev && b && prev.left === b.left && prev.top === b.top && prev.width === b.width && prev.height === b.height) return prev;
        return b;
      });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    const t = window.setInterval(measure, 300);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      window.clearInterval(t);
    };
  }, [step]);

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setSize((s) => (Math.abs(s.h - r.height) > 0.5 || Math.abs(s.w - r.width) > 0.5 ? { w: r.width, h: r.height } : s));
  }, [index, target]);

  // 포커스: 열릴 때 카드로, 단계가 바뀌면 다시 카드로. 닫히면 원래 있던 곳으로 돌려준다.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, []);
  useEffect(() => {
    cardRef.current?.focus();
  }, [index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish('skipped');
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        go(index + 1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        go(index - 1);
      } else if (e.key === 'Tab') {
        const card = cardRef.current;
        if (!card) return;
        const items = [...card.querySelectorAll<HTMLElement>('button:not([disabled])')];
        if (items.length === 0) return;
        const active = document.activeElement as HTMLElement | null;
        const at = active ? items.indexOf(active) : -1;
        const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === items.length - 1 ? 0 : at + 1;
        e.preventDefault();
        items[next]!.focus();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      const card = cardRef.current;
      if (card && !card.contains(e.target as Node)) card.focus();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [index, go, finish]);

  const pos = target
    ? placeCard(target, size.w, size.h)
    : { left: Math.max(EDGE, (window.innerWidth - size.w) / 2), top: Math.max(EDGE, (window.innerHeight - size.h) / 2) };
  const move = reduced ? 'none' : 'left 220ms ease, top 220ms ease, width 220ms ease, height 220ms ease';

  return createPortal(
    <div
      data-tour-ui
      data-testid="tour"
      data-tour-id={id}
      data-step={index}
      data-target={target ? 'found' : 'none'}
      className="pointer-events-auto fixed inset-0 z-[60]"
      onMouseDown={(e) => {
        if (!cardRef.current?.contains(e.target as Node)) e.preventDefault();
      }}
    >
      {target ? (
        <div
          aria-hidden="true"
          data-testid="tour-spotlight"
          className="tg-spot pointer-events-none fixed"
          style={{
            left: target.left - PAD,
            top: target.top - PAD,
            width: target.width + PAD * 2,
            height: target.height + PAD * 2,
            transition: move,
          }}
        />
      ) : (
        <div aria-hidden="true" className="pointer-events-none fixed inset-0 bg-[var(--scrim-tour)]" />
      )}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${label} · ${step.title}`}
        tabIndex={-1}
        data-testid="tour-card"
        className="tg-panel tg-tour fixed outline-none"
        style={{ left: pos.left, top: pos.top, width: CARD_W, maxWidth: `calc(100vw - ${EDGE * 2}px)`, transition: move }}
      >
        <div className="flex items-center gap-2">
          <span className="tg-mono">{label}</span>
          <span className="tg-mono ml-auto" aria-live="polite">
            {index + 1} / {steps.length}
          </span>
        </div>
        <h2 className="tg-title text-body">{step.title}</h2>
        <p className="tg-aux leading-relaxed">{step.body}</p>
        <div className="tg-steps" role="group" aria-label="진행 단계">
          {steps.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`${i + 1}단계로 이동`}
              aria-current={i === index ? 'step' : undefined}
              onClick={() => setIndex(i)}
              className={i <= index ? 'on' : undefined}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" data-testid="tour-skip" onClick={() => finish('skipped')} className={btn('ghost')}>
            건너뛰기
          </button>
          <span className="ml-auto" />
          {index > 0 && (
            <button type="button" data-testid="tour-prev" onClick={() => go(index - 1)} className={btn('soft')}>
              이전
            </button>
          )}
          <button type="button" data-testid="tour-next" onClick={() => go(index + 1)} className={btn('primary')}>
            {last ? '완료' : '다음'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 화면에 하나 붙이는 투어 호스트. ready가 되면 처음 한 번 자동으로 시작하고(사용자별 저장),
 * 이후에는 GuideButton으로만 다시 연다. Room 투어는 메신저 투어를 끝낸/건너뛴 뒤에만 자동 시작한다.
 */
export function TourHost({ id, ready }: { id: TourId; ready: boolean }) {
  const userId = useSession((s) => s.user?.id);
  const active = useTour((s) => s.active);

  useEffect(() => {
    if (!ready || !userId) return;
    if (hasSeenTour(userId, id)) return;
    if (id === 'room' && !hasSeenTour(userId, 'home')) return;
    const t = window.setTimeout(() => {
      if (useTour.getState().active === null && !hasSeenTour(userId, id)) useTour.getState().open(id);
    }, 700);
    return () => window.clearTimeout(t);
  }, [ready, userId, id]);

  // 화면을 떠나면 열려 있던 투어도 닫는다(완료로 기록하지 않는다).
  useEffect(
    () => () => {
      if (useTour.getState().active === id) useTour.getState().close();
    },
    [id],
  );

  if (active !== id || !userId) return null;
  return <TourOverlay key={id} id={id} userId={userId} />;
}

/** 가이드를 언제든 다시 여는 물음표 버튼. */
export function GuideButton({ id, withLabel = false }: { id: TourId; withLabel?: boolean }) {
  return (
    <button
      type="button"
      data-testid={`guide-open-${id}`}
      aria-label="가이드 열기"
      title="가이드 다시 보기"
      onClick={() => useTour.getState().open(id)}
      className={`${btn('ghost', { round: !withLabel })} shrink-0`}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
        <circle cx="8" cy="8" r="6.4" />
        <path d="M6.1 6.2a2 2 0 1 1 2.9 1.8c-.7.4-1 .8-1 1.5" />
        <circle cx="8" cy="11.7" r=".5" fill="currentColor" />
      </svg>
      {withLabel && '가이드'}
    </button>
  );
}
