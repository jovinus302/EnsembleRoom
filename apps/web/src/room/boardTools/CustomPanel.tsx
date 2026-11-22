import { useState } from 'react';
import {
  BOARD_TOOL_LIMITS,
  voteTally,
  type ChecklistBlock,
  type CounterBlock,
  type CustomBlock,
  type CustomBlockType,
  type CustomTool,
  type TextBlock,
  type VoteBlock,
} from '@ensemble/shared';
import { ToolError, ViewOnlyNote, toolBtn, toolBtnPrimary, toolInput, useToolOp } from './common';

/**
 * 자유형(custom) 도구 패널. 고정 4종 블록(text / checklist / vote / counter)만 그린다.
 * 모든 문자열은 React 텍스트 노드로만 출력한다(HTML·URL·스타일 주입 표면 없음, dangerouslySetInnerHTML 금지).
 * 낙관적 업데이트 없음: 요청 중엔 busy, 화면은 WS 이벤트로 바뀐다. 투표는 사람당 1표 — 서버가 actor userId로 판정한다.
 */

const L = BOARD_TOOL_LIMITS;
const BLOCK_LABEL: Record<CustomBlockType, string> = { text: '글', checklist: '체크리스트', vote: '투표', counter: '카운터' };
const gone = ['item_not_found'] as const;

interface Ctx {
  roomId: string;
  toolId: string;
  canEdit: boolean;
  meId: string;
}

function BlockShell({ block, ctx, children, title, paper = false }: { block: CustomBlock; ctx: Ctx; title?: string; children: React.ReactNode; paper?: boolean }) {
  const { busy, error, run } = useToolOp(ctx.roomId, ctx.toolId);
  return (
    <section
      data-testid="custom-block"
      data-block-id={block.blockId}
      data-block-type={block.type}
      className={`tg-card bt-block relative p-3 pt-4${paper ? ' note' : ''}`}
    >
      <div className="flex items-baseline gap-2">
        <span
          className="tg-chip tonal"
          style={{ '--c': 'var(--tool)' } as React.CSSProperties}
        >
          {BLOCK_LABEL[block.type]}
        </span>
        {title && <h3 className="min-w-0 flex-1 truncate text-body font-bold">{title}</h3>}
        {!title && <span className="flex-1" />}
        {ctx.canEdit && (
          <button
            type="button"
            aria-label={`${BLOCK_LABEL[block.type]} 블록 삭제`}
            data-testid="custom-block-remove"
            disabled={busy}
            onClick={() => void run({ op: 'block_remove', blockId: block.blockId }, gone)}
            className="rounded px-1.5 text-muted hover:bg-raised hover:text-fg disabled:opacity-40"
          >
            ×
          </button>
        )}
      </div>
      {children}
      <ToolError message={error} />
    </section>
  );
}

function TextView({ block, ctx }: { block: TextBlock; ctx: Ctx }) {
  return (
    <BlockShell block={block} ctx={ctx} paper>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-body font-medium leading-relaxed">{block.text}</p>
    </BlockShell>
  );
}

function ChecklistView({ block, ctx }: { block: ChecklistBlock; ctx: Ctx }) {
  const [text, setText] = useState('');
  const { busy, error, run } = useToolOp(ctx.roomId, ctx.toolId);
  const done = block.items.filter((c) => c.done).length;
  const full = block.items.length >= L.customChecklist;
  return (
    <BlockShell block={block} ctx={ctx} title={block.title}>
      <div className="flex items-center gap-2 text-aux text-muted">
        <span>
          {done}/{block.items.length}
        </span>
        <span aria-hidden className="prog flex-1">
          <b style={{ width: `${block.items.length ? Math.round((done / block.items.length) * 100) : 0}%` }} />
        </span>
      </div>
      {block.items.length === 0 ? (
        <p className="mt-1 text-aux text-muted">아직 항목이 없어요.</p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1">
          {block.items.map((c) => (
            <li key={c.checkId} data-check-id={c.checkId} className={`ck${c.done ? " done" : ""}`}>
              <label className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  type="checkbox"
                  checked={c.done}
                  disabled={!ctx.canEdit || busy}
                  className="h-4 w-4 accent-[var(--tool)] disabled:cursor-not-allowed"
                  // 토글이 아니라 값 지정: 동시에 눌러도 마지막 값으로 수렴한다
                  onChange={(e) => void run({ op: 'block_check_set', blockId: block.blockId, checkId: c.checkId, done: e.target.checked }, gone)}
                />
                <span className="tx truncate">{c.text}</span>
              </label>
              {ctx.canEdit && (
                <button
                  type="button"
                  aria-label={`${c.text} 삭제`}
                  disabled={busy}
                  onClick={() => void run({ op: 'block_check_remove', blockId: block.blockId, checkId: c.checkId }, gone)}
                  className="rounded px-1.5 text-muted hover:bg-raised hover:text-fg disabled:opacity-40"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {ctx.canEdit && (
        <form
          className="mt-2 flex gap-1.5"
          onSubmit={async (e) => {
            e.preventDefault();
            const t = text.trim();
            if (!t || full) return;
            if (await run({ op: 'block_check_add', blockId: block.blockId, text: t })) setText('');
          }}
        >
          <input aria-label="항목 추가" value={text} maxLength={60} onChange={(e) => setText(e.target.value)} placeholder="항목 추가" className={`${toolInput} min-w-0 flex-1`} />
          <button type="submit" disabled={busy || !text.trim() || full} className={toolBtn}>
            추가
          </button>
        </form>
      )}
      <ToolError message={error} />
    </BlockShell>
  );
}

function VoteView({ block, ctx }: { block: VoteBlock; ctx: Ctx }) {
  const [text, setText] = useState('');
  const { busy, error, run } = useToolOp(ctx.roomId, ctx.toolId);
  const tally = voteTally(block);
  const total = Object.keys(block.votes).length;
  const top = Math.max(0, ...Object.values(tally));
  const mine = block.votes[ctx.meId] ?? null;
  const full = block.options.length >= L.customVoteOptions;
  return (
    <BlockShell block={block} ctx={ctx} title={block.question}>
      <p className="text-aux text-muted">{total}표 · 한 사람당 한 표, 다시 누르면 바꿀 수 있어요</p>
      {block.options.length === 0 ? (
        <p className="mt-1 text-aux text-muted">아직 선택지가 없어요.{ctx.canEdit ? ' 아래에서 추가해 주세요.' : ''}</p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {block.options.map((o) => {
            const n = tally[o.optionId] ?? 0;
            const selected = mine === o.optionId;
            return (
              <li key={o.optionId} data-option-id={o.optionId} data-selected={selected} className="flex items-center gap-1.5">
                <button
                  type="button"
                  data-testid="vote-option"
                  aria-pressed={selected}
                  disabled={!ctx.canEdit || busy}
                  onClick={() => void run({ op: 'vote_cast', blockId: block.blockId, optionId: o.optionId }, gone)}
                  className={`relative min-w-0 flex-1 overflow-hidden rounded-lg border tw-inset px-2.5 py-2 text-left text-body disabled:cursor-not-allowed disabled:opacity-70 ${selected ? 'border-[var(--tool)]' : 'border-line enabled:hover:border-[var(--tool)]'}`}
                >
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 rounded-r-md transition-[width]"
                    style={{
                      width: `${total > 0 ? Math.round((n / total) * 100) : 0}%`,
                      background: `color-mix(in srgb, var(--tool) ${n > 0 && n === top ? 55 : 28}%, transparent)`,
                    }}
                  />
                  <span className="relative flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">{o.text}</span>
                    <span className="text-aux font-bold tabular-nums">{n}표</span>
                    {selected && <span className="rounded bg-[var(--tool)] px-1 text-label font-bold text-[var(--tool-ink)]">내 표</span>}
                  </span>
                </button>
                {ctx.canEdit && (
                  <button
                    type="button"
                    aria-label={`${o.text} 선택지 삭제`}
                    disabled={busy}
                    onClick={() => void run({ op: 'vote_option_remove', blockId: block.blockId, optionId: o.optionId }, gone)}
                    className="rounded px-1.5 text-muted hover:bg-raised hover:text-fg disabled:opacity-40"
                  >
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {ctx.canEdit && (
        <form
          className="mt-2 flex gap-1.5"
          onSubmit={async (e) => {
            e.preventDefault();
            const t = text.trim();
            if (!t || full) return;
            if (await run({ op: 'vote_option_add', blockId: block.blockId, text: t })) setText('');
          }}
        >
          <input aria-label="선택지 추가" value={text} maxLength={L.customOptionChars} onChange={(e) => setText(e.target.value)} placeholder="선택지 추가" className={`${toolInput} min-w-0 flex-1`} />
          <button type="submit" disabled={busy || !text.trim() || full} className={toolBtn}>
            추가
          </button>
        </form>
      )}
      <ToolError message={error} />
    </BlockShell>
  );
}

function CounterView({ block, ctx }: { block: CounterBlock; ctx: Ctx }) {
  const { busy, error, run } = useToolOp(ctx.roomId, ctx.toolId);
  const atMin = block.min !== null && block.value <= block.min;
  const atMax = block.max !== null && block.value >= block.max;
  return (
    <BlockShell block={block} ctx={ctx} title={block.label}>
      <div className="mt-2 flex items-center justify-center gap-3 rounded-xl tw-inset py-2">
        <button type="button" aria-label="하나 줄이기" data-testid="counter-dec" disabled={!ctx.canEdit || busy || atMin} onClick={() => void run({ op: 'counter_add', blockId: block.blockId, delta: -1 }, gone)} className={`${toolBtn} h-9 w-9 rounded-full text-title`}>
          −
        </button>
        <span data-testid="counter-value" className="min-w-[3.5rem] text-center text-3xl font-extrabold tabular-nums text-[var(--tool-text)]">
          {block.value}
        </span>
        <button type="button" aria-label="하나 늘리기" data-testid="counter-inc" disabled={!ctx.canEdit || busy || atMax} onClick={() => void run({ op: 'counter_add', blockId: block.blockId, delta: 1 }, gone)} className={`${toolBtn} h-9 w-9 rounded-full text-title`}>
          +
        </button>
        {(block.min !== null || block.max !== null) && (
          <span className="text-label text-muted">
            {block.min ?? '…'} ~ {block.max ?? '…'}
          </span>
        )}
      </div>
      <ToolError message={error} />
    </BlockShell>
  );
}

function BlockView({ block, ctx }: { block: CustomBlock; ctx: Ctx }) {
  switch (block.type) {
    case 'text':
      return <TextView block={block} ctx={ctx} />;
    case 'checklist':
      return <ChecklistView block={block} ctx={ctx} />;
    case 'vote':
      return <VoteView block={block} ctx={ctx} />;
    case 'counter':
      return <CounterView block={block} ctx={ctx} />;
  }
}

function AddBlockForm({ tool, roomId }: { tool: CustomTool; roomId: string }) {
  const [type, setType] = useState<CustomBlockType>('checklist');
  const [text, setText] = useState('');
  const { busy, error, run } = useToolOp(roomId, tool.toolId);
  const full = tool.blocks.length >= L.customBlocks;
  const placeholder = { text: '내용', checklist: '체크리스트 제목', vote: '투표 질문', counter: '카운터 이름' }[type];
  return (
    <form
      data-testid="custom-add-form"
      className="mt-3 flex flex-wrap items-center gap-1.5 tg-card p-2.5"
      onSubmit={async (e) => {
        e.preventDefault();
        const t = text.trim();
        if (!t || full) return;
        const block =
          type === 'text'
            ? ({ type, text: t } as const)
            : type === 'checklist'
              ? ({ type, title: t } as const)
              : type === 'vote'
                ? ({ type, question: t } as const)
                : ({ type, label: t } as const);
        if (await run({ op: 'block_add', block })) setText('');
      }}
    >
      <select aria-label="블록 종류" value={type} onChange={(e) => setType(e.target.value as CustomBlockType)} className={toolInput}>
        {(Object.keys(BLOCK_LABEL) as CustomBlockType[]).map((k) => (
          <option key={k} value={k}>
            {BLOCK_LABEL[k]}
          </option>
        ))}
      </select>
      <input
        aria-label="블록 내용"
        value={text}
        maxLength={type === 'text' ? L.customTextChars : L.customLabelChars}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        className={`${toolInput} min-w-0 flex-1`}
      />
      <button type="submit" disabled={busy || !text.trim() || full} className={toolBtnPrimary}>
        블록 추가
      </button>
      {full && <span className="text-label text-muted">블록은 {L.customBlocks}개까지예요</span>}
      <ToolError message={error} />
    </form>
  );
}

/** 자유형 메모판: 글·체크리스트·투표·카운터 블록. 편집(체크·투표·카운터 포함)은 구성원만, 방문자는 보기만. */
export function CustomPanel({ tool, roomId, canEdit, meId }: { tool: CustomTool; roomId: string; canEdit: boolean; meId: string }) {
  const ctx: Ctx = { roomId, toolId: tool.toolId, canEdit, meId };
  return (
    <div data-testid="custom-panel" className="mt-4 flex flex-col gap-4">
      {tool.blocks.length === 0 ? (
        <p className="text-body text-muted">블록이 없어요.</p>
      ) : (
        tool.blocks.map((b) => <BlockView key={b.blockId} block={b} ctx={ctx} />)
      )}
      {canEdit ? <AddBlockForm tool={tool} roomId={roomId} /> : <ViewOnlyNote />}
    </div>
  );
}
