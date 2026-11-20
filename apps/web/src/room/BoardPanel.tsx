import { useEffect, useRef, useState } from 'react';
import { ringGradientStops, visibleCards, type BoardCard, type OwnerTag } from '@ensemble/shared';
import { api, ApiError } from '../api/client';
import { FALLBACK_COLOR } from '../messenger/agentIdentity';
import type { RoomModel } from './useRoomModel';
import { BoardToolHost, BoardToolStrip, NewToolForm } from './boardTools/BoardToolStrip';
import { canEditTools } from './boardTools/common';
import { btn, cvar } from '../ui/tg';
import { ink } from '../theme';

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'needs_decision_approval') return '합의된 카드는 결정 승인을 거쳐야 수정할 수 있어요.';
    return e.message;
  }
  return '요청에 실패했습니다';
}

/** 카드 소유 표시: user:<id>는 그 사람 색, agent:<id>는 Agent 소유자 색(점선), ours는 구성원 색 그라데이션 */
function ownerStyle(tag: OwnerTag, m: RoomModel): { label: string; color: string; ours: boolean; dashed: boolean; ring: string[] } {
  if (tag === 'ours') {
    const colors = m.room.memberIds.map((id) => m.users[id]?.color).filter((c): c is string => !!c);
    return { label: '우리 카드', color: colors[0] ?? FALLBACK_COLOR, ours: true, dashed: false, ring: ringGradientStops(colors.length ? colors : [FALLBACK_COLOR]) };
  }
  if (tag.startsWith('user:')) {
    const id = tag.slice(5);
    const u = m.users[id];
    const color = u?.color ?? FALLBACK_COLOR;
    return { label: id === m.meId ? '내 카드' : `${u?.name ?? '누군가'}의 카드`, color, ours: false, dashed: false, ring: [color] };
  }
  const a = m.resolveAgent(tag.slice(6));
  return { label: `${a.name}의 카드`, color: a.color, ours: false, dashed: true, ring: [a.color] };
}

function CommentForm({ roomId, cardId, disabled }: { roomId: string; cardId: string; disabled: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="mt-2 flex gap-1.5"
      onSubmit={async (e) => {
        e.preventDefault();
        const t = text.trim();
        if (!t || disabled) return;
        setBusy(true);
        setError(null);
        try {
          await api.addComment(roomId, cardId, t);
          setText('');
        } catch (err) {
          setError(errText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        data-testid="comment-input"
        aria-label="댓글"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        placeholder={disabled ? '재생 중에는 쓸 수 없어요' : '댓글 달기'}
        className="tg-field bc-in min-w-0 flex-1 disabled:opacity-50"
      />
      <button type="submit" disabled={disabled || busy || !text.trim()} className={`${btn('soft')} bc-btn`}>
        등록
      </button>
      {error && (
        <span role="alert" className="basis-full text-label text-danger">
          {error}
        </span>
      )}
    </form>
  );
}

function EditForm({ roomId, card, onDone }: { roomId: string; card: BoardCard; onDone: () => void }) {
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="mt-2 flex flex-col gap-1.5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api.patchCard(roomId, card.cardId, { title: title.trim() || card.title, body }, card.version);
          onDone();
        } catch (err) {
          setError(errText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <input aria-label="카드 제목" value={title} onChange={(e) => setTitle(e.target.value)} className="tg-field bc-in" />
      <textarea aria-label="카드 내용" value={body} rows={3} onChange={(e) => setBody(e.target.value)} className="tg-field bc-in resize-none" />
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={onDone} className={`${btn('ghost')} bc-btn`}>
          취소
        </button>
        <button type="submit" disabled={busy} className={`${btn('primary')} bc-btn`}>
          저장
        </button>
      </div>
      {error && (
        <p role="alert" className="text-label text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

function Card({ card, m }: { card: BoardCard; m: RoomModel }) {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [pointTo, setPointTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const o = ownerStyle(card.ownerTag, m);
  const nameOfActor = (kind: string, id: string | null) =>
    kind === 'human' ? (m.users[id ?? '']?.name ?? '누군가') : kind === 'system' ? '시스템' : m.resolveAgent(id).name;
  const colorOfActor = (kind: string, id: string | null) =>
    kind === 'human' ? (m.users[id ?? '']?.color ?? FALLBACK_COLOR) : m.resolveAgent(id).color;
  const askable = m.agents.filter((a) => !a.visiting && a.state.mode !== 'traveling');
  const expanded = open || editing;
  const liRef = useRef<HTMLLIElement>(null);
  // 184px 안이라 펼친 내용(댓글·입력)이 접힌 부분 아래에 있다: 펼치면 카드 안에서 맨 아래로 내려 보여 준다
  useEffect(() => {
    if (expanded && liRef.current) liRef.current.scrollTop = liRef.current.scrollHeight;
  }, [expanded]);

  return (
    <li
      ref={liRef}
      data-testid="board-card"
      data-owner={card.ownerTag}
      data-ours={o.ours ? 'true' : 'false'}
      data-agreed={card.agreed ? 'true' : 'false'}
      data-open={expanded ? 'true' : 'false'}
      className={`tg-card bcard${o.dashed ? ' dashed' : ''}${card.agreed ? ' agreed' : ''}${expanded ? ' open' : ''}`}
      style={cvar(o.color)}
    >
      <div className="r">
        <span className="tg-chip tonal" style={cvar(o.color)}>
          {o.ours ? '✦ ' : ''}
          {o.label}
        </span>
        <span className="flex items-center gap-2">
          <span className="tg-mono">
            V{card.version}
            {card.agreed ? ' · 합의' : ''}
          </span>
          {!m.replaying && !editing && (
            <button
              type="button"
              data-testid="card-edit"
              onClick={() => {
                setOpen(true);
                setEditing(true);
              }}
              className="text-aux text-muted underline-offset-2 hover:text-fg hover:underline"
            >
              수정
            </button>
          )}
        </span>
      </div>
      {editing ? (
        <EditForm roomId={m.roomId} card={card} onDone={() => setEditing(false)} />
      ) : (
        <>
          <h3 className="t">{card.title}</h3>
          {card.body && <p className="b">{card.body}</p>}
        </>
      )}
      <div className="r mt-auto">
        <button type="button" aria-expanded={expanded} onClick={() => setOpen((v) => !v)} className="tg-mono hover:text-fg">
          댓글 {card.comments.length}
          <span aria-hidden="true"> {expanded ? '▴' : '▾'}</span>
        </button>
        {card.agreed && (
          <span data-testid="agreed-pin" title="합의된 카드" className="tg-chip badge-ok">
            합의
          </span>
        )}
      </div>

      {expanded && (
        <>
          {card.comments.length > 0 && (
            <ul className="mt-1 flex flex-col gap-1 border-t border-line pt-2" data-testid="card-comments">
              {card.comments.map((c) => (
                <li key={c.seq} className="text-aux leading-relaxed">
                  <span className="font-semibold" style={{ color: ink(colorOfActor(c.actorKind, c.actorId)) }}>
                    {nameOfActor(c.actorKind, c.actorId)}
                  </span>{' '}
                  <span className="text-fg/85">{c.text}</span>
                </li>
              ))}
            </ul>
          )}
          <CommentForm roomId={m.roomId} cardId={card.cardId} disabled={m.replaying} />
          {!m.replaying && askable.length > 0 && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <select aria-label="카드를 보여 줄 Agent" value={pointTo} onChange={(e) => setPointTo(e.target.value)} className="tg-field bc-in min-w-0 flex-1">
                <option value="">Agent에게 보여 주기…</option>
                {askable.map((a) => (
                  <option key={a.agentId} value={a.agentId}>
                    {a.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!pointTo}
                onClick={async () => {
                  setError(null);
                  try {
                    await api.pointCard(m.roomId, card.cardId, pointTo);
                    setPointTo('');
                  } catch (e) {
                    setError(errText(e));
                  }
                }}
                className={`${btn('soft')} bc-btn`}
              >
                보여 주기
              </button>
            </div>
          )}
          {error && (
            <p role="alert" className="mt-1 text-label text-danger">
              {error}
            </p>
          )}
        </>
      )}
    </li>
  );
}

function NewCardForm({ m, onDone }: { m: RoomModel; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="bform">
      <form
        className="tg-card bcard add"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim()) return;
          setBusy(true);
          setError(null);
          try {
            await api.createCard(m.roomId, {
              title: title.trim(),
              body,
              ownerTag: m.room.kind === 'our' ? 'ours' : `user:${m.meId}`,
            });
            onDone();
          } catch (err) {
            setError(errText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex gap-2">
          <input
            data-testid="card-new-title"
            aria-label="새 카드 제목"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="새 카드 제목"
            className="tg-field bc-in min-w-0 flex-1"
          />
          <input aria-label="새 카드 내용" value={body} onChange={(e) => setBody(e.target.value)} placeholder="내용" className="tg-field bc-in min-w-0 flex-[1.4]" />
        </div>
        <div className="r">
          <span className="tg-mono">카드 추가</span>
          <span className="flex gap-1.5">
            <button type="button" onClick={onDone} className={`${btn('ghost')} bc-btn`}>
              취소
            </button>
            <button type="submit" disabled={busy || !title.trim()} className={`${btn('primary')} bc-btn`}>
              추가
            </button>
          </span>
        </div>
        {error && (
          <p role="alert" className="text-label text-danger">
            {error}
          </p>
        )}
      </form>
    </li>
  );
}

/**
 * 보드. 카드 색은 owner_tag를 따른다: 사람 카드 = 그 사람 색 칩·테두리, Agent 카드 = 소유자 색 점선 테두리,
 * 우리 카드 = ✦ 칩, 합의된 카드 = 초록 테두리와 합의 칩. 3D에서는 벽면 액자(BoardObject)가 같은 데이터를 쓴다.
 * 높이 184px 안에서 도구 pill 줄 + 카드 가로 스크롤 한 줄로 배치한다.
 */
export function BoardPanel({ model }: { model: RoomModel }) {
  const cards = visibleCards(model.state);
  const [compose, setCompose] = useState<'card' | 'tool' | null>(null);
  const canEdit = canEditTools(model);
  return (
    <section aria-label="보드" data-testid="board" className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-4 pt-3">
      <div className="flex h-8 shrink-0 items-center gap-2">
        <h2 className="tg-mono shrink-0" style={{ color: 'var(--fg)' }}>
          보드
        </h2>
        <span className="tg-chip shrink-0">카드 {cards.length}</span>
        <BoardToolStrip model={model} />
        <span className="ml-auto flex shrink-0 gap-2">
          {canEdit && compose !== 'tool' && (
            <button type="button" data-testid="tool-new" onClick={() => setCompose('tool')} className={btn('soft')}>
              + 도구
            </button>
          )}
          {compose !== 'card' && (
            <button type="button" data-testid="card-new" disabled={model.replaying} onClick={() => setCompose('card')} className={btn('soft')}>
              + 카드 추가
            </button>
          )}
        </span>
      </div>
      <ul className="bcards">
        {compose === 'tool' && canEdit && (
          <li className="bform wide">
            <NewToolForm m={model} onDone={() => setCompose(null)} />
          </li>
        )}
        {compose === 'card' && <NewCardForm m={model} onDone={() => setCompose(null)} />}
        {cards.length === 0 && !compose && (
          <li className="self-center text-aux text-muted" style={{ gridColumn: 'span 3', textAlign: 'center' }}>
            아직 카드가 없어요. Agent가 초안을 만들거나 직접 추가해 보세요.
          </li>
        )}
        {cards.map((c) => (
          <Card key={c.cardId} card={c} m={model} />
        ))}
      </ul>
      <BoardToolHost model={model} />
    </section>
  );
}
