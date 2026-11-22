import { useState, type CSSProperties } from 'react';
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
import { btn } from '../../ui/tg';
import type { RoomModel } from '../useRoomModel';
import { CustomPanel } from './CustomPanel';
import { ToolWindow } from './ToolWindow';
import { LadderPanel } from './LadderPanel';
import { SettlementPanel } from './SettlementPanel';
import { TripPanel } from './TripPanel';
import {
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

/** "+ 도구" 폼: 종류 선택 → 제목(과 사다리는 참가자, 여행은 일수)만 받아 만든다. 나머지는 패널에서 채운다. 보드 카드 줄의 첫 칸에 놓인다. */
export function NewToolForm({ m, onDone }: { m: RoomModel; onDone: () => void }) {
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
      className="tg-card bcard add"
      style={toolVars(kind)}
      onSubmit={(e) => {
        e.preventDefault();
        if (ladderOk) void submit();
      }}
    >
      <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="도구 종류">
        {BOARD_TOOL_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            onClick={() => setKind(k)}
            style={toolVars(k)}
            className={`tg-chip bt-kind${kind === k ? ' on' : ''}`}
          >
            <ToolIcon kind={k} size={14} />
            {BOARD_TOOL_LABEL[k]}
          </button>
        ))}
        {kind === 'custom' && (
          <span role="radiogroup" aria-label="메모판 시작 블록" className="flex gap-1.5">
            {(['checklist', 'vote'] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={template === k} onClick={() => setTemplate(k)} className={`tg-chip bt-kind${template === k ? ' on' : ''}`}>
                {k === 'vote' ? '빈 투표' : '빈 체크리스트'}
              </button>
            ))}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <input aria-label="도구 제목" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder={`제목 (비우면 ${BOARD_TOOL_LABEL[kind]})`} className={`${toolInput} min-w-0 flex-1`} />
        {kind === 'ladder' && (
          <input aria-label="참가자" value={people} onChange={(e) => setPeople(e.target.value)} placeholder="참가자 (쉼표로 구분, 2명 이상)" className={`${toolInput} min-w-0 flex-1`} />
        )}
        {kind === 'trip' && (
          <label className="flex shrink-0 items-center gap-2 text-aux text-muted">
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
        <button type="button" onClick={onDone} className={toolBtn}>
          취소
        </button>
        <button type="submit" disabled={busy || !ladderOk} className={toolBtnPrimary}>
          올려놓기
        </button>
      </div>
      <ToolError message={error} />
    </form>
  );
}

/** 보드 헤더 줄의 도구 pill. 종류 색 점 + 제목 + 상태. 누르면 도구 창이 열린다(3D 소품 클릭도 같은 store로 연다). */
function ToolPill({ tool, m }: { tool: BoardTool; m: RoomModel }) {
  const open = useBoardToolUi((s) => s.open);
  return (
    <li className="shrink-0">
      <button
        type="button"
        data-testid="tool-card"
        data-tool-id={tool.toolId}
        data-tool-kind={tool.kind}
        title={`${BOARD_TOOL_LABEL[tool.kind]} · ${tool.title}`}
        onClick={() => open(tool.toolId)}
        style={toolVars(tool.kind)}
        className={`${btn('ghost')} bt-pill`}
      >
        <span className="tg-kdot" />
        <span className="max-w-[120px] truncate">{tool.title}</span>
        <span data-testid="tool-status" className="tg-mono max-w-[140px] truncate" style={{ textTransform: 'none' }}>
          {toolStatusLine(tool)}
        </span>
        <span className="sr-only">
          <ToolCreator tool={tool} m={m} compact made />
        </span>
      </button>
    </li>
  );
}

/** 보드 헤더 줄의 도구 pill 모음. 도구가 없으면 아무것도 그리지 않는다(만들기 버튼은 BoardPanel이 그린다). */
export function BoardToolStrip({ model }: { model: RoomModel }) {
  const tools = visibleBoardTools(model.state);
  if (tools.length === 0) return null;
  return (
    <ul data-testid="tool-strip" aria-label="보드 도구" className="bt-pills">
      {tools.map((t) => (
        <ToolPill key={t.toolId} tool={t} m={model} />
      ))}
    </ul>
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

/** openToolId 패널 호스트(도구 창). 2D pill과 3D 소품 클릭이 모두 store로 연다. */
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
      style={toolVars(tool.kind)}
      header={
        <>
          <div className="th">
            <span className="tg-chip tonal" style={{ '--c': 'var(--tool)' } as CSSProperties}>
              {BOARD_TOOL_LABEL[tool.kind]}
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-body font-semibold leading-tight">{tool.title}</h2>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <ToolCreator tool={tool} m={model} made />
                <span className="tg-mono" style={{ textTransform: 'none' }}>
                  · {toolStatusLine(tool)}
                </span>
              </div>
            </div>
            <button type="button" aria-label="닫기" onClick={close} className={btn('ghost', { round: true })}>
              ✕
            </button>
          </div>
          {hasCover(tool) && (tool.cover?.status === 'ready' || tool.cover?.status === 'pending') && (
            <div className="px-5 pt-4">
              <ToolCover tool={tool} height={tool.kind === 'trip' ? 96 : 56} />
            </div>
          )}
        </>
      }
    >
      <div className="tb">
        <ToolBody key={tool.toolId} tool={tool} m={model} canEdit={canEdit} />
        {canEdit && (
          <div className="flex items-center gap-2 border-t border-line pt-3">
            {!confirmRemove ? (
              <button type="button" data-testid="tool-remove" onClick={() => setConfirmRemove(true)} className={toolBtn}>
                도구 내리기
              </button>
            ) : (
              <>
                <span className="text-aux text-muted">보드에서 내릴까요?</span>
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
