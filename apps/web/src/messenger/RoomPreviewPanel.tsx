import { useMemo, useState, type ReactNode } from 'react';
import { THEMES, type RoomEvent, type WorldRoom } from '@ensemble/shared';
import { api, ApiError } from '../api/client';
import { LeaveSheet } from '../room/LeaveSheet';
import { SendAgentSheet } from '../room/SendAgentSheet';
import { rejoinAndShowDigest } from '../room/actions';
import { navigate } from '../router';
import { useRooms } from '../store/roomStore';
import { useSession } from '../store/session';
import { useActivity } from '../store/activityStore';
import { useWorld } from '../store/worldStore';
import { PHASE_LABEL, WorkingDots } from './AgentActivity';
import { AgentAvatar, AgentTag } from './Avatar';
import { InteractionChip } from './InteractionChip';
import { MemoryPanel } from './MemoryPanel';
import { AMBIENCE_LABEL, KIND_LABEL, colorOf, dmPeer, titleOf } from './labels';
import { APPROVAL_ORANGE, foldVisits } from './visits';
import { APPROVAL_INK, ink } from '../theme';

const NO_EVENTS: RoomEvent[] = [];
const NO_PRESENCE: string[] = [];

const ACTIVITY_LABEL: Record<string, string> = {
  idle: '대기 중',
  thinking: '생각하는 중',
  drafting: '쓰는 중',
  talking: '말하는 중',
  awaiting: '승인 기다리는 중',
  paused: '멈춤',
};

/** 해당 Room에서 내 마지막 입퇴장 상태 */
function memberState(events: readonly RoomEvent[], meId: string): 'present' | 'left' | 'none' {
  let st: 'present' | 'left' | 'none' = 'none';
  for (const e of events) {
    if (e.type === 'member_entered' && e.userId === meId) st = 'present';
    else if (e.type === 'member_rejoined' && e.userId === meId) st = 'present';
    else if (e.type === 'member_left' && e.userId === meId) st = 'left';
  }
  return st;
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '요청에 실패했습니다');
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

const btn = 'rounded-md border border-line px-3 py-1.5 text-sm hover:bg-raised disabled:opacity-50';

/** 단순 정적 캡슐: 유리 상태(투명/서리)와 조명 단계, Room 색 링을 CSS로만 표현한다. 3D 미리보기는 S15 이후. */
function CapsuleThumb({ room, color }: { room: WorldRoom; color: string }) {
  const frosted = room.preview.glass !== 'clear';
  const amb = room.preview.ambience;
  const glow = amb === 'occupied' ? '#ffd9a0' : amb === 'agentOnly' ? color : amb === 'attention' ? APPROVAL_ORANGE : 'var(--stage-idle)';
  const lit = amb === 'empty' ? 0.15 : amb === 'agentOnly' ? 0.45 : 0.9;
  const alpha = `${Math.round(lit * 100)}%`;
  return (
    <div
      data-testid="capsule-thumb"
      data-glass={room.preview.glass}
      data-ambience={amb}
      className="relative mx-auto mt-3 h-[84px] w-[220px] overflow-hidden rounded-full"
      style={{
        border: `2px solid ${color}`,
        background: `radial-gradient(ellipse at 50% 60%, color-mix(in srgb, ${glow} ${alpha}, transparent), transparent 70%), var(--thumb-bg)`,
        boxShadow: amb === 'attention' ? `0 0 14px ${APPROVAL_ORANGE}` : undefined,
      }}
    >
      {frosted && <div className="absolute inset-0 rounded-full bg-white/55 backdrop-blur-md" />}
      <span className="absolute left-1/3 top-0 h-full w-px bg-black/10" />
      <span className="absolute left-2/3 top-0 h-full w-px bg-black/10" />
    </div>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted">{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function PreviewTab({ roomId }: { roomId: string }) {
  const meId = useSession((s) => s.user!.id);
  const myAgentDto = useSession((s) => s.agent);
  const users = useWorld((s) => s.users);
  const rooms = useWorld((s) => s.rooms);
  const myAgent = useWorld((s) => s.myAgent);
  const room = rooms[roomId];
  const events = useRooms((s) => s.rooms[roomId]?.events) ?? NO_EVENTS;
  const presence = useRooms((s) => s.rooms[roomId]?.presence) ?? NO_PRESENCE;
  const activityByKey = useActivity((s) => s.byKey);
  const [form, setForm] = useState<'leave' | 'agent' | null>(null);
  const act = useAction();

  const mine = useMemo(() => memberState(events, meId), [events, meId]);
  const visits = useMemo(() => foldVisits(events), [events]);

  if (!room) return null;
  // Leave한 동안은 구독이 남아 있어도 접속 중으로 세지 않는다
  const shownPresence = mine === 'left' ? presence.filter((id) => id !== meId) : presence;
  const title = titleOf(room, meId, users);
  const color = colorOf(room, meId, users);
  const detail = room.preview.detail;

  // 방문 대상: 상대 My Room (DM이면 상대의 My Room, 남의 My Room을 직접 보는 경우 그 방)
  const peer = room.kind === 'dm' ? dmPeer(room, meId, users) : undefined;
  const visitTarget: WorldRoom | undefined =
    room.kind === 'dm'
      ? Object.values(rooms).find((r) => r.kind === 'my' && r.ownerId === peer?.id)
      : room.kind === 'my' && room.ownerId !== meId
        ? room
        : undefined;
  const isMember = room.kind === 'our' || (room.kind === 'my' && room.ownerId === meId);
  // DM에는 Room이 없고, 남의 Room은 유리가 투명할 때(내 방문이 활성)만 들어갈 수 있다
  const canEnter = room.kind !== 'dm' && (isMember || room.preview.glass === 'clear');

  // 내가 요청했거나 방문 중인 최신 방문
  const myVisit = [...visits.values()]
    .filter((v) => v.visitorUserId === meId && (v.status === 'requested' || v.status === 'active'))
    .sort((a, b) => b.requestedSeq - a.requestedSeq)[0];

  // 실시간 활동(휘발성): agentId별로 가장 최근 것
  const liveByAgent = new Map<string, (typeof activityByKey)[string]>();
  for (const a of Object.values(activityByKey)) {
    const cur = liveByAgent.get(a.agentId);
    if (!cur || a.updatedAt > cur.updatedAt) liveByAgent.set(a.agentId, a);
  }
  const myLive = myAgent ? liveByAgent.get(myAgent.agentId) : undefined;
  const myLiveRoom = myLive ? rooms[myLive.roomId] : undefined;

  const agentLoc = myAgent?.location ? rooms[myAgent.location] : undefined;
  const agentColor = users[meId]?.color ?? '#a0aec4';

  return (
    <div>
      <p className="mt-3 flex items-center gap-2 text-lg font-semibold">
        <span className="truncate">{title}</span>
        <span className="rounded border border-line px-1.5 py-0.5 text-[11px] font-normal text-muted">{KIND_LABEL[room.kind]}</span>
      </p>

      {room.kind === 'dm' ? (
        <p className="mt-2 text-xs text-muted">DM에는 3D Room이 없습니다. 상대의 My Room을 방문할 수 있어요.</p>
      ) : (
        <>
          <CapsuleThumb room={room} color={color} />
          <dl className="mt-4 grid grid-cols-[84px_1fr] gap-y-2 text-sm">
            <Row k="테마">
              {THEMES[room.theme].label}
              {room.themeVariant ? ` (${room.themeVariant})` : ''}
            </Row>
            <Row k="조명 단계">{AMBIENCE_LABEL[room.preview.ambience] ?? room.preview.ambience}</Row>
            <Row k="유리">{room.preview.glass === 'clear'
                ? '투명 (안이 보임)'
                : room.preview.glass === 'agent'
                  ? 'Agent 시야 (옅은 서리, 내 Agent 방문 중)'
                  : '서리 (안이 안 보임)'}</Row>
            <Row k="접속 중">
              {shownPresence.length ? shownPresence.map((id) => users[id]?.name ?? id).join(', ') : <span className="text-muted">없음</span>}
            </Row>
            {detail && (
              <>
                <Row k="놓친 변화">
                  <span data-testid="missed-changes">{detail.missedChanges}건</span>
                </Row>
                {detail.interaction && (
                  <Row k="진행 중">
                    <InteractionChip interaction={detail.interaction} />
                  </Row>
                )}
                <Row k="Agent">
                  {detail.agents.length ? (
                    <span className="flex flex-wrap gap-1">
                      {detail.agents.map((a) => {
                        const live = liveByAgent.get(a.agentId);
                        return (
                          <span
                            key={a.agentId}
                            data-testid="agent-chip"
                            data-live={live ? 'true' : 'false'}
                            className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs"
                            style={{ borderColor: live ? 'var(--focus)' : 'var(--line)' }}
                          >
                            {a.name} · {live ? PHASE_LABEL[live.phase] : (ACTIVITY_LABEL[a.activity] ?? a.activity)}
                            {live && (
                              <span className="text-[var(--focus)]">
                                <WorkingDots label={PHASE_LABEL[live.phase]} />
                              </span>
                            )}
                          </span>
                        );
                      })}
                    </span>
                  ) : (
                    <span className="text-muted">없음</span>
                  )}
                </Row>
                {detail.pendingApprovals > 0 && (
                  <Row k="승인">
                    <span
                      className="rounded-full px-2 py-0.5 text-xs font-semibold text-[var(--on-accent)]"
                      style={{ background: APPROVAL_ORANGE }}
                    >
                      대기 {detail.pendingApprovals}건
                    </span>
                  </Row>
                )}
              </>
            )}
          </dl>
        </>
      )}

      <section aria-label="내 Agent" className="mt-5 flex items-center gap-3 rounded-lg border border-line p-3" data-testid="my-agent">
        <AgentAvatar variant={myAgentDto?.variant} color={agentColor} name={myAgent?.name ?? myAgentDto?.name} />
        <div className="min-w-0 text-sm">
          <div className="flex items-center gap-1.5 font-medium">
            <span className="truncate">{myAgent?.name ?? myAgentDto?.name ?? '내 Agent'}</span>
            <AgentTag color={agentColor} />
          </div>
          <div className="flex items-center gap-1.5 truncate text-xs text-muted" data-testid="my-agent-label" data-live={myLive ? 'true' : 'false'}>
            {myLive ? (
              <>
                <span style={{ color: 'var(--focus)' }}>
                  {PHASE_LABEL[myLive.phase]}
                  {myLiveRoom ? ` · ${titleOf(myLiveRoom, meId, users)}` : ''}
                </span>
                <span className="text-[var(--focus)]">
                  <WorkingDots label={PHASE_LABEL[myLive.phase]} />
                </span>
              </>
            ) : myAgent ? (
              `${myAgent.label}${agentLoc ? ` · ${titleOf(agentLoc, meId, users)}` : ''} · ${ACTIVITY_LABEL[myAgent.activity] ?? myAgent.activity}`
            ) : (
              '상태를 불러오는 중'
            )}
          </div>
        </div>
      </section>

      <div className="mt-5 flex flex-wrap gap-2" data-testid="room-actions">
        {canEnter && (
          <button
            type="button"
            data-testid="enter-room"
            onClick={() => navigate(`/room/${room.id}`)}
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-[var(--on-accent-strong)] hover:brightness-95"
          >
            들어가기
          </button>
        )}
        {isMember && mine === 'left' && (
          <button
            type="button"
            disabled={act.busy}
            className={btn}
            onClick={() =>
              void act.run(() => rejoinAndShowDigest(roomId))
            }
          >
            Rejoin
          </button>
        )}
        {isMember && mine === 'none' && (
          <button type="button" disabled={act.busy} className={btn} onClick={() => void act.run(() => api.enter(roomId))}>
            입장
          </button>
        )}
        {isMember && mine === 'present' && (
          <>
            <span className="inline-flex items-center rounded-md border border-line px-3 py-1.5 text-sm text-muted">입장 중</span>
            <button type="button" disabled={act.busy} className={btn} onClick={() => setForm(form === 'leave' ? null : 'leave')}>
              Leave
            </button>
          </>
        )}
        {isMember && mine === 'left' && (
          <span className="self-center text-xs text-muted">Leave 상태 — 내 Agent가 대신 참여 중일 수 있어요</span>
        )}

        {visitTarget && !myVisit && (
          <>
            <button
              type="button"
              disabled={act.busy}
              className={btn}
              onClick={() => void act.run(() => api.requestVisit(visitTarget.id))}
            >
              방문 요청
            </button>
            <button type="button" disabled={act.busy} className={btn} onClick={() => setForm(form === 'agent' ? null : 'agent')}>
              Agent 보내기
            </button>
          </>
        )}
        {visitTarget && myVisit && (
          <div className="flex w-full items-center gap-2 text-sm" data-testid="visit-status">
            <span style={{ color: myVisit.status === 'requested' ? APPROVAL_INK : ink(color) }}>
              {myVisit.status === 'requested' ? '방문 승인 대기 중' : '방문 중'}
            </span>
            {myVisit.status === 'active' && (
              <button type="button" disabled={act.busy} className={btn} onClick={() => void act.run(() => api.endVisit(myVisit.visitId))}>
                방문 종료
              </button>
            )}
          </div>
        )}
      </div>

      {form === 'leave' && isMember && (
        <LeaveSheet roomId={roomId} agentName={myAgent?.name ?? myAgentDto?.name ?? '내 Agent'} onClose={() => setForm(null)} />
      )}
      {form === 'agent' && visitTarget && (
        <SendAgentSheet
          hostRoomId={visitTarget.id}
          hostName={users[visitTarget.ownerId ?? '']?.name ?? '상대'}
          agentName={myAgent?.name ?? myAgentDto?.name ?? '내 Agent'}
          onClose={() => setForm(null)}
        />
      )}
      {act.error && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {act.error}
        </p>
      )}
    </div>
  );
}

export function RoomPreviewPanel({ roomId }: { roomId: string }) {
  const [tabState, setTab] = useState<'preview' | 'memory'>('preview');
  const meId = useSession((s) => s.user!.id);
  // 남의 My Room은 기억을 볼 수 없다(서버 403): 탭을 숨긴다
  const foreign = useWorld((s) => {
    const r = s.rooms[roomId];
    return !!r && r.kind === 'my' && r.ownerId !== meId;
  });
  const tab = foreign ? 'preview' : tabState;
  const tabCls = (t: string) =>
    `px-3 py-1.5 text-xs font-medium border-b-2 ${tab === t ? 'border-fg text-fg' : 'border-transparent text-muted hover:text-fg'}`;
  return (
    <aside aria-label="Room 미리보기" className="pointer-events-auto flex h-full w-[340px] shrink-0 flex-col border-l border-line bg-panel backdrop-blur-md">
      <div role="tablist" className="flex border-b border-line px-3 pt-2">
        <button role="tab" type="button" aria-selected={tab === 'preview'} className={tabCls('preview')} onClick={() => setTab('preview')}>
          미리보기
        </button>
        {!foreign && (
          <button role="tab" type="button" aria-selected={tab === 'memory'} className={tabCls('memory')} onClick={() => setTab('memory')}>
            내 기억
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {tab === 'preview' ? <PreviewTab roomId={roomId} /> : <MemoryPanel roomId={roomId} />}
      </div>
    </aside>
  );
}
