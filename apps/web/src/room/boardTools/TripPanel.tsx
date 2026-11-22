import { useState } from 'react';
import { BOARD_TOOL_LIMITS, type TripItem, type TripTool } from '@ensemble/shared';
import { ToolError, ViewOnlyNote, toolBtn, toolBtnPrimary, toolInput, useToolOp } from './common';

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

/** "1일차" 또는 시작일이 있으면 "1일차 · 5/3(토)" (순수 함수: UTC 기준이라 시간대에 안 흔들린다) */
export function tripDayLabel(startDate: string | null, day: number): string {
  if (!startDate) return `${day}일차`;
  const [y, m, d] = startDate.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + day - 1));
  return `${day}일차 · ${t.getUTCMonth() + 1}/${t.getUTCDate()}(${WEEK[t.getUTCDay()]})`;
}

/** 하루 일정 정렬: 시간이 있는 항목은 시간순, 시간 없는 항목은 뒤에(입력 순 유지) */
export function itemsOfDay(items: readonly TripItem[], day: number): TripItem[] {
  return items
    .map((it, i) => ({ it, i }))
    .filter((x) => x.it.day === day)
    .sort((a, b) => {
      if (a.it.time && b.it.time) return a.it.time.localeCompare(b.it.time) || a.i - b.i;
      if (a.it.time) return -1;
      if (b.it.time) return 1;
      return a.i - b.i;
    })
    .map((x) => x.it);
}

function AddItemForm({ tool, roomId, day }: { tool: TripTool; roomId: string; day: number }) {
  const [time, setTime] = useState('');
  const [place, setPlace] = useState('');
  const [memo, setMemo] = useState('');
  const { busy, error, run } = useToolOp(roomId, tool.toolId);
  const full = tool.items.length >= BOARD_TOOL_LIMITS.tripItems;
  return (
    <form
      data-testid="trip-item-form"
      className="mt-2 flex flex-wrap items-center gap-1.5"
      onSubmit={async (e) => {
        e.preventDefault();
        const p = place.trim();
        if (!p || full) return;
        const ok = await run({ op: 'trip_item_add', day, place: p, ...(time ? { time } : {}), ...(memo.trim() ? { memo: memo.trim() } : {}) });
        if (ok) {
          setPlace('');
          setMemo('');
          setTime('');
        }
      }}
    >
      <input type="time" aria-label="시간" value={time} onChange={(e) => setTime(e.target.value)} className={`${toolInput} w-[104px]`} />
      <input aria-label="장소" value={place} maxLength={60} onChange={(e) => setPlace(e.target.value)} placeholder="장소·할 일" className={`${toolInput} min-w-0 flex-1`} />
      <input aria-label="메모" value={memo} maxLength={120} onChange={(e) => setMemo(e.target.value)} placeholder="메모" className={`${toolInput} w-28`} />
      <button type="submit" disabled={busy || !place.trim() || full} className={toolBtnPrimary}>
        추가
      </button>
      <ToolError message={error} />
    </form>
  );
}

function Checklist({ tool, roomId, canEdit }: { tool: TripTool; roomId: string; canEdit: boolean }) {
  const [text, setText] = useState('');
  const { busy, error, run } = useToolOp(roomId, tool.toolId);
  const done = tool.checklist.filter((c) => c.done).length;
  const full = tool.checklist.length >= BOARD_TOOL_LIMITS.checklist;
  return (
    <section aria-label="준비물" data-testid="trip-checklist" className="tg-card mt-4 p-3">
      <div className="flex items-baseline gap-2">
        <h3 className="text-body font-bold">준비물</h3>
        <span className="text-aux text-muted">
          {done}/{tool.checklist.length}
        </span>
        <span aria-hidden className="prog ml-1 flex-1">
          <b style={{ width: `${tool.checklist.length ? Math.round((done / tool.checklist.length) * 100) : 0}%` }} />
        </span>
      </div>
      {tool.checklist.length === 0 ? (
        <p className="mt-1.5 text-aux text-muted">아직 준비물이 없어요.</p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1">
          {tool.checklist.map((c) => (
            <li key={c.checkId} data-check-id={c.checkId} className={`ck${c.done ? ' done' : ''}`}>
              <label className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  type="checkbox"
                  checked={c.done}
                  disabled={!canEdit || busy}
                  className="h-4 w-4 accent-[var(--tool)] disabled:cursor-not-allowed"
                  // 토글이 아니라 값 지정(check_set): 동시에 눌러도 마지막 값으로 수렴한다. 화면은 WS 이벤트로 바뀐다.
                  onChange={(e) => void run({ op: 'check_set', checkId: c.checkId, done: e.target.checked }, ['item_not_found'])}
                />
                <span className="tx truncate">{c.text}</span>
              </label>
              {canEdit && (
                <button
                  type="button"
                  aria-label={`${c.text} 삭제`}
                  disabled={busy}
                  onClick={() => void run({ op: 'check_remove', checkId: c.checkId }, ['item_not_found'])}
                  className="rounded px-1.5 text-muted hover:bg-raised hover:text-fg disabled:opacity-40"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form
          className="mt-2 flex gap-1.5"
          onSubmit={async (e) => {
            e.preventDefault();
            const t = text.trim();
            if (!t || full) return;
            if (await run({ op: 'check_add', text: t })) setText('');
          }}
        >
          <input aria-label="준비물 추가" value={text} maxLength={60} onChange={(e) => setText(e.target.value)} placeholder="준비물 추가" className={`${toolInput} min-w-0 flex-1`} />
          <button type="submit" disabled={busy || !text.trim() || full} className={toolBtn}>
            추가
          </button>
        </form>
      )}
      <ToolError message={error} />
    </section>
  );
}

/** 여행 계획: 일차 탭 → 그날 일정, 아래 준비물 체크리스트. 편집은 구성원만. */
export function TripPanel({ tool, roomId, canEdit }: { tool: TripTool; roomId: string; canEdit: boolean }) {
  const [day, setDay] = useState(1);
  const cur = Math.min(day, tool.days);
  const items = itemsOfDay(tool.items, cur);
  const { busy, error, run } = useToolOp(roomId, tool.toolId);
  return (
    <div data-testid="trip-panel">
      <div role="tablist" aria-label="일차" className="mt-3 flex gap-1 overflow-x-auto">
        {Array.from({ length: tool.days }, (_, i) => i + 1).map((d) => (
          <button
            key={d}
            type="button"
            role="tab"
            aria-selected={d === cur}
            onClick={() => setDay(d)}
            className={`tg-chip bt-kind shrink-0${d === cur ? ' on' : ''}`}
          >
            {tool.days > 1 || tool.startDate ? `${d}일차` : '일정'}
          </button>
        ))}
      </div>
      <p className="mt-3 flex items-baseline gap-2 text-body font-bold">
        <span style={{ color: 'var(--tool-text)' }}>{tripDayLabel(tool.startDate, cur)}</span>
        <span className="text-label font-normal text-muted">{items.length}곳</span>
      </p>
      {items.length === 0 ? (
        <p className="mt-1.5 rounded-xl border border-dashed border-line px-3 py-4 text-center text-body text-muted">이 날의 일정이 아직 없어요.</p>
      ) : (
        <ul data-testid="trip-items" className="tl-v mt-2">
          {items.map((it) => (
            <li key={it.itemId} data-item-id={it.itemId} className="it">
              <span className="tg-mono pt-[3px]">{it.time ?? '--:--'}</span>
              <i aria-hidden />
              <div className="min-w-0">
                <div className="truncate font-semibold">{it.place}</div>
                {it.memo && <div className="truncate text-aux text-muted">{it.memo}</div>}
              </div>
              {canEdit && (
                <button
                  type="button"
                  aria-label={`${it.place} 삭제`}
                  disabled={busy}
                  onClick={() => void run({ op: 'trip_item_remove', itemId: it.itemId }, ['item_not_found'])}
                  className="rounded px-1.5 text-muted hover:bg-raised hover:text-fg disabled:opacity-40"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ToolError message={error} />
      {canEdit ? <AddItemForm key={cur} tool={tool} roomId={roomId} day={cur} /> : <ViewOnlyNote className="mt-3" />}
      <Checklist tool={tool} roomId={roomId} canEdit={canEdit} />
    </div>
  );
}
