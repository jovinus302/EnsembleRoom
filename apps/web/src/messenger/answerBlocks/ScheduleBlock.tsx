import type { ScheduleAnswerBlock, ScheduleItem } from '@ensemble/shared';
import { SourceChips } from './SourceChips';

const STATUS_TEXT: Record<ScheduleItem['status'], string> = {
  fixed: '확정',
  tentative: '미정',
  pending: '승인 대기',
  free: '비어 있음',
  conflict: '겹침',
};
const DOT: Record<ScheduleItem['status'], string | null> = {
  fixed: 'var(--ab-ok)',
  tentative: 'var(--ab-warn)',
  pending: 'var(--ab-warn)',
  free: null,
  conflict: null,
};

function timeOf(it: ScheduleItem): string {
  if (it.start && it.end) return `${it.start}–${it.end}`;
  return it.start ?? it.when ?? '';
}

function Item({ it }: { it: ScheduleItem }) {
  const meta = [it.with, it.room].filter(Boolean).join(' · ');
  const dot = DOT[it.status];
  return (
    <div className="ab-item" data-status={it.status} data-testid="ab-schedule-item">
      <span className="ab-item-time">{timeOf(it)}</span>
      <span className="ab-item-title">{it.status === 'free' ? '비어 있음' : it.title}</span>
      {it.status !== 'free' && meta && <span className="ab-item-meta">{meta}</span>}
      {it.status !== 'free' && (
        <span className="ab-status-row">
          {dot && <span className="ab-dot" style={{ background: dot }} />}
          {it.status === 'conflict' ? (
            <span className="ab-tag" style={{ color: 'var(--ab-danger)' }}>
              겹침
            </span>
          ) : (
            <span className="ab-status-text">{STATUS_TEXT[it.status]}</span>
          )}
          <SourceChips sources={it.sources} />
        </span>
      )}
    </div>
  );
}

export function ScheduleBlock({ block }: { block: ScheduleAnswerBlock }) {
  const strip = block.days.length <= 3;
  return (
    <section className="ab-card" data-testid="ab-schedule" aria-label={block.title ?? '일정'}>
      {block.title && (
        <div className="ab-head">
          <span className="ab-title">{block.title}</span>
        </div>
      )}
      {strip ? (
        <div className="ab-strip" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
          {block.days.map((d, i) => (
            <div key={i} className="ab-strip-col">
              <span className="ab-strip-label">{d.label}</span>
              {d.items.map((it, j) => (
                <Item key={j} it={it} />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="ab-timeline">
          {block.days.map((d, i) => (
            <div key={i} className="ab-tl-day">
              <span className="ab-strip-label">{d.label}</span>
              <div className="ab-tl-items">
                {d.items.map((it, j) => (
                  <Item key={j} it={it} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {block.verdict && <div className="ab-verdict">{block.verdict}</div>}
    </section>
  );
}
