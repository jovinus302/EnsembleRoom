import { useState } from 'react';
import {
  BOARD_TOOL_KINDS,
  BOARD_TOOL_LABEL,
  BOARD_TOOL_LIMITS,
  visibleBoardTools,
  type BoardTool,
  type BoardToolKind,
  type CreateBoardToolRequest,
} from '@ensemble/shared';
import { api, boardToolErrorText } from '../../api/client';
import { useBoardToolUi } from '../../store/boardToolStore';
import type { RoomModel } from '../useRoomModel';
import { CustomPanel } from './CustomPanel';
import { ToolWindow } from './ToolWindow';
import { LadderPanel } from './LadderPanel';
import { SettlementPanel } from './SettlementPanel';
import { TripPanel } from './TripPanel';
import {
  TOOL_THEME,
  ToolArt,
  ToolBadge,
  ToolCover,
  ToolCreator,
  ToolError,
  ToolIcon,
  canEditTools,
  hasCover,
  toolBtn,
  toolBtnPrimary,
  toolInput,
  toolStatusLine,
  toolVars,
} from './common';

const split = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** "+ 도구" 폼: 종류 선택 → 제목(과 사다리는 참가자, 여행은 일수)만 받아 만든다. 나머지는 패널에서 채운다. */
function NewToolForm({ m, onDone }: { m: RoomModel; onDone: () => void }) {
  const [kind, setKind] = useState<BoardToolKind>('ladder');
  const [title, setTitle] = useState('');
  const defaultPeople = m.room.memberIds.map((id) => m.users[id]?.name).filter((x): x is string => !!x);
  const [people, setPeople] = useState(defaultPeople.join(', '));
  const [days, setDays] = useState(1);
  const [template, setTemplate] = useState<'checklist' | 'vote'>('checklist');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const L = BOARD_TOOL_LIMITS;

  const p = split(people);
  const ladderOk = kind !== 'ladder' || (p.length >= 2 && p.length <= L.participants);

  async function submit() {
    const t = title.trim() || BOARD_TOOL_LABEL[kind];
    let body: CreateBoardToolRequest;
    if (kind === 'ladder') body = { title: t, init: { kind, participants: p, outcomes: ['당첨'] } };
    else if (kind === 'settlement') body = { title: t, init: { kind } };
    else if (kind === 'custom') {
      // 빈 체크리스트/투표로 시작한다. 항목·선택지는 패널에서 채운다
      body = { title: t, init: { kind, blocks: [template === 'vote' ? { type: 'vote', question: title.trim() || '투표' } : { type: 'checklist', title: title.trim() || '할 일' }] } };
    } else body = { title: t, init: { kind, days } };
    setBusy(true);
    setError(null);
    try {
      const r = await api.createBoardTool(m.roomId, body);
      useBoardToolUi.getState().open(r.toolId);
      onDone();
    } catch (e) {
      setError(boardToolErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      data-testid="tool-new-form"
      className="mt-2 flex flex-col gap-1.5 tw-inset rounded-xl border border-line p-3"
      style={toolVars(kind)}
      onSubmit={(e) => {
        e.preventDefault();
        if (ladderOk) void submit();
      }}
    >
      <div className="flex gap-1.5" role="radiogroup" aria-label="도구 종류">
        {BOARD_TOOL_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            onClick={() => setKind(k)}
            style={kind === k ? { borderColor: TOOL_THEME[k].color, background: `${TOOL_THEME[k].color}22`, color: `color-mix(in srgb, ${TOOL_THEME[k].color} 60%, var(--fg))` } : undefined}
            className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs ${kind === k ? 'font-semibold' : 'border-line text-muted hover:bg-raised'}`}
          >
            <ToolIcon kind={k} size={14} />
            {BOARD_TOOL_LABEL[k]}
          </button>
        ))}
      </div>
      <input aria-label="도구 제목" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder={`제목 (비우면 ${BOARD_TOOL_LABEL[kind]})`} className={toolInput} />
      {kind === 'ladder' && (
        <input aria-label="참가자" value={people} onChange={(e) => setPeople(e.target.value)} placeholder="참가자 (쉼표로 구분, 2명 이상)" className={toolInput} />
      )}
      {kind === 'custom' && (
        <div className="flex gap-1.5" role="radiogroup" aria-label="메모판 시작 블록">
          {(['checklist', 'vote'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={template === k}
              onClick={() => setTemplate(k)}
              className={`rounded-md border px-2 py-1 text-xs ${template === k ? 'border-fg bg-raised' : 'border-line text-muted hover:bg-raised'}`}
            >
              {k === 'vote' ? '빈 투표' : '빈 체크리스트'}
            </button>
          ))}
        </div>
      )}
      {kind === 'trip' && (
        <label className="flex items-center gap-2 text-xs text-muted">
          일수
          <input
            type="number"
            aria-label="일수"
            min={1}
            max={L.tripDays}
            value={days}
            onChange={(e) => setDays(Math.max(1, Math.min(L.tripDays, Math.trunc(Number(e.target.value)) || 1)))}
            className={`${toolInput} w-16`}
          />
        </label>
      )}
      <div className="flex gap-1.5">
        <button type="submit" disabled={busy || !ladderOk} className={toolBtnPrimary}>
          올려놓기
        </button>
        <button type="button" onClick={onDone} className={toolBtn}>
          취소
        </button>
      </div>
      <ToolError message={error} />
    </form>
  );
}

/** 종류마다 살짝 다른 기울기(테이블에 아무렇게나 놓인 느낌). 호버하면 바로 서며 들린다. */
const TILT: Record<BoardTool['kind'], number> = { ladder: -1.2, settlement: 1, trip: -0.8, custom: 1.6 };

/**
 * 트레이의 도구 한 점. 종류별로 다른 물건 모양: 사다리=나무 판, 정산=영수증(톱니 끝), 여행=티켓(양옆 홈), 메모판=포스트잇(접힌 모서리).
 * 모양·색은 index.css의 .tool-shell-* 가 맡고, 여기서는 내용만 그린다.
 */
function ToolCard({ tool, m, index }: { tool: BoardTool; m: RoomModel; index: number }) {
  const open = useBoardToolUi((s) => s.open);
  return (
    <li className="tool-tile shrink-0" style={{ ...toolVars(tool.kind), ['--tilt' as string]: `${TILT[tool.kind]}deg`, animationDelay: `${Math.min(index, 6) * 70}ms` }}>
      <button
        type="button"
        data-testid="tool-card"
        data-tool-id={tool.toolId}
        data-tool-kind={tool.kind}
        onClick={() => open(tool.toolId)}
        className={`tool-shell tool-shell-${tool.kind} relative flex w-[196px] flex-col text-left`}
      >
        <span className="block h-[54px] w-full overflow-hidden">
          {hasCover(tool) ? <ToolCover tool={tool} height={54} /> : <ToolArt kind={tool.kind} />}
        </span>
        {tool.kind === 'custom' && <span aria-hidden className="tool-pin" />}
        <span className="flex flex-col gap-0.5 px-2.5 pb-2.5 pt-2">
          <span className="flex items-center gap-1.5 text-[10.5px] font-semibold tracking-wide" style={{ color: 'var(--tool-label)' }}>
            <ToolIcon kind={tool.kind} size={13} />
            {BOARD_TOOL_LABEL[tool.kind]}
          </span>
          <span className="truncate text-[14px] font-bold leading-snug">{tool.title}</span>
          <span data-testid="tool-status" className="truncate text-xs font-medium tabular-nums" style={{ color: 'var(--tool-status)' }}>
            {toolStatusLine(tool)}
          </span>
          <span className="mt-1 border-t border-dashed pt-1.5" style={{ borderColor: 'var(--tool-rule)' }}>
            <ToolCreator tool={tool} m={m} compact made />
          </span>
        </span>
      </button>
    </li>
  );
}

/** 보드 위쪽 도구 트레이. Agent가 만들어 올려놓은 도구와 사람이 만든 도구가 테이블 위 물건처럼 놓인다. */
export function BoardToolStrip({ model }: { model: RoomModel }) {
  const [adding, setAdding] = useState(false);
  const tools = visibleBoardTools(model.state);
  const canEdit = canEditTools(model);
  if (tools.length === 0 && !canEdit) return null;
  return (
    <div data-testid="tool-strip" className="px-5 pb-2">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold text-muted">보드 도구</h3>
        <span className="rounded-full tw-inset px-1.5 text-[11px] text-muted">{tools.length}개</span>
        {canEdit && !adding && (
          <button type="button" data-testid="tool-new" onClick={() => setAdding(true)} className="ml-auto rounded-md border border-dashed border-line px-2.5 py-1 text-xs text-muted hover:bg-raised hover:text-fg">
            + 도구
          </button>
        )}
      </div>
      {adding && canEdit && <NewToolForm m={model} onDone={() => setAdding(false)} />}
      {tools.length > 0 && (
        <div className="tool-tray mt-1.5">
          <ul className="flex gap-3.5 overflow-x-auto px-3 pb-3 pt-3">
            {tools.map((t, i) => (
              <ToolCard key={t.toolId} tool={t} m={model} index={i} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ToolBody({ tool, m, canEdit }: { tool: BoardTool; m: RoomModel; canEdit: boolean }) {
  switch (tool.kind) {
    case 'ladder':
      return <LadderPanel tool={tool} roomId={m.roomId} canEdit={canEdit} />;
    case 'settlement':
      return <SettlementPanel tool={tool} roomId={m.roomId} canEdit={canEdit} />;
    case 'trip':
      return <TripPanel tool={tool} roomId={m.roomId} canEdit={canEdit} />;
    case 'custom':
      return <CustomPanel tool={tool} roomId={m.roomId} canEdit={canEdit} meId={m.meId} />;
  }
}

/** openToolId 패널 호스트(Sheet). 2D 카드와 3D 소품 클릭이 모두 store로 연다. */
export function BoardToolHost({ model }: { model: RoomModel }) {
  const openToolId = useBoardToolUi((s) => s.openToolId);
  const close = useBoardToolUi((s) => s.close);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const tool = openToolId ? model.state.boardTools[openToolId] : undefined;
  if (!tool || tool.removed) return null;
  const canEdit = canEditTools(model);
  return (
    <ToolWindow
      title={`${BOARD_TOOL_LABEL[tool.kind]} · ${tool.title}`}
      onClose={close}
      testId="tool-sheet"
      style={{ ...toolVars(tool.kind), }}
      header={
        <header
          className="rounded-t-2xl"
          style={{
            
            borderBottom: '1px solid var(--bt-hdr-rule)',
          }}
        >
          <div className="flex items-center gap-3 px-4 py-3">
            <ToolBadge kind={tool.kind} size={38} />
            <div className="min-w-0 flex-1">
              <div className="text-[10.5px] font-semibold tracking-wide" style={{ color: 'var(--tool-text)' }}>
                {BOARD_TOOL_LABEL[tool.kind]}
              </div>
              <h2 className="truncate text-lg font-bold leading-tight">{tool.title}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <ToolCreator tool={tool} m={model} made />
                <span className="text-[11px] tabular-nums" style={{ color: 'var(--muted)' }}>· {toolStatusLine(tool)}</span>
              </div>
            </div>
            <button
              type="button"
              aria-label="닫기"
              onClick={close}
              className="self-start rounded-lg tw-inset px-2 py-0.5 text-lg leading-none"
              style={{ color: 'var(--fg)' }}
            >
              ×
            </button>
          </div>
          {hasCover(tool) && (
            <div className="px-4 pb-3">
              <ToolCover tool={tool} height={tool.kind === 'trip' ? 112 : 64} />
            </div>
          )}
        </header>
      }
    >
      <div className="bt-glass m-3 rounded-2xl p-4">
      <ToolBody key={tool.toolId} tool={tool} m={model} canEdit={canEdit} />
      {canEdit && (
        <div className="mt-4 flex items-center gap-2 border-t border-line pt-3">
          {!confirmRemove ? (
            <button type="button" data-testid="tool-remove" onClick={() => setConfirmRemove(true)} className={toolBtn}>
              도구 내리기
            </button>
          ) : (
            <>
              <span className="text-xs text-muted">보드에서 내릴까요?</span>
              <button
                type="button"
                data-testid="tool-remove-confirm"
                disabled={removing}
                onClick={async () => {
                  setRemoving(true);
                  setRemoveError(null);
                  try {
                    await api.removeBoardTool(model.roomId, tool.toolId);
                    close();
                  } catch (e) {
                    setRemoveError(boardToolErrorText(e));
                    setConfirmRemove(false);
                  } finally {
                    setRemoving(false);
                  }
                }}
                className={toolBtnPrimary}
              >
                내리기
              </button>
              <button type="button" onClick={() => setConfirmRemove(false)} className={toolBtn}>
                취소
              </button>
            </>
          )}
        </div>
      )}
      <ToolError message={removeError} />
      </div>
    </ToolWindow>
  );
}
