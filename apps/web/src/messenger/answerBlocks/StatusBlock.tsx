import type { StatusAnswerBlock, StatusItem } from '@ensemble/shared';
import { SourceChips } from './SourceChips';

const LABEL: Record<StatusItem['state'], string> = {
  decided: '★ 결정',
  pending_approval: '승인 대기',
  waiting: '기다리는 중',
  todo: '할 일',
};

export function StatusBlock({ block }: { block: StatusAnswerBlock }) {
  return (
    <section className="ab-card" data-testid="ab-status" aria-label="방별 현황">
      {block.rooms.map((r, i) => (
        <div key={i} className="ab-room">
          <div className="ab-room-name">{r.room}</div>
          {r.items.map((it, j) => (
            <div key={j} className="ab-st">
              <span>
                {it.text}
                <SourceChips sources={it.sources} />
              </span>
              <span className="ab-pill" data-state={it.state}>
                {LABEL[it.state]}
              </span>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
