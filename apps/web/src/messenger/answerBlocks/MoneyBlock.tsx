import type { MoneyAnswerBlock } from '@ensemble/shared';

const won = (n: number) => `${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('ko-KR')}원`;

export function MoneyBlock({ block }: { block: MoneyAnswerBlock }) {
  return (
    <section className="ab-card" data-testid="ab-money" aria-label={block.title}>
      <div className="ab-head">
        <span className="ab-title">{block.title}</span>
      </div>
      <table className="ab-money">
        <tbody>
          {block.lines.map((l, i) => (
            <tr key={i}>
              <td>
                {l.label}
                {(l.from || l.to) && (
                  <div className="ab-flow">
                    {l.from ?? ''} → {l.to ?? ''}
                  </div>
                )}
              </td>
              <td className="ab-amt">{won(l.amount)}</td>
            </tr>
          ))}
          {block.total !== undefined && (
            <tr className="ab-total" data-testid="ab-total">
              <td>합계</td>
              <td className="ab-amt">{won(block.total)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {block.note && <div className="ab-note">{block.note}</div>}
    </section>
  );
}
