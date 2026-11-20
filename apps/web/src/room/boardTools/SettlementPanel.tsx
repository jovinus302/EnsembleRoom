import { useState } from 'react';
import { BOARD_TOOL_LIMITS, formatWon, settle, settleParticipants, type SettlementTool } from '@ensemble/shared';
import { ToolError, ViewOnlyNote, toolBtnPrimary, toolInput, useToolOp } from './common';

/** 금액 입력 문자열 → 정수 원 (쉼표·공백 허용). 범위 밖이면 null */
export function parseAmount(s: string): number | null {
  const n = Number(s.replace(/[,\s원]/g, ''));
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > BOARD_TOOL_LIMITS.amountMax) return null;
  return n;
}

function AddExpenseForm({ tool, roomId }: { tool: SettlementTool; roomId: string }) {
  const people = settleParticipants(tool);
  const [label, setLabel] = useState('');
  const [payer, setPayer] = useState(people[0] ?? '');
  const [amount, setAmount] = useState('');
  const [excluded, setExcluded] = useState<string[]>([]);
  const split = people.filter((x) => !excluded.includes(x));
  const { busy, error, run } = useToolOp(roomId, tool.toolId);
  const amt = parseAmount(amount);
  const name = payer.trim();
  const full = tool.expenses.length >= BOARD_TOOL_LIMITS.expenses;
  const valid = amt !== null && name.length > 0 && name.length <= 40 && !full;
  const toggle = (p: string) => setExcluded((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  return (
    <form
      data-testid="expense-form"
      className="mt-4 flex flex-col gap-1.5 rounded-xl border border-dashed border-line tw-inset p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid || amt === null) return;
        const splitAmong = split.length > 0 ? split : undefined;
        const ok = await run({ op: 'expense_add', payer: name, amount: amt, ...(label.trim() ? { label: label.trim() } : {}), ...(splitAmong ? { splitAmong } : {}) });
        if (ok) {
          setLabel('');
          setAmount('');
        }
      }}
    >
      <div className="flex gap-1.5">
        <input aria-label="항목" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="항목 (예: 영화표)" className={`${toolInput} min-w-0 flex-1`} />
        <input aria-label="금액" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="금액(원)" className={`${toolInput} w-28`} />
      </div>
      <div className="flex items-center gap-1.5 text-xs text-muted">
        낸 사람
        <input aria-label="낸 사람" list="settle-people" value={payer} maxLength={40} onChange={(e) => setPayer(e.target.value)} className={`${toolInput} w-28`} />
        <datalist id="settle-people">
          {people.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </div>
      {people.length > 0 && (
        <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <legend className="sr-only">나눌 사람</legend>
          <span className="text-muted">나눌 사람</span>
          {people.map((p) => (
            <label key={p} className="flex items-center gap-1">
              <input type="checkbox" checked={split.includes(p)} onChange={() => toggle(p)} />
              {p}
            </label>
          ))}
        </fieldset>
      )}
      <div>
        <button type="submit" disabled={busy || !valid} className={toolBtnPrimary}>
          지출 추가
        </button>
        {full && <span className="ml-2 text-[11px] text-muted">지출은 최대 {BOARD_TOOL_LIMITS.expenses}건까지예요</span>}
      </div>
      <ToolError message={error} />
    </form>
  );
}

/** 정산표: 위에는 "누가 → 누구에게 얼마" 카드, 아래에는 영수증(지출 내역·1인당 몫). 편집은 구성원만, 결과는 항상 보인다. */
export function SettlementPanel({ tool, roomId, canEdit }: { tool: SettlementTool; roomId: string; canEdit: boolean }) {
  const result = settle(tool);
  const { busy, error, run } = useToolOp(roomId, tool.toolId);
  return (
    <div data-testid="settlement-panel">
      <section aria-label="정산 결과" data-testid="settle-result" className="mt-3 rounded-xl border p-3" style={{ borderColor: 'color-mix(in srgb, var(--tool) 45%, transparent)', background: 'color-mix(in srgb, var(--tool) 8%, transparent)' }}>
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-bold">정산 결과</h3>
          <span className="text-xs text-muted">총 {formatWon(result.total)}</span>
        </div>
        <ul data-testid="settle-transfers" className="mt-2 flex flex-col gap-1.5 text-sm">
          {result.transfers.length === 0 ? (
            <li className="text-muted">{tool.expenses.length === 0 ? '지출을 추가하면 계산해 드려요.' : '정산할 금액이 없어요.'}</li>
          ) : (
            result.transfers.map((t, i) => (
              <li key={i} className="flex items-center gap-2 rounded-lg tw-card px-3 py-2">
                <span className="min-w-0 truncate font-semibold">{t.from}</span>{' '}
                <span aria-hidden className="shrink-0 text-base leading-none text-[var(--tool-text)]">→</span>{' '}
                <span className="min-w-0 truncate font-semibold">{t.to}</span>
                <span className="ml-auto shrink-0 rounded-md bg-[var(--tool)] px-2 py-0.5 text-[13px] font-extrabold tabular-nums text-[var(--tool-ink)]">{formatWon(t.amount)}</span>
              </li>
            ))
          )}
        </ul>
      </section>

      <div className="tool-receipt mt-4">
        <div className="text-center">
          <div className="text-[10px] font-bold tracking-[0.35em] text-[#7b755f]">RECEIPT</div>
          <div className="mt-0.5 text-sm font-bold">{tool.title}</div>
        </div>
        <div className="my-2 border-t-2 border-dashed border-[#b9b29b]" />
        {tool.expenses.length === 0 ? (
          <p className="py-2 text-center text-sm text-[#6b6657]">아직 지출이 없어요.</p>
        ) : (
          <ul data-testid="expense-list" className="flex flex-col gap-1.5 text-sm">
            {tool.expenses.map((e) => (
              <li key={e.expenseId} data-expense-id={e.expenseId} className="flex items-start gap-1.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="min-w-0 truncate font-bold">{e.label || '지출'}</span>
                    <span aria-hidden className="mb-1 min-w-[12px] flex-1 border-b border-dotted border-[#9a937f]" />
                    <span className="shrink-0 font-bold tabular-nums">{formatWon(e.amount)}</span>
                  </div>
                  <div className="truncate text-[11px] text-[#6b6657]">
                    {e.payer} 결제 · 나눔: {e.splitAmong.join(', ')}
                  </div>
                </div>
                {canEdit && (
                  <button
                    type="button"
                    aria-label={`${e.label || '지출'} 삭제`}
                    disabled={busy}
                    onClick={() => void run({ op: 'expense_remove', expenseId: e.expenseId }, ['item_not_found'])}
                    className="rounded px-1.5 text-[#7b755f] hover:bg-black/10 hover:text-[#2b2f3a] disabled:opacity-40"
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="my-2 border-t-2 border-dashed border-[#b9b29b]" />
        <div className="flex items-baseline justify-between text-sm font-extrabold">
          <span>합계</span>
          <span className="tabular-nums">{formatWon(result.total)}</span>
        </div>
        {result.perPerson.length > 0 && (
          <table className="mt-2.5 w-full text-xs">
            <thead className="text-[#7b755f]">
              <tr>
                <th className="text-left font-normal">이름</th>
                <th className="text-right font-normal">낸 돈</th>
                <th className="text-right font-normal">몫</th>
              </tr>
            </thead>
            <tbody>
              {result.perPerson.map((p) => (
                <tr key={p.name}>
                  <td className="py-0.5 font-semibold">{p.name}</td>
                  <td className="text-right tabular-nums">{formatWon(p.paid)}</td>
                  <td className="text-right tabular-nums">{formatWon(p.owed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-3 text-center text-[10px] tracking-[0.3em] text-[#9a937f]">THANK YOU</div>
      </div>

      <ToolError message={error} />
      {canEdit ? <AddExpenseForm tool={tool} roomId={roomId} /> : <ViewOnlyNote className="mt-3" />}
    </div>
  );
}
