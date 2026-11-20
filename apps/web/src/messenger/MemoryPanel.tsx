import { useCallback, useEffect, useMemo, useState } from 'react';
import { MemoryKindSchema, nsFor, nsPrivate, parseNamespace, type MemoryItemDto, type MemoryKind, type WorldRoom } from '@ensemble/shared';
import { api, ApiError } from '../api/client';
import { useRooms } from '../store/roomStore';
import { useSession } from '../store/session';
import { useWorld } from '../store/worldStore';
import { titleOf } from './labels';
import { btn, cvar } from '../ui/tg';

const KIND_LABEL: Record<MemoryKind, string> = { fact: '사실', preference: '선호', agreement: '합의', summary: '요약' };

type Scope = 'private' | 'for' | 'room' | 'other';

/** 이 기억이 어디까지 보이는지 */
function scopeOf(ns: string): { scope: Scope; roomId?: string } {
  const p = parseNamespace(ns);
  if (p?.kind === 'private') return { scope: 'private' };
  if (p?.kind === 'for') return { scope: 'for', roomId: p.roomId };
  if (p?.kind === 'room') return { scope: 'room', roomId: p.roomId };
  return { scope: 'other' };
}

/** 공개 범위 칩 색: 나만/기타는 중립, 방에 제공은 Agent 색, 방 공유는 primary */
const SCOPE_STYLE: Record<Scope, { label: string; color?: string }> = {
  private: { label: '나만' },
  for: { label: '이 방에 제공', color: 'var(--agent)' },
  room: { label: '방 공유', color: 'var(--primary)' },
  other: { label: '기타' },
};

function ScopeChip({ ns, rooms, meId, users }: { ns: string; rooms: Record<string, WorldRoom>; meId: string; users: Parameters<typeof titleOf>[2] }) {
  const { scope, roomId } = scopeOf(ns);
  const st = SCOPE_STYLE[scope];
  const target = roomId ? rooms[roomId] : undefined;
  return (
    <span
      data-testid="memory-scope"
      data-scope={scope}
      className={`tg-chip min-w-0 max-w-full overflow-hidden text-ellipsis${st.color ? ' tonal' : ''}`}
      style={cvar(st.color)}
    >
      {st.label}
      {target ? ` · ${titleOf(target, meId, users)}` : ''}
    </span>
  );
}

function MemoryRow({
  item,
  options,
  rooms,
  meId,
  users,
  onReshare,
  onDelete,
  editable,
}: {
  item: MemoryItemDto;
  options: { value: string; label: string }[];
  rooms: Record<string, WorldRoom>;
  meId: string;
  users: Parameters<typeof titleOf>[2];
  onReshare: (id: string, ns: string) => void;
  onDelete: (id: string) => void;
  editable: boolean;
}) {
  return (
    <li data-testid="memory-item" data-ns={item.ns} className="tg-memrow">
      <p className="whitespace-pre-wrap break-words text-aux">{item.text}</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="tg-chip">{KIND_LABEL[item.kind] ?? item.kind}</span>
        <ScopeChip ns={item.ns} rooms={rooms} meId={meId} users={users} />
        {editable && (
          <>
            <select
              aria-label="공유 대상 변경"
              value={options.some((o) => o.value === item.ns) ? item.ns : ''}
              onChange={(e) => e.target.value && onReshare(item.id, e.target.value)}
              className="tg-field ml-auto h-7 min-h-0 max-w-full px-2 py-0 text-aux"
            >
              {!options.some((o) => o.value === item.ns) && <option value="">(변경 불가)</option>}
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => onDelete(item.id)}
              className={`${btn('dghost')} h-7 px-3 text-aux`}
            >
              삭제
            </button>
          </>
        )}
      </div>
    </li>
  );
}

/** 내 기억(private / 이 방에 제공 / 방 공유)과, 보고 있는 Room의 기억. 항목별 공유 대상을 바꾸고 삭제할 수 있다. */
export function MemoryPanel({ roomId }: { roomId: string }) {
  const meId = useSession((s) => s.user!.id);
  const sessionAgentId = useSession((s) => s.agent?.id);
  const worldAgentId = useWorld((s) => s.myAgent?.agentId);
  const agentId = sessionAgentId ?? worldAgentId;
  const users = useWorld((s) => s.users);
  const rooms = useWorld((s) => s.rooms);
  const room = rooms[roomId];
  // 새 기억이 생기면(memory_retained) 목록을 다시 불러온다
  const retained = useRooms((s) => s.rooms[roomId]?.events.filter((e) => e.type === 'memory_retained').length) ?? 0;

  const [mine, setMine] = useState<MemoryItemDto[]>([]);
  const [roomItems, setRoomItems] = useState<MemoryItemDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState('');
  const [kind, setKind] = useState<MemoryKind>('fact');
  const [shareNs, setShareNs] = useState('');

  const options = useMemo(() => {
    if (!agentId) return [];
    const out = [{ value: nsPrivate(agentId), label: '나만 보기' }];
    for (const r of Object.values(rooms)) {
      // 서버 규칙: 공유 대상은 내가 속한 Our Room만
      if (r.kind !== 'our') continue;
      out.push({ value: nsFor(agentId, r.id), label: `${titleOf(r, meId, users)}에 제공` });
    }
    return out;
  }, [agentId, rooms, meId, users]);

  const effectiveShare = shareNs || options[0]?.value || '';

  const refresh = useCallback(async () => {
    try {
      const [m, r] = await Promise.all([
        api.memory(),
        api.roomMemory(roomId).catch((e: unknown) => {
          if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return { items: [] as MemoryItemDto[] };
          throw e;
        }),
      ]);
      setMine(m.items.filter((i) => i.status === 'active'));
      setRoomItems(r.items.filter((i) => i.status === 'active'));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '기억을 불러오지 못했습니다');
    } finally {
      setLoaded(true);
    }
  }, [roomId]);

  useEffect(() => {
    void refresh();
  }, [refresh, retained]);

  async function mutate(fn: () => Promise<unknown>) {
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '요청에 실패했습니다');
    }
    await refresh();
  }

  const priv = mine.filter((i) => scopeOf(i.ns).scope === 'private');
  const forRoom = mine.filter((i) => scopeOf(i.ns).scope === 'for');
  const forGroups = useMemo(() => {
    const g = new Map<string, MemoryItemDto[]>();
    for (const i of forRoom) {
      const rid = scopeOf(i.ns).roomId ?? '';
      g.set(rid, [...(g.get(rid) ?? []), i]);
    }
    return [...g.entries()];
  }, [forRoom]);
  // 서버가 돌려준 이 Room에서 보이는 기억 전부(방 공유 + 내가 이 방에 제공한 것)
  const sharedRoom = roomItems;
  const roomTitle = room ? titleOf(room, meId, users) : '이 방';
  const rowProps = { options, rooms, meId, users };

  return (
    <div data-testid="memory-panel" className="flex flex-col gap-4">
      <div>
        <h2 className="tg-title">내 기억</h2>
        <p className="tg-aux mt-1">기억마다 어디까지 보이는지 정할 수 있어요. 기본은 나만 보기예요.</p>
      </div>

      <form
        className="tg-card flex flex-col gap-2 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (!t || !effectiveShare) return;
          void mutate(() => api.addMemory({ ns: effectiveShare, kind, text: t }));
          setText('');
        }}
      >
        <label htmlFor="memory-text" className="sr-only">
          새 기억
        </label>
        <textarea
          id="memory-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="Agent가 기억해 둘 내용 (예: 나는 토요일 오후가 편해)"
          className="tg-field min-h-0 resize-none px-3 py-2 text-aux placeholder:text-muted"
        />
        <div className="flex flex-wrap items-center gap-2 text-aux">
          <select aria-label="종류" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)} className="tg-field h-8 min-h-0 px-2 py-0 text-aux">
            {MemoryKindSchema.options.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <select aria-label="공유 대상" value={effectiveShare} onChange={(e) => setShareNs(e.target.value)} className="tg-field h-8 min-h-0 min-w-0 flex-1 px-2 py-0 text-aux">
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button type="submit" disabled={!text.trim() || !effectiveShare} className={btn('primary')}>
            추가
          </button>
        </div>
      </form>

      {error && (
        <p role="alert" className="text-aux text-danger">
          {error}
        </p>
      )}

      <section aria-label="나만 보는 기억">
        <h3 className="tg-mono">나만 ({priv.length})</h3>
        <ul className="mt-2 flex flex-col gap-2">
          {priv.map((i) => (
            <MemoryRow key={i.id} item={i} editable {...rowProps} onReshare={(id, ns) => void mutate(() => api.reshareMemory(id, ns))} onDelete={(id) => void mutate(() => api.deleteMemory(id))} />
          ))}
        </ul>
        {loaded && priv.length === 0 && <p className="tg-aux mt-2">없음</p>}
      </section>

      <section aria-label="방에 제공한 기억">
        <h3 className="tg-mono">방에 제공 ({forRoom.length})</h3>
        {forGroups.map(([rid, items]) => (
          <div key={rid} className="mt-2">
            <p className="tg-aux">{rooms[rid] ? titleOf(rooms[rid], meId, users) : rid}</p>
            <ul className="mt-1.5 flex flex-col gap-2">
              {items.map((i) => (
                <MemoryRow key={i.id} item={i} editable {...rowProps} onReshare={(id, ns) => void mutate(() => api.reshareMemory(id, ns))} onDelete={(id) => void mutate(() => api.deleteMemory(id))} />
              ))}
            </ul>
          </div>
        ))}
        {loaded && forRoom.length === 0 && <p className="tg-aux mt-2">없음</p>}
      </section>

      <section aria-label={`${roomTitle}의 기억`}>
        <h3 className="tg-mono">{roomTitle}에서 쓰이는 기억 ({sharedRoom.length})</h3>
        <ul className="mt-2 flex flex-col gap-2">
          {sharedRoom.map((i) => (
            <MemoryRow key={i.id} item={i} editable={false} {...rowProps} onReshare={() => undefined} onDelete={() => undefined} />
          ))}
        </ul>
        {loaded && sharedRoom.length === 0 && <p className="tg-aux mt-2">없음</p>}
      </section>
    </div>
  );
}
