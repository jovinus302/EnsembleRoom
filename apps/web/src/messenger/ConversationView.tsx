import { useEffect, useMemo } from 'react';
import { closeRoom, markSeen, openRoom, sendMessage } from '../api/ws';
import { useRooms } from '../store/roomStore';
import { useSession } from '../store/session';
import { useWorld } from '../store/worldStore';
import { Composer } from './Composer';
import { KIND_LABEL, titleOf } from './labels';
import { MessageList } from './MessageList';

const NO_PRESENCE: string[] = [];

export function ConversationView({ roomId }: { roomId: string }) {
  const meId = useSession((s) => s.user!.id);
  const users = useWorld((s) => s.users);
  const room = useWorld((s) => s.rooms[roomId]);
  const wsStatus = useWorld((s) => s.wsStatus);
  const lastSeq = useRooms((s) => s.rooms[roomId]?.lastSeq ?? 0);
  const loaded = useRooms((s) => s.rooms[roomId]?.snapshotLoaded ?? false);
  const unread = useWorld((s) => s.rooms[roomId]?.preview.detail?.unread ?? 0);
  const presence = useRooms((s) => s.rooms[roomId]?.presence ?? NO_PRESENCE);
  const agents = useRooms((s) => s.rooms[roomId]?.agents);
  const targets = useMemo(() => (agents ?? []).map((a) => ({ id: a.id, name: a.name })), [agents]);

  // WS subscribe → snapshot. 방을 바꾸면 이전 방 구독을 해제한다.
  useEffect(() => {
    void openRoom(roomId);
    return () => closeRoom(roomId);
  }, [roomId]);

  // 열려 있는 대화는 읽음 처리한다.
  useEffect(() => {
    if (loaded && lastSeq > 0) void markSeen(roomId, lastSeq);
    // unread가 다시 올라오면(world_preview가 이벤트보다 늦게 도착) 한 번 더 읽음 처리한다.
  }, [roomId, loaded, lastSeq, unread]);

  if (!room) return null;
  const title = titleOf(room, meId, users);
  const others = presence.filter((id) => id !== meId).map((id) => users[id]?.name ?? id);

  return (
    <section aria-label={`${title} 대화`} className="flex h-full min-w-0 flex-1 flex-col bg-panel/0">
      <header className="flex items-center gap-3 border-b border-line bg-panel px-6 py-3">
        <h1 className="truncate text-base font-semibold">{title}</h1>
        <span className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted">{KIND_LABEL[room.kind]}</span>
        {others.length > 0 && (
          <span className="text-xs text-muted" data-testid="presence">
            접속 중 · {others.join(', ')}
          </span>
        )}
        {wsStatus !== 'open' && wsStatus !== 'idle' && (
          <span role="status" className="ml-auto text-xs text-warn">
            {wsStatus === 'connecting' ? '연결 중…' : '연결이 끊겼습니다. 다시 연결하는 중…'}
          </span>
        )}
      </header>
      <div data-room-kind={room.kind} className="flex min-h-0 flex-1 flex-col">
        <MessageList roomId={roomId} meId={meId} users={users} />
        <Composer placeholder={`${title}에 메시지 보내기`} targets={targets} onSend={(t, to) => void sendMessage(roomId, t, undefined, to)} />
      </div>
    </section>
  );
}
