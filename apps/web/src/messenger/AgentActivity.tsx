import { useEffect, useRef, useState } from 'react';
import type { ActivityPhase, AgentStepKind } from '@ensemble/shared';

export const PHASE_LABEL: Record<ActivityPhase, string> = {
  thinking: '생각 중',
  recalling: '기억 떠올리는 중',
  writing: '쓰는 중',
  acting: '실행 중',
};

export const STEP_LABEL: Record<AgentStepKind, string> = {
  reading: '대화 읽음',
  recalling: '기억 떠올림',
  drafting: '초안 작성',
  talking: '말함',
};

export interface StepInfo {
  kind: AgentStepKind;
  target?: string;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** 점 3개가 튀는 "일하는 중" 표시. reduced-motion이면 정지한 점으로 보인다. */
export function WorkingDots({ label }: { label?: string }) {
  return (
    <span className="work-dots" role="img" aria-label={label ?? '작업 중'} data-testid="working-dots">
      <i />
      <i />
      <i />
    </span>
  );
}

/**
 * 누적 텍스트를 타이핑되듯 보여 준다. `animate`는 마운트 시점에 고정한다(스냅샷으로 불러온 옛 메시지는 즉시 전체).
 * 서버 청크가 크게 들어와도 뒤처진 만큼 속도를 올려 따라잡는다.
 */
export function useTypewriter(target: string, animate: boolean): string {
  const animRef = useRef(animate && !prefersReducedMotion());
  const [n, setN] = useState(animRef.current ? 0 : target.length);
  const nRef = useRef(n);
  nRef.current = n;
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    if (!animRef.current) {
      setN(target.length);
      return;
    }
    if (nRef.current >= target.length) {
      if (nRef.current > target.length) setN(target.length);
      return;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (t: number) => {
      const dt = Math.min(100, t - last);
      last = t;
      const len = targetRef.current.length;
      const cur = nRef.current;
      if (cur >= len) return; // 따라잡음. 새 텍스트가 오면 effect가 다시 돈다.
      const backlog = len - cur;
      const cps = Math.max(50, backlog * 6);
      const next = Math.min(len, cur + Math.max(1, Math.round((cps * dt) / 1000)));
      nRef.current = next;
      setN(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  return animRef.current ? target.slice(0, n) : target;
}

/** 말풍선 아래의 접을 수 있는 "작업 과정" 흔적 (agent_step 영속 이벤트) */
export function StepTrace({
  steps,
  nameOf,
  open,
  color,
}: {
  steps: readonly StepInfo[];
  nameOf: (id: string) => string;
  open?: boolean;
  color: string;
}) {
  if (steps.length === 0) return null;
  const label = (s: StepInfo) =>
    s.kind === 'talking' && s.target ? `${nameOf(s.target)}에게 말함` : STEP_LABEL[s.kind];
  return (
    <details open={open} className="group text-[11px] text-muted" data-testid="step-trace">
      <summary className="cursor-pointer select-none list-none hover:text-fg">
        <span aria-hidden="true" className="mr-1 inline-block transition-transform group-open:rotate-90">
          ›
        </span>
        작업 과정 · {steps.length}단계
      </summary>
      <ol className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5 pl-3">
        {steps.map((s, i) => (
          <li key={i} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden="true">→</span>}
            <span className="rounded-full border px-1.5 leading-4" style={{ borderColor: `${color}88` }}>
              {label(s)}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}
