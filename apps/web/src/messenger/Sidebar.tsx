import type { ReactNode } from 'react';
import { THEMES, type WorldRoom } from '@ensemble/shared';
import { navigate } from '../router';
import { useSession } from '../store/session';
import { useActivity } from '../store/activityStore';
import { useWorld } from '../store/worldStore';
import { WorkingDots } from './AgentActivity';
import { ApprovalInbox } from './ApprovalInbox';
import { GuideButton } from '../onboarding/Tour';
import { Avatar } from './Avatar';
import { InteractionChip } from './InteractionChip';
import { btn } from '../ui/tg';
import { AMBIENCE_LABEL, colorOf, dmPeer, titleOf } from './labels';

function UnreadBadge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span
      aria-label={`안 읽은 메시지 ${n}개`}
      className="tg-badge ml-auto shrink-0"
    >
      {n > 99 ? '99+' : n}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-1" aria-label={title}>
      <h2 className="tg-mono mx-1 mb-1.5 mt-1.5">{title}</h2>
      <ul className="flex flex-col gap-0.5">{children}</ul>
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
  const myLeave = room.preview.detail?.myLeave ?? null;
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={() => useWorld.getState().select(room.id)}
        className={`tg-roomrow${selected ? ' sel' : ''}`}
      >
        {room.kind === 'dm' ? (
          <Avatar name={peer?.name ?? title} color={color} />
        ) : (
          <span
            aria-hidden="true"
            className="tg-mini-cap"
            style={{ background: `linear-gradient(135deg, rgba(255,255,255,0.7), color-mix(in srgb, ${color} 55%, transparent))`, borderColor: color }}
          />
        )}
        <span className="tx">
          <span className="nm flex items-center gap-1.5">
            <span className="truncate">{title}</span>
            {busy && (
              <span data-testid="room-working" className="shrink-0 text-[var(--focus)]" title="Agent가 일하는 중">
                <WorkingDots label="Agent가 일하는 중" />
              </span>
            )}
          </span>
          <InteractionChip interaction={room.preview.detail?.interaction} />
          {myLeave && (
            <span data-testid="room-left-status" data-leave={myLeave} className="sub text-[var(--focus)]">
              {myLeave === 'delegated' ? 'Leave함 · Agent 대리 중' : 'Leave함'}
            </span>
          )}
          {sub && <span className="sub">{sub}</span>}
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
    <nav aria-label="대화 목록" className="tg-panel pointer-events-auto flex h-full w-[320px] shrink-0 flex-col gap-2.5 overflow-hidden p-4">
      <div className="flex items-center gap-3">
        <Avatar name={me.name} color={me.color} size={40} />
        <div className="min-w-0">
          <div className="truncate font-semibold">{me.name}</div>
          <button
            type="button"
            onClick={() => useSession.getState().logout()}
            className="tg-mono normal-case tracking-normal underline-offset-2 hover:underline"
          >
            로그아웃
          </button>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 self-start">
          <GuideButton id="home" />
          <button
            type="button"
            data-testid="open-metrics"
            onClick={() => navigate('/metrics')}
            className={btn('ghost')}
          >
            지표
          </button>
        </div>
      </div>

      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-1">
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
