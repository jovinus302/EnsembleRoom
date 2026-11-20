import { useState } from 'react';
import { ringGradientStops, visibleCards, type BoardCard, type OwnerTag } from '@ensemble/shared';
import { api, ApiError } from '../api/client';
import { FALLBACK_COLOR } from '../messenger/agentIdentity';
import type { RoomModel } from './useRoomModel';
import { BoardToolHost, BoardToolStrip } from './boardTools/BoardToolStrip';
import { ink } from '../theme';

const GOLD = '#f2d04e';

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
        className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-xs placeholder:text-muted disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={disabled || busy || !text.trim()}
        className="rounded-md border border-line px-2 py-1 text-xs hover:bg-raised disabled:opacity-40"
      >
        등록
      </button>
      {error && (
        <span role="alert" className="basis-full text-[11px] text-danger">
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
      <input
        aria-label="카드 제목"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="rounded-md border border-line bg-bg px-2 py-1 text-sm"
      />
      <textarea
        aria-label="카드 내용"
        value={body}
        rows={3}
        onChange={(e) => setBody(e.target.value)}
        className="resize-none rounded-md border border-line bg-bg px-2 py-1 text-sm"
      />
      <div className="flex gap-1.5">
        <button type="submit" disabled={busy} className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-[var(--on-accent-strong)] disabled:opacity-50">
          저장
        </button>
        <button type="button" onClick={onDone} className="rounded-md border border-line px-3 py-1 text-xs hover:bg-raised">
          취소
        </button>
      </div>
      {error && (
        <p role="alert" className="text-[11px] text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

function Card({ card, m }: { card: BoardCard; m: RoomModel }) {
  const [editing, setEditing] = useState(false);
  const [pointTo, setPointTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const o = ownerStyle(card.ownerTag, m);
  const nameOfActor = (kind: string, id: string | null) =>
    kind === 'human' ? (m.users[id ?? '']?.name ?? '누군가') : kind === 'system' ? '시스템' : m.resolveAgent(id).name;
  const colorOfActor = (kind: string, id: string | null) =>
    kind === 'human' ? (m.users[id ?? '']?.color ?? FALLBACK_COLOR) : m.resolveAgent(id).color;
  const askable = m.agents.filter((a) => !a.visiting && a.state.mode !== 'traveling');
  const border = o.ours
    ? { border: '2px solid transparent', backgroundImage: `linear-gradient(var(--surface), var(--surface)), linear-gradient(135deg, ${o.ring.join(',')})`, backgroundOrigin: 'border-box', backgroundClip: 'padding-box, border-box' }
    : { border: `2px ${o.dashed ? 'dashed' : 'solid'} ${o.color}`, background: 'var(--surface)' };

  return (
    <li
      data-testid="board-card"
      data-owner={card.ownerTag}
      data-ours={o.ours ? 'true' : 'false'}
      data-agreed={card.agreed ? 'true' : 'false'}
      className="surface-card anim-card relative flex flex-col rounded-xl p-3.5 text-sm"
      style={border}
    >
      {card.agreed && (
        <span
          data-testid="agreed-pin"
          title="합의된 카드"
          className="absolute -top-2.5 right-3 flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold text-[#3a2c00]"
          style={{ background: GOLD }}
        >
          <span aria-hidden="true">📌</span>합의
        </span>
      )}
      <div className="flex items-center gap-2 text-[11px]">
        <span className="rounded-full border px-2 py-0.5" style={{ borderColor: o.ours ? o.ring[0] : o.color, color: o.ours ? 'var(--fg)' : ink(o.color) }}>
          {o.ours ? '✦ ' : ''}
          {o.label}
        </span>
        <span className="text-muted">v{card.version}</span>
        {!m.replaying && !editing && (
          <button
            type="button"
            data-testid="card-edit"
            onClick={() => setEditing(true)}
            className="ml-auto text-muted underline-offset-2 hover:text-fg hover:underline"
          >
            수정
          </button>
        )}
      </div>
      {editing ? (
        <EditForm roomId={m.roomId} card={card} onDone={() => setEditing(false)} />
      ) : (
        <>
          <h3 className="mt-1.5 break-words text-[15px] font-semibold leading-snug">{card.title}</h3>
          {card.body && <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg/85">{card.body}</p>}
        </>
      )}

      {card.comments.length > 0 && (
        <ul className="mt-2.5 flex flex-col gap-1 border-t border-line pt-2" data-testid="card-comments">
          {card.comments.map((c) => (
            <li key={c.seq} className="text-xs leading-relaxed">
              <span className="font-medium" style={{ color: ink(colorOfActor(c.actorKind, c.actorId)) }}>
                {nameOfActor(c.actorKind, c.actorId)}
              </span>{' '}
              <span className="text-fg/85">{c.text}</span>
            </li>
          ))}
        </ul>
      )}

      <CommentForm roomId={m.roomId} cardId={card.cardId} disabled={m.replaying} />
      {!m.replaying && askable.length > 0 && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted">
          <select
            aria-label="카드를 보여 줄 Agent"
            value={pointTo}
            onChange={(e) => setPointTo(e.target.value)}
            className="rounded-md border border-line bg-bg px-1.5 py-1 text-[11px]"
          >
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
            className="rounded-md border border-line px-2 py-1 hover:bg-raised disabled:opacity-40"
          >
            보여 주기
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-[11px] text-danger">
          {error}
        </p>
      )}
    </li>
  );
}

function NewCardForm({ m }: { m: RoomModel }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <button
        type="button"
        data-testid="card-new"
        disabled={m.replaying}
        onClick={() => setOpen(true)}
        className="rounded-md border border-dashed border-line px-3 py-1.5 text-xs text-muted hover:bg-raised hover:text-fg disabled:opacity-40"
      >
        + 카드 추가
      </button>
    );
  return (
    <form
      className="flex flex-col gap-1.5 rounded-xl border border-line p-3"
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
          setTitle('');
          setBody('');
          setOpen(false);
        } catch (err) {
          setError(errText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        data-testid="card-new-title"
        aria-label="새 카드 제목"
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="제목"
        className="rounded-md border border-line bg-bg px-2 py-1 text-sm"
      />
      <textarea
        aria-label="새 카드 내용"
        value={body}
        rows={2}
        onChange={(e) => setBody(e.target.value)}
        placeholder="내용"
        className="resize-none rounded-md border border-line bg-bg px-2 py-1 text-sm"
      />
      <div className="flex gap-1.5">
        <button type="submit" disabled={busy || !title.trim()} className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-[var(--on-accent-strong)] disabled:opacity-50">
          추가
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-line px-3 py-1 text-xs hover:bg-raised">
          취소
        </button>
      </div>
      {error && (
        <p role="alert" className="text-[11px] text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * 보드. 카드 테두리 색은 owner_tag를 따른다: 사람 카드 = 그 사람 색, Agent 카드 = 소유자 색 점선,
 * 우리 카드 = 구성원 색 그라데이션 + ✦, 합의된 카드 = 금빛 핀. 3D에서는 벽면 액자(BoardObject)가 같은 데이터를 쓴다.
 */
export function BoardPanel({ model }: { model: RoomModel }) {
  const cards = visibleCards(model.state);
  return (
    <section aria-label="보드" data-testid="board" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-5 pb-2 pt-4">
        <h2 className="text-sm font-semibold">보드</h2>
        <span className="text-xs text-muted">카드 {cards.length}장</span>
        <span className="ml-auto">
          <NewCardForm m={model} />
        </span>
      </div>
      <BoardToolStrip model={model} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {cards.length === 0 ? (
          <p className="mt-6 text-center text-sm text-muted">아직 카드가 없어요. Agent가 초안을 만들거나 직접 추가해 보세요.</p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3.5 pt-2">
            {cards.map((c) => (
              <Card key={c.cardId} card={c} m={model} />
            ))}
          </ul>
        )}
      </div>
      <BoardToolHost model={model} />
    </section>
  );
}
