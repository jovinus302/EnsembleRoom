import type { ReactNode } from 'react';
import { THEMES, type WorldRoom } from '@ensemble/shared';
import { navigate } from '../router';
import { useSession } from '../store/session';
import { useActivity } from '../store/activityStore';
import { useWorld } from '../store/worldStore';
import { WorkingDots } from './AgentActivity';
import { ApprovalInbox } from './ApprovalInbox';
import { Avatar } from './Avatar';
import { AMBIENCE_LABEL, colorOf, dmPeer, titleOf } from './labels';

function UnreadBadge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span
      aria-label={`안 읽은 메시지 ${n}개`}
      className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-fg px-1.5 text-[11px] font-semibold leading-5 text-bg"
    >
      {n > 99 ? '99+' : n}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5" aria-label={title}>
      <h2 className="px-4 pb-1 text-xs font-medium tracking-wide text-muted">{title}</h2>
      <ul className="flex flex-col gap-0.5 px-2">{children}</ul>
    </section>
  );
}

function RoomRow({ room, sub }: { room: WorldRoom; sub?: string }) {
  const meId = useSession((s) => s.user!.id);
  const users = useWorld((s) => s.users);
  const selected = useWorld((s) => s.selectedRoomId === room.id);
  const color = colorOf(room, meId, users);
  const title = titleOf(room, meId, users);
  const unread = room.preview.detail?.unread ?? 0;
  const peer = room.kind === 'dm' ? dmPeer(room, meId, users) : undefined;
  // 이 Room에서 Agent가 일하는 중: 실시간 activity, 없으면 world_preview의 Agent 상태
  const working = useActivity((s) => Object.values(s.byKey).some((a) => a.roomId === room.id));
  const previewWorking = room.preview.detail?.agents.some((a) => a.activity === 'thinking' || a.activity === 'drafting' || a.activity === 'talking');
  const busy = working || !!previewWorking;
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={() => useWorld.getState().select(room.id)}
        className={`flex w-full items-center gap-3 rounded-lg border px-2 py-2 text-left transition ${
          selected ? 'bg-raised' : 'border-transparent hover:bg-raised/60'
        }`}
        style={selected ? { borderColor: color } : undefined}
      >
        {room.kind === 'dm' ? (
          <Avatar name={peer?.name ?? title} color={color} />
        ) : (
          <span
            aria-hidden="true"
            className="h-8 w-8 shrink-0 rounded-[40%]"
            style={{ background: `linear-gradient(135deg, ${color}, ${color}55)`, border: `1px solid ${color}` }}
          />
        )}
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <span className="truncate">{title}</span>
            {busy && (
              <span data-testid="room-working" className="shrink-0 text-[var(--focus)]" title="Agent가 일하는 중">
                <WorkingDots label="Agent가 일하는 중" />
              </span>
            )}
          </span>
          {sub && <span className="block truncate text-xs text-muted">{sub}</span>}
        </span>
        <UnreadBadge n={unread} />
      </button>
    </li>
  );
}

export function Sidebar() {
  const me = useSession((s) => s.user!);
  const rooms = useWorld((s) => s.rooms);
  const order = useWorld((s) => s.roomOrder);
  const all = order.map((id) => rooms[id]).filter((r): r is WorldRoom => !!r);
  const mine = all.find((r) => r.kind === 'my' && r.ownerId === me.id);
  const ours = all.filter((r) => r.kind === 'our');
  const dms = all.filter((r) => r.kind === 'dm');

  return (
    <nav aria-label="대화 목록" className="pointer-events-auto flex h-full w-[280px] shrink-0 flex-col border-r border-line bg-panel backdrop-blur-md">
      <div className="flex items-center gap-3 border-b border-line px-4 py-4">
        <Avatar name={me.name} color={me.color} size={40} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{me.name}</div>
          <button
            type="button"
            onClick={() => useSession.getState().logout()}
            className="text-xs text-muted underline-offset-2 hover:underline"
          >
            로그아웃
          </button>
        </div>
        <button
          type="button"
          data-testid="open-metrics"
          onClick={() => navigate('/metrics')}
          className="ml-auto self-start rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-raised hover:text-fg"
        >
          지표
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pb-4">
        <ApprovalInbox />
        {mine && (
          <Section title="나">
            <RoomRow
              room={mine}
              sub={`${THEMES[mine.theme].label} · ${AMBIENCE_LABEL[mine.preview.ambience] ?? mine.preview.ambience}`}
            />
          </Section>
        )}
        <Section title="우리">
          {ours.map((r) => (
            <RoomRow key={r.id} room={r} sub={`${r.memberIds.length}명 · ${THEMES[r.theme].label}`} />
          ))}
        </Section>
        <Section title="사람">
          {dms.map((r) => (
            <RoomRow key={r.id} room={r} />
          ))}
        </Section>
      </div>
    </nav>
  );
}
