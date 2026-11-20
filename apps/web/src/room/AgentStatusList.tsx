import { useMemo } from 'react';
import { PHASE_LABEL, STEP_LABEL, WorkingDots } from '../messenger/AgentActivity';
import { AgentAvatar, Avatar } from '../messenger/Avatar';
import { MandateBlock } from '../messenger/MandateBlock';
import { AGENT_ACTIVITY_LABEL, AGENT_MODE_LABEL, AUTO_REPLY_LABEL } from '../messenger/labels';
import { useActivity } from '../store/activityStore';
import type { RoomModel } from './useRoomModel';
import { cvar } from '../ui/tg';

/** 알 수 없는 사용자 초상 배경(SVG 이미지라 CSS 변수를 쓸 수 없다) */
const UNKNOWN_PERSON = '#7f93a3';

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

  // 자동 대리: 이 Room에서 auto_reply 턴을 돈 적이 있는 Agent 중, 소유자가 지금 자리에 없고 명시적 위임(Leave)도 없는 경우
  const autoAgents = useMemo(() => {
    const ids = new Set<string>();
    for (const e of model.events) if (e.type === 'agent_turn_started' && e.trigger.reason === 'auto_reply') ids.add(e.agentId);
    return ids;
  }, [model.events]);
  const isAutoAway = (agentId: string, ownerId: string | null) => {
    if (!ownerId || !autoAgents.has(agentId)) return false;
    const p = people.find((x) => x.id === ownerId);
    return !!p && !p.present && !p.member?.mandate;
  };

  const visitMandate = (agentId: string) =>
    Object.values(model.state.visits).find((v) => v.visitorKind === 'agent' && v.visitorAgentId === agentId && v.status === 'active' && v.mandate)?.mandate ?? null;

  return (
    <section aria-label="참여자와 Agent" data-testid="agent-status-list" className="px-1">
      <h2 className="tg-title">참여자</h2>
      <ul className="mt-2 flex flex-col gap-1" aria-live="polite">
        {people.map(({ id, member, present, visitor }) => {
          const u = model.users[id];
          const away = member && !member.present && member.mandate;
          return (
            <li key={id} data-testid="member-row" data-present={present ? 'true' : 'false'} className="tg-prow">
              <span className="tg-avwrap">
                <span className={present ? '' : 'opacity-45'}>
                  <Avatar name={u?.name ?? '?'} color={u?.color ?? UNKNOWN_PERSON} size={32} />
                </span>
                {present && <span aria-hidden="true" className="tg-pdot" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate font-semibold">{id === model.meId ? `${u?.name ?? '나'} (나)` : (u?.name ?? id)}</span>
                  {visitor && (
                    <span className="tg-chip tag !h-[18px] !px-2" style={cvar(u?.color)}>
                      방문
                    </span>
                  )}
                </span>
                <span className="tg-aux block truncate">
                  {present ? '여기 있어요' : away ? `자리 비움 · 위임: ${member.mandate!.text}` : '자리에 없어요'}
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      <h2 className="tg-title mt-4">Agent</h2>
      {model.agents.length === 0 ? (
        <p className="tg-aux mt-2">이 Room에는 Agent가 없어요.</p>
      ) : (
        <ul className="mt-2.5 flex flex-col gap-2" aria-live="polite">
          {model.agents.map((a) => {
            const l = live.get(a.agentId);
            const step = lastStep.get(a.agentId);
            const activity = AGENT_ACTIVITY_LABEL[a.state.activity] ?? a.state.activity;
            const auto = !a.visiting && isAutoAway(a.agentId, a.ownerId);
            const mode = auto ? AUTO_REPLY_LABEL : a.visiting ? '방문 온 Agent' : a.state.mode !== 'accompanied' ? AGENT_MODE_LABEL[a.state.mode] : null;
            const ownerName = a.ownerId ? model.users[a.ownerId]?.name : null;
            return (
              <li
                key={a.agentId}
                data-testid="agent-row"
                data-agent-kind={a.kind}
                data-mode={auto ? 'auto_reply' : a.state.mode}
                data-activity={a.state.activity}
                data-visiting={a.visiting ? 'true' : 'false'}
                className={`tg-card tg-agcard${a.visiting ? ' visiting' : ''}`}
                style={cvar(a.color)}
              >
                <AgentAvatar variant={a.variant} color={a.color} size={36} name={a.name} room={a.kind === 'room_agent'} ownerName={ownerName} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="tg-agname truncate">{a.name}</span>
                    {mode && (
                      <span data-testid="agent-mode" className="tg-chip tonal !h-[18px] !px-2">
                        {mode}
                      </span>
                    )}
                    <span data-testid="agent-tag" className="tg-chip tag !h-[18px] !px-2">
                      <span aria-hidden="true">✦</span>
                      {a.kind === 'room_agent' ? 'Room Agent' : 'Agent'}
                    </span>
                  </span>
                  <span className={`tg-aux flex items-center gap-1.5 truncate${l ? ' tg-agent-live' : ''}`} data-testid="agent-activity">
                    {l ? PHASE_LABEL[l.phase] : activity}
                    {l && <WorkingDots label={PHASE_LABEL[l.phase]} />}
                    {!l && step && (
                      <span>· {step.kind === 'talking' && step.target ? `${model.users[step.target]?.name ?? model.resolveAgent(step.target).name}에게 말함` : STEP_LABEL[step.kind]}</span>
                    )}
                  </span>
                  {ownerName && <span className="tg-aux block truncate">소유자 · {ownerName}</span>}
                  {visitMandate(a.agentId) && a.ownerId && (
                    <MandateBlock
                      mandate={visitMandate(a.agentId)!}
                      ownerName={model.users[a.ownerId]?.name ?? ''}
                      color={a.color}
                      viewerIsOwner={a.ownerId === model.meId}
                      compact
                    />
                  )}
                  {a.state.handoverPending && <span className="tg-aux block text-info">소유자에게 인계할 내용이 있어요</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
