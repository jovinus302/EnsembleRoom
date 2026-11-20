import { useMemo } from 'react';
import { episodeFlow, indexInteractions, INTERACTION_COLORS, INTERACTION_LABEL, type FlowStep, type RoomEvent } from '@ensemble/shared';
import { agentIdPredicate, CHANNEL_HINT, InteractionLegend, scrollToSeq } from '../messenger/InteractionChips';
import { ink } from '../theme';

const CONNECTOR: Record<FlowStep['channel'], string> = { h2a: '─H→A▶', a2a: '═A2A⇄', a2h: '─A2H▶' };

function pendingNote(s: FlowStep): string | null {
  if (!s.pending) return null;
  return s.kind === 'a2h_approval' ? '승인 대기' : s.kind === 'a2a_ask' ? '답 대기' : null;
}

/**
 * RoomView 헤더 아래 얇은 띠: 가장 최근 에피소드의 흐름(사람 → Agent → Agent → 사람).
 * `events`는 replaySeq까지 자른 이벤트라 타임라인 재생을 그대로 반영한다. 상호작용이 없으면 아무것도 그리지 않는다.
 */
export function InteractionStrip({
  events,
  agentIds,
  nameOf,
  onJump = scrollToSeq,
}: {
  events: readonly RoomEvent[];
  agentIds: readonly string[];
  nameOf: (id: string) => string;
  onJump?: (seq: number) => void;
}) {
  const flow = useMemo(() => {
    const ix = indexInteractions(events, { isAgentId: agentIdPredicate(agentIds, events) });
    return episodeFlow(ix);
  }, [events, agentIds]);
  if (!flow) return null;

  const names = (ids: readonly string[]) => (ids.length ? ids.map(nameOf).join(', ') : '');
  const nodes: React.ReactNode[] = [];
  let prevTo: readonly string[] = flow.rootActorId ? [flow.rootActorId] : [];
  if (flow.rootActorId) nodes.push(<span key="root" data-testid="flow-node" className="font-medium">{nameOf(flow.rootActorId)}</span>);

  flow.steps.forEach((s, i) => {
    const color = INTERACTION_COLORS[s.channel];
    if (s.fromId && !prevTo.includes(s.fromId)) {
      nodes.push(
        <span key={`sep${i}`} aria-hidden="true" className="text-muted">
          ·
        </span>,
        <span key={`from${i}`} data-testid="flow-node" className="font-medium">
          {nameOf(s.fromId)}
        </span>,
      );
    }
    const note = pendingNote(s);
    nodes.push(
      <button
        key={`step${i}`}
        type="button"
        data-testid="flow-step"
        data-step-seq={s.seq}
        data-channel={s.channel}
        data-kind={s.kind}
        data-pending={s.pending ? 'true' : 'false'}
        title={CHANNEL_HINT[s.channel]}
        onClick={() => onJump(s.seq)}
        className={`flex items-center gap-1 rounded px-1 hover:bg-hover ${s.pending ? 'animate-pulse' : ''}`}
        style={{ color: ink(color) }}
      >
        <span className="font-mono text-[11px]">{CONNECTOR[s.channel]}</span>
        <span className="sr-only">{INTERACTION_LABEL[s.channel]}</span>
        {names(s.toIds) && <span className="font-medium text-fg">{names(s.toIds)}</span>}
        {note && <span className="text-[10px]">({note})</span>}
      </button>,
    );
    prevTo = s.toIds;
  });

  return (
    <div
      data-testid="interaction-strip"
      aria-label="상호작용 흐름"
      className="pointer-events-auto flex h-8 shrink-0 items-center gap-2 overflow-hidden border-b border-line bg-panel px-5 text-xs backdrop-blur-md"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap">{nodes}</div>
      <InteractionLegend />
    </div>
  );
}
