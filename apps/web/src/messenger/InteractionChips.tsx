import type { ReactNode } from 'react';
import { INTERACTION_COLORS, INTERACTION_LABEL, type InteractionChannel, type RoomEvent } from '@ensemble/shared';
import { ink } from '../theme';
import { cvar } from '../ui/tg';

/** 배지·범례·툴팁 문구. 약어(A2A/A2H)에 한국어 설명을 붙인다. */
export const CHANNEL_HINT: Record<InteractionChannel, string> = {
  a2a: 'A2A — Agent끼리 주고받음',
  a2h: 'A2H — Agent가 사람에게 묻거나 알림',
  h2a: 'H→A — 사람이 Agent에게 지시·위임',
};

const LEGEND_TEXT: Record<InteractionChannel, string> = { a2a: 'Agent끼리', a2h: 'Agent→사람', h2a: '사람→Agent' };

/** Personal·Room Agent id 판정. 목록에 없어도 이벤트에서 Agent로 행동한 id는 Agent로 본다. */
export function agentIdPredicate(agentIds: readonly string[], events: readonly RoomEvent[]): (id: string) => boolean {
  const set = new Set(agentIds);
  for (const e of events) {
    if ((e.actorKind === 'agent' || e.actorKind === 'room_agent') && e.actorId) set.add(e.actorId);
    if (e.type === 'agent_turn_started') set.add(e.agentId);
  }
  return (id) => set.has(id);
}

/** data-seq 앵커로 스크롤한다(스레드 머리·메시지·승인 카드가 data-seq를 가진다). */
export function scrollToSeq(seq: number): void {
  if (typeof document === 'undefined') return;
  document.querySelector(`[data-seq="${seq}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** 채널 배지. A2A 보라 / A2H 주황 / H→A 흰 테두리 */
export function ChannelBadge({ channel }: { channel: InteractionChannel }) {
  const color = INTERACTION_COLORS[channel];
  const solid = channel !== 'h2a';
  return (
    <span
      data-testid="channel-badge"
      data-channel={channel}
      title={CHANNEL_HINT[channel]}
      className={`tg-chip ${solid ? 'tonal' : ''} !h-[18px] !px-1.5`}
      style={solid ? cvar(color) : { ...cvar(color), boxShadow: `inset 0 0 0 1px ${color}`, color }}
    >
      {INTERACTION_LABEL[channel]}
    </span>
  );
}

export interface Party {
  name: string;
  color: string;
}

/** 방향 칩: `보낸 이 → 받는 이1, 받는 이2` (받는 이마다 그 사람의 색). from을 생략하면 `→ 받는 이`만 그린다. */
export function DirectionChip({ from, to }: { from?: Party; to: readonly Party[] }) {
  if (to.length === 0) return null;
  const tint = from?.color ?? to[0]!.color;
  return (
    <span data-testid="to-chip" className="tg-chip tonal !h-[18px] !px-1.5 !normal-case !tracking-normal" style={{ ...cvar(tint), color: ink(tint) }}>
      {from && <span style={{ color: ink(from.color) }}>{from.name} </span>}→{' '}
      {to.map((p, i) => (
        <span key={`${p.name}${i}`} data-testid="to-chip-target" style={{ color: ink(p.color) }}>
          {i > 0 && ', '}
          {p.name}
        </span>
      ))}
    </span>
  );
}

/** "↳ A2A 결과" 칩: 스레드 밖에서 스레드와의 관계를 알려 준다 */
export function ThreadLinkChip({ label, threadSeq }: { label: string; threadSeq: number | null }) {
  const color = INTERACTION_COLORS.a2a;
  const inner = `↳ ${label}`;
  if (threadSeq === null) {
    return (
      <span data-testid="thread-link" className="text-label" style={{ color }}>
        {inner}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="thread-link"
      onClick={() => scrollToSeq(threadSeq)}
      className="text-label underline-offset-2 hover:underline"
      style={{ color }}
    >
      {inner}
    </button>
  );
}

/**
 * A2A 스레드 묶음. a2a_ask 메시지를 머리로 하고 답을 들여 쓴다.
 * 펼침 여부는 호출한 쪽이 정한다(열린 스레드·최근 스레드 펼침, 사용자 토글 우선).
 * 접힌 상태는 헤더와 `preview` 한 줄만 보인다.
 */
export function A2AThread({
  threadSeq,
  from,
  to,
  answered,
  total,
  open,
  expanded,
  onToggle,
  preview,
  children,
}: {
  threadSeq: number;
  from: Party;
  to: readonly Party[];
  answered: number;
  total: number;
  open: boolean;
  expanded: boolean;
  onToggle?: () => void;
  preview?: string;
  children?: ReactNode;
}) {
  const color = INTERACTION_COLORS.a2a;
  return (
    <li
      data-testid="a2a-thread"
      data-seq={threadSeq}
      data-open={open ? 'true' : 'false'}
      data-expanded={expanded ? 'true' : 'false'}
      className="tg-a2a anim-in !ml-0 flex-col !gap-2"
      style={{ borderLeftColor: color }}
    >
      <button
        type="button"
        data-testid="a2a-thread-header"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex flex-wrap items-center gap-1.5 text-left text-aux hover:opacity-90"
      >
        <ChannelBadge channel="a2a" />
        <span style={{ color: ink(from.color) }} className="font-medium">
          {from.name}
        </span>
        <span className="text-muted">→</span>
        {to.map((p, i) => (
          <span key={`${p.name}${i}`} className="font-medium" style={{ color: ink(p.color) }}>
            {i > 0 && <span className="text-muted"> · </span>}
            {p.name}
          </span>
        ))}
        <span className="text-muted">· </span>
        <span data-testid="a2a-thread-count" style={{ color: open ? color : undefined }} className={open ? '' : 'text-muted'}>
          {open ? `답 ${answered}/${total} 대기 중` : `답 ${answered}/${total}`}
        </span>
        <span aria-hidden="true" className="text-muted">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded ? (
        <ul data-testid="a2a-thread-body" className="flex flex-col gap-2.5">
          {children}
        </ul>
      ) : (
        preview && (
          <p data-testid="a2a-thread-preview" className="truncate text-aux text-muted">
            {preview}
          </p>
        )
      )}
    </li>
  );
}

/** 범례: `A2A Agent끼리 · A2H Agent→사람 · H→A 사람→Agent` */
export function InteractionLegend() {
  const channels: InteractionChannel[] = ['a2a', 'a2h', 'h2a'];
  return (
    <span data-testid="interaction-legend" className="flex shrink-0 items-center gap-2 text-label text-muted">
      {channels.map((c, i) => (
        <span key={c} title={CHANNEL_HINT[c]} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden="true">·</span>}
          <ChannelBadge channel={c} />
          {LEGEND_TEXT[c]}
        </span>
      ))}
    </span>
  );
}
