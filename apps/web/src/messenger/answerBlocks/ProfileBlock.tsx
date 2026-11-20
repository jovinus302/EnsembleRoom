import type { ProfileAnswerBlock } from '@ensemble/shared';
import { SourceChips } from './SourceChips';

export function ProfileBlock({ block }: { block: ProfileAnswerBlock }) {
  return (
    <section className="ab-card" data-testid="ab-profile" aria-label={block.title}>
      <div className="ab-head">
        <span className="ab-title">{block.title}</span>
      </div>
      {block.groups.map((g, i) => (
        <div key={i} className="ab-group">
          <div className="ab-group-label">{g.label}</div>
          <div className="ab-chips">
            {g.chips.map((c, j) => (
              <span key={j} className="ab-chip" data-tone={c.tone}>
                {c.tone !== 'note' && (
                  <span className="ab-chip-mark" aria-hidden="true">
                    {c.tone === 'like' ? '✓' : '✕'}
                  </span>
                )}
                {c.text}
                <SourceChips sources={c.sources} />
              </span>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
