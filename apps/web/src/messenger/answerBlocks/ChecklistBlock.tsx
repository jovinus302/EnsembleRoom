import type { ChecklistAnswerBlock } from '@ensemble/shared';
import { SourceChips } from './SourceChips';

/** 읽기 전용 체크 목록(버튼·입력 없음) */
export function ChecklistBlock({ block }: { block: ChecklistAnswerBlock }) {
  return (
    <section className="ab-card" data-testid="ab-checklist" aria-label={block.title}>
      <div className="ab-head">
        <span className="ab-title">{block.title}</span>
      </div>
      <div role="list">
        {block.items.map((it, i) => {
          const meta = [it.due, it.room].filter(Boolean).join(' · ');
          return (
            <div key={i} role="listitem" className="ab-check" data-done={it.done ? 'true' : 'false'}>
              <span className="ab-box" data-done={it.done ? 'true' : 'false'} aria-label={it.done ? '완료' : '미완료'} role="img">
                {it.done ? '✓' : ''}
              </span>
              <span className="ab-check-body">
                <span className="ab-check-text">{it.text}</span>
                {(meta || it.sources?.length) && (
                  <span className="ab-check-meta">
                    {meta}
                    <SourceChips sources={it.sources} />
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
