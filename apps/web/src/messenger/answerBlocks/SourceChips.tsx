import type { SourceChip } from '@ensemble/shared';

/** 근거 칩: "✦ 내 기억", "우리 가족 · 카드" */
export function SourceChips({ sources }: { sources?: readonly SourceChip[] }) {
  if (!sources || sources.length === 0) return null;
  return (
    <span className="ab-sources" data-testid="ab-sources">
      {sources.map((s, i) => (
        <span key={i} className="ab-src" data-kind={s.kind}>
          {s.kind === 'memory' ? '✦ ' : ''}
          {s.label}
        </span>
      ))}
    </span>
  );
}
