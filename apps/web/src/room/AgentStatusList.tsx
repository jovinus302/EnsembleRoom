import { useMemo } from 'react';
import { PHASE_LABEL, STEP_LABEL, WorkingDots } from '../messenger/AgentActivity';
import { AgentAvatar, Avatar } from '../messenger/Avatar';
import { MandateBlock } from '../messenger/MandateBlock';
import { AGENT_ACTIVITY_LABEL, AGENT_MODE_LABEL } from '../messenger/labels';
import { useActivity } from '../store/activityStore';
import type { RoomModel } from './useRoomModel';

/**
 * 참여자와 Agent 상태 목록 (aria-live). 상태는 이벤트 로그에서 재구성하므로 타임라인 재생에도 맞는다.
 * 라이브일 때만 휘발성 activity(스트리밍 단계)를 얹는다.
 */
export function AgentStatusList({ model }: { model: RoomModel }) {
  const activityByKey = useActivity((s) => s.byKey);
  const live = useMemo(() => {
    const m = new Map<string, (typeof activityByKey)[string]>();
    if (model.replaying) return m;
    for (const a of Object.values(activityByKey)) if (a.roomId === model.roomId) m.set(a.agentId, a);
    return m;
  }, [activityByKey, model.roomId, model.replaying]);

  // 현재(또는 재생 시점)의 참여자: 구성원 + 방문 중인 사람
  const people = useMemo(() => {
    const ids = new Set<string>();
    if (model.room.kind === 'my' && model.room.ownerId) ids.add(model.room.ownerId);
    for (const id of model.room.memberIds) ids.add(id);
    for (const [id, st] of Object.entries(model.state.members)) if (st.present || ids.has(id)) ids.add(id);
    for (const v of Object.values(model.state.visits)) if (v.visitorKind === 'human' && v.status === 'active') ids.add(v.visitorUserId);
    return [...ids].map((id) => {
      const member = model.state.members[id];
      const visitor = Object.values(model.state.visits).some((v) => v.visitorKind === 'human' && v.status === 'active' && v.visitorUserId === id);
      // 구성원인데 아직 입장 기록이 없으면 presence(WS)로 판단한다
      const present = model.replaying
        ? (member?.present ?? false) || visitor
        : (member ? member.present : model.presence.includes(id)) || visitor;
      return { id, member, present, visitor };
    });
  }, [model]);

  // 마지막 Agent step (재생/라이브 공통, 영속 이벤트)
  const lastStep = useMemo(() => {
    const m = new Map<string, { kind: keyof typeof STEP_LABEL; target?: string }>();
    for (const e of model.events) {
      if (e.type === 'agent_step') m.set(e.agentId, { kind: e.kind, target: e.target });
      else if (e.type === 'agent_turn_ended' || e.type === 'agent_turn_started') m.delete(e.agentId);
    }
    return m;
  }, [model.events]);

  const visitMandate = (agentId: string) =>
    Object.values(model.state.visits).find((v) => v.visitorKind === 'agent' && v.visitorAgentId === agentId && v.status === 'active' && v.mandate)?.mandate ?? null;

  return (
    <section aria-label="참여자와 Agent" data-testid="agent-status-list" className="px-4 py-3">
      <h2 className="text-sm font-semibold">참여자</h2>
      <ul className="mt-2 flex flex-col gap-1.5" aria-live="polite">
        {people.map(({ id, member, present, visitor }) => {
          const u = model.users[id];
          const away = member && !member.present && member.mandate;
          return (
            <li key={id} data-testid="member-row" data-present={present ? 'true' : 'false'} className="flex items-center gap-2.5 text-sm">
              <span className={present ? '' : 'opacity-45'}>
                <Avatar name={u?.name ?? '?'} color={u?.color ?? '#a0aec4'} size={28} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate">{id === model.meId ? `${u?.name ?? '나'} (나)` : (u?.name ?? id)}</span>
                  {visitor && <span className="rounded-full border border-dashed px-1.5 text-[10px] leading-4" style={{ borderColor: u?.color, color: u?.color }}>방문</span>}
                </span>
                <span className="block truncate text-xs text-muted">
                  {present ? '여기 있어요' : away ? `자리 비움 · 위임: ${member.mandate!.text}` : '자리에 없어요'}
                </span>
              </span>
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full"
                style={{ background: present ? (u?.color ?? '#a0aec4') : 'transparent', border: `1px solid ${u?.color ?? '#a0aec4'}` }}
              />
            </li>
          );
        })}
      </ul>

      <h2 className="mt-4 text-sm font-semibold">Agent</h2>
      {model.agents.length === 0 ? (
        <p className="mt-2 text-xs text-muted">이 Room에는 Agent가 없어요.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2" aria-live="polite">
          {model.agents.map((a) => {
            const l = live.get(a.agentId);
            const step = lastStep.get(a.agentId);
            const activity = AGENT_ACTIVITY_LABEL[a.state.activity] ?? a.state.activity;
            const mode = a.visiting ? '방문 온 Agent' : a.state.mode !== 'accompanied' ? AGENT_MODE_LABEL[a.state.mode] : null;
            const ownerName = a.ownerId ? model.users[a.ownerId]?.name : null;
            return (
              <li
                key={a.agentId}
                data-testid="agent-row"
                data-agent-kind={a.kind}
                data-mode={a.state.mode}
                data-activity={a.state.activity}
                data-visiting={a.visiting ? 'true' : 'false'}
                className="flex items-center gap-2.5 rounded-lg border p-2 text-sm"
                style={{ borderColor: `${a.color}66`, borderStyle: a.visiting ? 'dashed' : 'solid' }}
              >
                <AgentAvatar variant={a.variant} color={a.color} size={36} name={a.name} room={a.kind === 'room_agent'} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-medium" style={{ color: a.color }}>
                      {a.name}
                    </span>
                    {mode && (
                      <span data-testid="agent-mode" className="rounded-full px-1.5 text-[10px] leading-4 text-[#0b1020]" style={{ background: a.color }}>
                        {mode}
                      </span>
                    )}
                    {a.kind === 'room_agent' && <span className="rounded border px-1 text-[10px] leading-4" style={{ borderColor: a.color, color: a.color }}>Room Agent</span>}
                  </span>
                  <span className="flex items-center gap-1.5 truncate text-xs text-muted" data-testid="agent-activity">
                    {l ? PHASE_LABEL[l.phase] : activity}
                    {l && <WorkingDots label={PHASE_LABEL[l.phase]} />}
                    {!l && step && (
                      <span>· {step.kind === 'talking' && step.target ? `${model.users[step.target]?.name ?? model.resolveAgent(step.target).name}에게 말함` : STEP_LABEL[step.kind]}</span>
                    )}
                  </span>
                  {ownerName && <span className="block truncate text-[11px] text-muted">소유자 · {ownerName}</span>}
                  {visitMandate(a.agentId) && a.ownerId && (
                    <MandateBlock
                      mandate={visitMandate(a.agentId)!}
                      ownerName={model.users[a.ownerId]?.name ?? ''}
                      color={a.color}
                      viewerIsOwner={a.ownerId === model.meId}
                      compact
                    />
                  )}
                  {a.state.handoverPending && <span className="block text-[11px] text-sky-200/90">소유자에게 인계할 내용이 있어요</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
