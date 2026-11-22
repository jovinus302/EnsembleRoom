import { useMemo } from 'react';
import type { RoomEvent } from '@ensemble/shared';
import { btn, cvar } from '../ui/tg';
import { eventLabel, eventMark } from './eventLabel';

/**
 * 타임라인 스크러버. 보이는 이벤트 목록의 위치를 고르면 그 seq가 `replaySeq`가 된다.
 * 맨 끝 = 라이브(null). 재생 중에는 RoomModel이 그 시점까지만 리듀싱한다(2D/3D 공통).
 */
export function TimelineScrubber({
  events,
  replaySeq,
  onChange,
  nameOf,
  className = '',
}: {
  events: readonly RoomEvent[];
  replaySeq: number | null;
  onChange: (seq: number | null) => void;
  nameOf: (id: string | null | undefined) => string;
  /** 위치·입장 모션(RoomView가 정한다) */
  className?: string;
}) {
  const n = events.length;
  // 현재 위치: 마지막으로 포함된 이벤트 인덱스+1 (0 = 아무 일도 일어나기 전, n = 라이브)
  const pos = useMemo(() => {
    if (replaySeq === null) return n;
    let c = 0;
    for (const e of events) if (e.seq <= replaySeq) c++;
    return c;
  }, [events, replaySeq, n]);

  const set = (p: number) => onChange(p >= n ? null : p <= 0 ? 0 : events[p - 1]!.seq);
  const current = pos > 0 ? events[pos - 1] : undefined;
  const marks = useMemo(
    () => events.map((e, i) => ({ i, color: eventMark(e) })).filter((m): m is { i: number; color: string } => m.color !== null),
    [events],
  );

  const max = Math.max(n, 1);
  const pct = (pos / max) * 100;
  const labelText =
    replaySeq === null ? `지금 · 이벤트 ${n}개` : `과거 재생 · #${current?.seq ?? 0} ${current ? eventLabel(current, nameOf) : '시작 전'}`;

  return (
    <section
      aria-label="타임라인"
      data-testid="timeline"
      data-replaying={replaySeq !== null ? 'true' : 'false'}
      className={`tg-panel tg-tlbar pointer-events-auto ${replaySeq !== null ? 'past' : ''} ${className}`}
    >
      <button
        type="button"
        aria-label="한 단계 뒤로"
        data-testid="timeline-prev"
        disabled={pos <= 0 || n === 0}
        onClick={() => set(pos - 1)}
        className={btn('ghost', { round: true })}
      >
        ◀
      </button>
      <button
        type="button"
        aria-label="한 단계 앞으로"
        data-testid="timeline-next"
        disabled={pos >= n}
        onClick={() => set(pos + 1)}
        className={btn('primary', { round: true })}
      >
        ▶
      </button>
      <div className="tg-tlwrap relative h-6 min-w-[60px] flex-1">
        <div aria-hidden="true" className="tg-track absolute inset-x-2 top-1/2 -translate-y-1/2">
          <span className="fill" style={{ width: `${pct}%` }} />
          {marks.map((m) => (
            <span key={m.i} className="ev" style={{ left: `${((m.i + 1) / max) * 100}%`, ...cvar(m.color) }} />
          ))}
          <span className="th" style={{ left: `${pct}%` }} />
        </div>
        <input
          type="range"
          data-testid="timeline-range"
          aria-label="타임라인 위치"
          aria-valuetext={replaySeq === null ? '지금' : `이벤트 ${pos}/${n}`}
          min={0}
          max={max}
          step={1}
          value={Math.min(pos, max)}
          disabled={n === 0}
          onChange={(e) => set(Number(e.target.value))}
          className="tg-tl-range absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
        />
      </div>
      <div
        className="hidden w-[180px] shrink-0 truncate text-aux min-[1280px]:block"
        style={{ color: replaySeq === null ? 'var(--muted)' : 'var(--amber-ink)' }}
        data-testid="timeline-label"
        aria-live="polite"
        title={labelText}
      >
        {labelText}
      </div>
      <button type="button" data-testid="timeline-live" disabled={replaySeq === null} onClick={() => onChange(null)} className={btn('ghost')}>
        지금으로
      </button>
    </section>
  );
}
