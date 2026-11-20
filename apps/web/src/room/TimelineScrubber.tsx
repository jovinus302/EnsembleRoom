import { useMemo } from 'react';
import type { RoomEvent } from '@ensemble/shared';
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
}: {
  events: readonly RoomEvent[];
  replaySeq: number | null;
  onChange: (seq: number | null) => void;
  nameOf: (id: string | null | undefined) => string;
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

  return (
    <section
      aria-label="타임라인"
      data-testid="timeline"
      data-replaying={replaySeq !== null ? 'true' : 'false'}
      className="flex items-center gap-3 border-t border-line bg-panel px-5 py-2.5"
    >
      <button
        type="button"
        aria-label="한 단계 뒤로"
        data-testid="timeline-prev"
        disabled={pos <= 0 || n === 0}
        onClick={() => set(pos - 1)}
        className="h-8 w-8 rounded-md border border-line text-sm hover:bg-raised disabled:opacity-40"
      >
        ◀
      </button>
      <button
        type="button"
        aria-label="한 단계 앞으로"
        data-testid="timeline-next"
        disabled={pos >= n}
        onClick={() => set(pos + 1)}
        className="h-8 w-8 rounded-md border border-line text-sm hover:bg-raised disabled:opacity-40"
      >
        ▶
      </button>
      <div className="relative min-w-0 flex-1">
        <input
          type="range"
          data-testid="timeline-range"
          aria-label="타임라인 위치"
          aria-valuetext={replaySeq === null ? '지금' : `이벤트 ${pos}/${n}`}
          min={0}
          max={Math.max(n, 1)}
          step={1}
          value={Math.min(pos, Math.max(n, 1))}
          disabled={n === 0}
          onChange={(e) => set(Number(e.target.value))}
          className="relative z-10 w-full accent-[#8ab4ff]"
        />
        {n > 0 && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-[7px] top-[17px] h-1.5">
            {marks.map((m) => (
              <span
                key={m.i}
                className="absolute top-0 h-1.5 w-1.5 -translate-x-1/2 rounded-full"
                style={{ left: `${((m.i + 1) / Math.max(n, 1)) * 100}%`, background: m.color }}
              />
            ))}
          </div>
        )}
      </div>
      <div className="w-[300px] shrink-0 truncate text-xs text-muted" data-testid="timeline-label" aria-live="polite">
        {replaySeq === null ? (
          <span>지금 · 이벤트 {n}개</span>
        ) : (
          <span style={{ color: '#ffd9a0' }}>
            과거 재생 · #{current?.seq ?? 0} {current ? eventLabel(current, nameOf) : '시작 전'}
          </span>
        )}
      </div>
      <button
        type="button"
        data-testid="timeline-live"
        disabled={replaySeq === null}
        onClick={() => onChange(null)}
        className="rounded-md border border-line px-3 py-1.5 text-xs hover:bg-raised disabled:opacity-40"
      >
        지금으로
      </button>
    </section>
  );
}
