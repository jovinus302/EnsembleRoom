import type { CompareAnswerBlock } from '@ensemble/shared';

const MARK = { yes: '○', no: '×', maybe: '△' } as const;
const MARK_LABEL = { yes: '가능', no: '불가', maybe: '애매' } as const;

export function CompareBlock({ block }: { block: CompareAnswerBlock }) {
  const min = block.options.length > 2 ? 150 : 200;
  return (
    <section className="ab-card" data-testid="ab-compare" aria-label={block.question}>
      <div className="ab-question">{block.question}</div>
      <div className="ab-options" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))` }}>
        {block.options.map((o, i) => (
          <div key={i} className="ab-option" data-rec={o.recommended ? 'true' : 'false'} data-testid="ab-option">
            <div className="ab-option-head">
              <span>{o.label}</span>
              {o.recommended && (
                <span className="ab-tag ab-rec" data-testid="ab-rec">
                  추천
                </span>
              )}
            </div>
            {((o.pros?.length ?? 0) > 0 || (o.cons?.length ?? 0) > 0) && (
              <ul className="ab-list">
                {o.pros?.map((t, k) => (
                  <li key={`p${k}`} className="ab-pro">
                    {t}
                  </li>
                ))}
                {o.cons?.map((t, k) => (
                  <li key={`c${k}`} className="ab-con">
                    {t}
                  </li>
                ))}
              </ul>
            )}
            {o.people?.map((p, k) => (
              <div key={k} className="ab-person">
                <span className="ab-ok-mark" data-ok={p.ok} role="img" aria-label={MARK_LABEL[p.ok]}>
                  {MARK[p.ok]}
                </span>
                <span>
                  {p.name}
                  {p.note && <span className="ab-kicker"> · {p.note}</span>}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
      {block.recommendation && <div className="ab-verdict">{block.recommendation}</div>}
    </section>
  );
}
