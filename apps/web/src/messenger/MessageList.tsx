import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildRoomState,
  indexInteractions,
  INTERACTION_COLORS,
  initialAgentState,
  reduceAgentState,
  type AgentDto,
  type AgentMode,
  type AnswerBlock,
  type AgentVisualState,
  type Interaction,
  type ApprovalState,
  type MemoryKind,
  type PauseReason,
  type RoomEvent,
  type UserDto,
} from '@ensemble/shared';
import { sendMessage } from '../api/ws';
import { useActivity, type ActivityEntry } from '../store/activityStore';
import { useRooms, type PendingMessage } from '../store/roomStore';
import { useSession } from '../store/session';
import { useWorld } from '../store/worldStore';
import { PHASE_LABEL, StepTrace, WorkingDots, useTypewriter, type StepInfo } from './AgentActivity';
import { ApprovalCard, approvalViewFromEvents, type ApprovalView } from './ApprovalCards';
import { FALLBACK_COLOR, SYSTEM_COLOR, makeAgentResolver, type AgentResolver } from './agentIdentity';
import { AgentAvatar, AgentTag, Avatar } from './Avatar';
import { A2AThread, agentIdPredicate, ChannelBadge, DirectionChip, ThreadLinkChip, type Party } from './InteractionChips';
import { AUTO_REPLY_LABEL, titleOf } from './labels';
import { isVisitEvent, VisitCard } from './VisitCards';
import { foldVisits } from './visits';
import { ink } from '../theme';
import { btn, cvar } from '../ui/tg';
import { AnswerBlocks } from './answerBlocks/AnswerBlocks';
import { BlockSkeleton } from './answerBlocks/BlockSkeleton';
import { isNearBottom, onContentGrow, sentByMe } from './scrollFollow';

type Author = {
  name: string;
  color: string;
  kind: 'human' | 'agent' | 'room_agent' | 'system';
  variant?: string | null;
  ownerName?: string | null;
};

function resolveAuthor(e: RoomEvent, users: Record<string, UserDto>, resolve: AgentResolver): Author {
  if (e.actorKind === 'human') {
    const u = users[e.actorId ?? ''];
    return { name: u?.name ?? '알 수 없음', color: u?.color ?? FALLBACK_COLOR, kind: 'human' };
  }
  if (e.actorKind === 'agent' || e.actorKind === 'room_agent') return resolveAgent(e.actorId, e.actorKind, resolve, users);
  return { name: '시스템', color: SYSTEM_COLOR, kind: 'system' };
}

/** Personal Agent는 소유자 색, Room Agent는 라임, 시스템은 민트 */
function resolveAgent(agentId: string | null, kind: 'agent' | 'room_agent', resolve: AgentResolver, users: Record<string, UserDto>): Author {
  const a = resolve(agentId, kind);
  return { name: a.name, color: a.color, kind: a.kind, variant: a.variant, ownerName: a.ownerId ? users[a.ownerId]?.name ?? null : null };
}

const PAUSE_LABEL: Record<PauseReason, string> = {
  chain_limit: 'Agent끼리 주고받는 한도에 도달',
  visit_turn_limit: '방문 턴 한도에 도달',
  budget: '사용량 한도에 도달',
};
const MEMORY_KIND_LABEL: Record<MemoryKind, string> = { fact: '사실', preference: '선호', agreement: '합의', summary: '요약' };
const MODE_LABEL: Partial<Record<AgentMode, string>> = { representing: '대리 중', visiting: '방문 중' };


type NoticeTone = 'plain' | 'pause' | 'error' | 'memory' | 'travel' | 'note' | 'agree' | 'report';

/**
 * 새로고침·탭 전환마다 쌓이는 "암묵 퇴장 → 재입장" 쌍을 한 줄로 접는다(표시 수준만, 서버 이벤트는 그대로).
 * 같은 사용자의 암묵 퇴장 바로 다음이 그 사용자의 재입장이면 한 쌍이고, 쌍이 이어지면 한 덩어리로 본다.
 * 덩어리의 첫 이벤트 seq에 요약을 달고 나머지 seq는 건너뛴다.
 */
export function foldImplicitAbsences(events: readonly RoomEvent[]): { skip: Set<number>; runs: Map<number, { userId: string; pairs: number; missed: number }> } {
  const skip = new Set<number>();
  const runs = new Map<number, { userId: string; pairs: number; missed: number }>();
  for (let i = 0; i < events.length; i++) {
    const l = events[i]!;
    if (l.type !== 'member_left' || !l.implicit || skip.has(l.seq)) continue;
    let k = i;
    let pairs = 0;
    let missed = 0;
    for (;;) {
      const a = events[k];
      const b = events[k + 1];
      if (!a || a.type !== 'member_left' || !a.implicit || a.userId !== l.userId) break;
      if (!b || b.type !== 'member_rejoined' || b.userId !== l.userId) break;
      pairs++;
      missed += b.missedCount;
      k += 2;
    }
    if (pairs === 0) continue;
    runs.set(l.seq, { userId: l.userId, pairs, missed });
    for (let j = i + 1; j < k; j++) skip.add(events[j]!.seq);
    i = k - 1;
  }
  return { skip, runs };
}

type VisitEv = Extract<RoomEvent, { type: 'visit_requested' | 'visit_accepted' | 'visit_declined' | 'visit_ended' }>;

type EventItem = {
  key: string;
  kind: 'event';
  seq: number;
  author: Author;
  text: string;
  mine: boolean;
  ts: number;
  turnId: string | null;
  to?: string;
  recipients?: string[];
  interaction?: Interaction;
  mode?: AgentMode;
  auto?: boolean;
  blocks?: AnswerBlock[];
};
type LiveItem = { key: string; kind: 'live'; entry: ActivityEntry; author: Author; mode?: AgentMode; auto?: boolean };
/** A2A 스레드: a2a_ask 메시지가 머리, 답(과 스트리밍 중인 답 턴)은 rows */
type ThreadItem = {
  key: string;
  kind: 'thread';
  seq: number;
  ask: EventItem;
  rows: (EventItem | LiveItem)[];
  open: boolean;
  answered: number;
  total: number;
};

type Item =
  | EventItem
  | { key: string; kind: 'pending'; pending: PendingMessage }
  | { key: string; kind: 'visit'; event: VisitEv }
  | { key: string; kind: 'notice'; text: string; ts: number; tone: NoticeTone }
  | { key: string; kind: 'approval'; view: ApprovalView }
  | LiveItem
  | ThreadItem;

function Bubble({
  text,
  color,
  mine,
  state,
}: {
  text: string;
  color: string;
  mine: boolean;
  /** sent = 확정(채워짐), sending = 보냄(바탕 없음), failed */
  state: 'sent' | 'sending' | 'failed';
}) {
  const sent = state === 'sent';
  return (
    <div
      className={`tg-bubble ${mine ? 'me' : 'other'} ${state === 'failed' ? 'fail' : ''} max-w-[560px] whitespace-pre-wrap break-words`}
      style={{
        ...cvar(color),
        ...(sent ? {} : { background: 'var(--card)', color: 'var(--muted)' }),
      }}
    >
      {text}
    </div>
  );
}

function PendingRow({ p, color }: { p: PendingMessage; color: string }) {
  const state = p.status === 'failed' ? 'failed' : p.status === 'acked' ? 'sent' : 'sending';
  return (
    <li className="flex flex-col items-end gap-1" data-testid="msg-pending" data-state={state}>
      <Bubble text={p.text} color={color} mine state={state} />
      <span className="tg-mono flex items-center gap-2" role={p.status === 'failed' ? 'alert' : undefined}>
        {p.status === 'sending' && '보냄…'}
        {p.status === 'acked' && '확정 중…'}
        {p.status === 'failed' && (
          <>
            <span className="tg-aux normal-case tracking-normal" style={{ color: 'var(--destructive-ink)' }}>
              전송 실패{p.error ? ` · ${p.error}` : ''}
            </span>
            <button type="button" onClick={() => void sendMessage(p.roomId, p.text, p.clientId, p.to)} className={btn('dghost')}>
              다시 시도
            </button>
          </>
        )}
      </span>
    </li>
  );
}

const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

const NOTICE_STYLE: Record<NoticeTone, { glyph: string; cls: string; pill: string }> = {
  plain: { glyph: '·', cls: 'text-muted', pill: '' },
  pause: { glyph: '‖', cls: 'text-warn', pill: 'amber' },
  error: { glyph: '!', cls: 'text-danger', pill: 'err' },
  memory: { glyph: '✦', cls: 'text-ok', pill: '' },
  travel: { glyph: '→', cls: 'text-muted', pill: '' },
  note: { glyph: '✎', cls: 'text-info', pill: '' },
  agree: { glyph: '★', cls: 'text-star', pill: '' },
  report: { glyph: '▤', cls: 'text-info', pill: '' },
};

function NoticeRow({ text, ts, tone }: { text: string; ts: number; tone: NoticeTone }) {
  const st = NOTICE_STYLE[tone];
  return (
    <li data-testid="notice" data-tone={tone} className="anim-in flex justify-center">
      <span className={`tg-notice wrap ${st.pill}`}>
        <span aria-hidden="true" className={st.cls}>
          {st.glyph}
        </span>
        <span>
          {text} <span className="opacity-70">· {fmtTime(ts)}</span>
        </span>
      </span>
    </li>
  );
}

/**
 * Agent 말풍선. 스트리밍 중인 임시 말풍선과 확정 메시지가 같은 컴포넌트·같은 key(turnId)를 써서
 * 턴이 끝나 실제 메시지가 와도 DOM이 바뀌지 않고 이어서 그려진다(깜빡임 없음).
 */
function AgentRow({
  author,
  text,
  streaming,
  phase,
  ts,
  toParties,
  mode,
  auto,
  steps,
  nameOf,
  seq,
  badge,
  reply = false,
  resultLink,
  blocks,
}: {
  author: Author;
  text: string;
  streaming: boolean;
  phase?: ActivityEntry['phase'];
  ts: number;
  toParties?: readonly Party[];
  mode?: AgentMode;
  auto?: boolean;
  steps: readonly StepInfo[];
  nameOf: (id: string) => string;
  seq?: number;
  /** A2A/A2H 채널 배지 (일반 발화에는 달지 않는다) */
  badge?: Interaction['channel'];
  /** A2A 스레드 안의 답: 들여 쓰고 ↩ 와 작은 아바타를 쓴다 */
  reply?: boolean;
  /** 스레드 밖 결과·보고: "↳ A2A 결과" 칩. null이면 링크 없는 칩 */
  resultLink?: number | null;
  /** 답변 카드(구조화 블록) */
  blocks?: readonly AnswerBlock[];
}) {
  // 마운트 때 스트리밍 중이었던 말풍선만 타이핑 연출을 한다(스냅샷 메시지는 즉시 전체 표시).
  const wasLive = useRef(streaming).current;
  const shown = useTypewriter(text, wasLive);
  const typing = streaming || shown.length < text.length;
  const label = phase ? PHASE_LABEL[phase] : PHASE_LABEL.thinking;
  const room = author.kind === 'room_agent' || author.kind === 'system';
  const modeLabel = auto ? AUTO_REPLY_LABEL : mode ? MODE_LABEL[mode] : undefined;
  return (
    <li
      data-testid={streaming ? 'msg-live' : 'msg'}
      data-agent-kind={author.kind}
      data-phase={streaming ? phase : undefined}
      data-seq={seq}
      data-channel={badge}
      className={`anim-in flex gap-2.5 ${reply ? 'pl-6' : ''}`}
    >
      <span className="relative shrink-0">
        {author.kind === 'agent' ? (
          <AgentAvatar variant={author.variant} color={author.color} size={reply ? 28 : 36} name={author.name} ownerName={author.ownerName} />
        ) : author.kind === 'room_agent' ? (
          <AgentAvatar variant={author.variant} color={author.color} size={reply ? 24 : 32} name={author.name} room />
        ) : (
          <Avatar name={author.name} color={author.color} shape={author.kind === 'human' ? 'circle' : 'agent'} />
        )}
        {streaming && (
          <span
            aria-hidden="true"
            className="live-bubble absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full"
            style={{ background: author.color, border: '2px solid var(--popover)', ['--glow' as string]: `${author.color}99` }}
          />
        )}
      </span>
      <div className="flex min-w-0 flex-col items-start gap-1">
        <span className="tg-mono flex flex-wrap items-center gap-1.5">
          {reply && (
            <span aria-hidden="true" data-testid="reply-mark" style={{ color: INTERACTION_COLORS.a2a }}>
              ↩
            </span>
          )}
          {badge && !reply && <ChannelBadge channel={badge} />}
          <span style={{ color: ink(author.color) }}>{author.name}</span>
          {author.kind === 'system' ? (
            <span className="tg-chip tonal !h-[18px] !px-2" style={cvar(author.color)}>
              시스템
            </span>
          ) : (
            <AgentTag color={author.color} room={author.kind === 'room_agent'} />
          )}
          {modeLabel && (
            <span
              data-testid="mode-badge"
              data-mode={auto ? 'auto_reply' : mode}
              className="tg-chip tonal !h-[18px] !px-2"
              style={cvar(author.color)}
            >
              {modeLabel}
            </span>
          )}
          {toParties && toParties.length > 0 && <DirectionChip to={toParties} />}
          {resultLink !== undefined && <ThreadLinkChip label={badge === 'a2h' ? 'A2A 대화의 보고' : 'A2A 결과'} threadSeq={resultLink} />}
          {streaming ? (
            <span className="flex items-center gap-1.5" style={{ color: ink(author.color) }} data-testid="live-label">
              {label}
              <WorkingDots label={label} />
            </span>
          ) : (
            <span className="whitespace-nowrap">{fmtTime(ts)}</span>
          )}
        </span>
        <div
          data-testid="agent-bubble"
          className={`tg-bubble other ${room ? 'room' : 'agent'} max-w-[560px] whitespace-pre-wrap break-words`}
          style={{
            ...cvar(author.color),
            ...(badge === 'a2h' ? { borderLeftColor: INTERACTION_COLORS.a2h } : {}),
          }}
        >
          {shown ? (
            <span className={typing ? 'stream-cursor' : undefined}>{shown}</span>
          ) : (
            <span className="inline-flex items-center gap-2" style={{ color: ink(author.color) }}>
              <WorkingDots label={label} />
              <span className="tg-aux" style={{ color: 'inherit' }}>
                {label}
              </span>
            </span>
          )}
        </div>
        {streaming && phase === 'composing' ? <BlockSkeleton /> : <AnswerBlocks blocks={blocks} />}
        <StepTrace steps={steps} nameOf={nameOf} open={streaming} color={author.color} />
      </div>
    </li>
  );
}

const NO_APPROVALS: Record<string, ApprovalState> = {};

export function MessageList({
  roomId,
  meId,
  users,
  replaySeq = null,
}: {
  roomId: string;
  meId: string;
  users: Record<string, UserDto>;
  /** 타임라인 재생: 이 seq까지의 이벤트만 보인다. 재생 중에는 낙관적 메시지와 휘발성 활동을 숨긴다. */
  replaySeq?: number | null;
}) {
  const slice = useRooms((s) => s.rooms[roomId]);
  const meAgent = useSession((s) => s.agent);
  const allPending = useRooms((s) => s.pending);
  const replaying = replaySeq !== null;
  const pending = useMemo(
    () => (replaying ? [] : allPending.filter((p) => p.roomId === roomId)),
    [allPending, roomId, replaying],
  );
  const activityByKey = useActivity((s) => s.byKey);
  const allEvents = slice?.events;
  const events = useMemo(
    () => (replaySeq === null ? allEvents : allEvents?.filter((e) => e.seq <= replaySeq)),
    [allEvents, replaySeq],
  );
  const agents = slice?.agents;
  const room = useWorld((s) => s.rooms[roomId]);
  const worldRooms = useWorld((s) => s.rooms);
  const visitStates = useMemo(() => foldVisits(events ?? []), [events]);

  const agentList = useMemo(() => agents ?? [], [agents]);
  const resolve = useMemo(
    () => makeAgentResolver(users, agentList, events ?? [], { agent: meAgent }),
    [users, agentList, events, meAgent],
  );
  const nameOf = useMemo(() => (id: string) => users[id]?.name ?? resolve(id).name, [users, resolve]);

  // 이 Room에서 지금 일하는 Agent (휘발성)
  const liveEntries = useMemo(
    () =>
      replaying
        ? []
        : Object.values(activityByKey)
            .filter((a) => a.roomId === roomId)
            .sort((a, b) => a.startedAt - b.startedAt),
    [activityByKey, roomId, replaying],
  );
  const liveSig = liveEntries.reduce((n, a) => n + a.text.length + 1, 0);

  const ix = useMemo(
    () => indexInteractions(events ?? [], { isAgentId: agentIdPredicate(agentList.map((a) => a.id), events ?? []) }),
    [events, agentList],
  );
  /** 사용자가 직접 토글한 스레드(threadSeq 키)가 기본 접기 정책보다 우선한다 */
  const [toggled, setToggled] = useState<Record<number, boolean>>({});
  const latestThread = useMemo(() => Math.max(0, ...ix.threads.keys()), [ix]);

  const approvals = useMemo(() => (events ? buildRoomState(roomId, events).approvals : NO_APPROVALS), [events, roomId]);

  // 메시지 시점의 Agent mode(대리·방문)와 턴별 작업 과정(agent_step)
  const { modeBySeq, stepsByTurn, modeNow, autoTurns } = useMemo(() => {
    const modeBySeq = new Map<number, AgentMode>();
    const autoTurns = new Set<string>();
    const stepsByTurn = new Map<string, StepInfo[]>();
    const states = new Map<string, AgentVisualState>();
    const refOf = (id: string) => {
      const a = agentList.find((x) => x.id === id);
      return { agentId: id, ownerUserId: a?.ownerId ?? null, homeRoomId: null };
    };
    for (const a of agentList) states.set(a.id, initialAgentState(refOf(a.id)));
    const touch = (id: string) => {
      if (!states.has(id)) states.set(id, initialAgentState(refOf(id)));
    };
    for (const e of events ?? []) {
      if ((e.actorKind === 'agent' || e.actorKind === 'room_agent') && e.actorId) touch(e.actorId);
      if ('agentId' in e && typeof e.agentId === 'string') touch(e.agentId);
      for (const [id, st] of states) states.set(id, reduceAgentState(refOf(id), st, e));
      if (e.type === 'agent_turn_started' && (e.trigger.reason === 'auto_reply' || e.trigger.reason === 'a2a_ask')) autoTurns.add(e.turnId);
      if (e.type === 'agent_step') {
        const list = stepsByTurn.get(e.turnId) ?? [];
        list.push({ kind: e.kind, target: e.target });
        stepsByTurn.set(e.turnId, list);
      }
      if (e.type === 'message' && e.actorId && states.has(e.actorId)) modeBySeq.set(e.seq, states.get(e.actorId)!.mode);
    }
    return { modeBySeq, stepsByTurn, autoTurns, modeNow: (id: string) => states.get(id)?.mode };
  }, [events, agentList]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const seenTurns = new Set<string>();
    const roomTitle = (id: string) => {
      const r = worldRooms[id];
      return r ? titleOf(r, meId, users) : '다른 Room';
    };
    const nm = (id: string | null | undefined) => (id ? nameOf(id) : 'Agent');
    const notice = (e: RoomEvent, text: string, tone: NoticeTone) =>
      out.push({ key: `e${e.seq}`, kind: 'notice', text, ts: e.ts, tone });
    const folded = foldImplicitAbsences(events ?? []);
    const threadItems = new Map<number, ThreadItem>();
    for (const e of events ?? []) {
      if (folded.skip.has(e.seq)) continue;
      if (isVisitEvent(e)) {
        out.push({ key: `e${e.seq}`, kind: 'visit', event: e });
        continue;
      }
      switch (e.type) {
        case 'member_left':
        case 'member_rejoined': {
          const name = users[e.userId]?.name ?? '누군가';
          const run = e.type === 'member_left' ? folded.runs.get(e.seq) : undefined;
          if (run) {
            notice(e, `${name}님이 잠깐 자리를 비웠다 돌아왔어요${run.pairs > 1 ? ` · ${run.pairs}회` : ''}${run.missed > 0 ? ` · 놓친 변화 ${run.missed}건` : ''}`, 'plain');
            continue;
          }
          const text =
            e.type === 'member_left'
              ? `${name}님이 ${e.implicit ? '자리를 비웠어요' : 'Leave했어요'}${e.mandate ? ` · 위임: ${e.mandate.text}` : ''}`
              : `${name}님이 돌아왔어요 · 놓친 변화 ${e.missedCount}건`;
          notice(e, text, 'plain');
          continue;
        }
        case 'agent_paused':
          notice(e, `${nm(e.agentId)} · 잠시 멈췄어요 (${PAUSE_LABEL[e.reason]}). 사람이 말을 걸면 다시 시작해요`, 'pause');
          continue;
        case 'agent_turn_ended':
          if (e.result === 'error') notice(e, `${nm(e.agentId)} · 응답 중 오류가 났어요`, 'error');
          continue;
        case 'memory_retained':
          notice(e, `${nm(e.actorId)} · 기억에 저장했어요 (${MEMORY_KIND_LABEL[e.kind]})`, 'memory');
          continue;
        case 'agent_departed':
          notice(e, `${nm(e.agentId)} · ${roomTitle(e.toRoomId)}(으)로 출발했어요`, 'travel');
          continue;
        case 'agent_arrived':
          notice(e, `${nm(e.agentId)} · ${roomTitle(e.fromRoomId)}에서 도착했어요`, 'travel');
          continue;
        case 'agent_returned':
          notice(e, `${nm(e.agentId)} · 돌아왔어요`, 'travel');
          continue;
        case 'agent_owner_note':
          notice(e, `${nm(e.agentId)}의 메모(나에게만 보임) · ${e.note}`, 'note');
          continue;
        case 'visit_report':
          notice(e, `방문 보고(나에게만 보임) · ${e.summary}`, 'report');
          continue;
        case 'visit_takeout':
          notice(e, `방문 Agent가 가져가려는 내용 · ${e.text}`, 'plain');
          continue;
        case 'agreement_formed':
          notice(e, `합의가 이뤄졌어요 · ${e.memberIds.map((m) => users[m]?.name ?? m).join(', ')}`, 'agree');
          continue;
        case 'approval_requested':
          out.push({
            key: `e${e.seq}`,
            kind: 'approval',
            view: {
              ...approvalViewFromEvents(roomId, e, approvals[e.approvalId], nm(e.actorId)),
              ...(ix.bySeq.get(e.seq)?.kind === 'a2h_approval' ? { a2h: { threadSeq: ix.bySeq.get(e.seq)!.threadSeq } } : {}),
            },
          });
          continue;
        case 'message': {
          const author = resolveAuthor(e, users, resolve);
          const isAgent = e.actorKind === 'agent' || e.actorKind === 'room_agent';
          if (e.turnId) seenTurns.add(e.turnId);
          const interaction = ix.bySeq.get(e.seq);
          const item: EventItem = {
            // 같은 턴의 스트리밍 말풍선과 key를 공유해 교체 때 DOM이 유지된다.
            key: isAgent && e.turnId ? `t${e.turnId}` : `e${e.seq}`,
            kind: 'event',
            seq: e.seq,
            author,
            text: e.text,
            mine: e.actorKind === 'human' && e.actorId === meId,
            ts: e.ts,
            turnId: e.turnId,
            to: e.to,
            recipients: e.recipients,
            interaction,
            mode: isAgent ? modeBySeq.get(e.seq) : undefined,
            auto: isAgent && !!e.turnId && autoTurns.has(e.turnId),
            blocks: e.blocks,
          };
          const th = ix.threads.get(e.seq);
          if (th) {
            const thread: ThreadItem = {
              key: `th${e.seq}`,
              kind: 'thread',
              seq: e.seq,
              ask: item,
              rows: [],
              open: th.open,
              total: th.ask.toIds.length,
              answered: th.ask.toIds.length - (th.ask.waitingFor?.length ?? 0),
            };
            threadItems.set(e.seq, thread);
            out.push(thread);
            continue;
          }
          const parent = interaction?.kind === 'a2a_answer' && interaction.threadSeq !== null ? threadItems.get(interaction.threadSeq) : undefined;
          if (parent) {
            parent.rows.push(item);
            continue;
          }
          out.push(item);
          continue;
        }
        default:
          continue;
      }
    }
    for (const p of pending) out.push({ key: `p${p.clientId}`, kind: 'pending', pending: p });
    for (const a of liveEntries) {
      if (seenTurns.has(a.turnId)) continue; // 실제 메시지가 이미 왔다
      const isRoom = agentList.find((x) => x.id === a.agentId)?.kind === 'room';
      const live: LiveItem = {
        key: `t${a.turnId}`,
        kind: 'live',
        entry: a,
        author: resolveAgent(a.agentId, isRoom ? 'room_agent' : 'agent', resolve, users),
        mode: modeNow(a.agentId),
        auto: autoTurns.has(a.turnId),
      };
      // 스레드의 답 턴(a2a_ask)은 스레드 안에서 스트리밍한다
      const turn = ix.turns.get(a.turnId);
      const parent = turn?.reason === 'a2a_ask' ? threadItems.get(turn.triggerSeq) : undefined;
      if (parent) parent.rows.push(live);
      else out.push(live);
    }
    return out;
  }, [events, agentList, pending, users, meId, liveEntries, worldRooms, modeBySeq, autoTurns, modeNow, nameOf, resolve, approvals, roomId, ix]);

  const me = users[meId];
  const endRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLUListElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const toBottom = () => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stick.current = true;
    setShowJump(false);
  };

  // 목록 높이가 변할 때(새 항목·스트리밍·타이핑·카드/이미지 높이) 따라가거나 안내 버튼을 띄운다.
  useEffect(() => {
    const content = contentRef.current;
    const el = scrollerRef.current;
    if (!content || !el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const d = onContentGrow(stick.current);
      if (d.scrollToBottom) el.scrollTop = el.scrollHeight;
      else if (d.showJump && content.childElementCount > 0) setShowJump(true);
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // 항목·스트리밍 텍스트 변화 직후에도 한 번 맞춘다(ResizeObserver 보조)
  useEffect(() => {
    if (stick.current) {
      const el = scrollerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    } else if (items.length > 0) setShowJump(true);
  }, [items.length, liveSig]);

  // 내가 보냄 → 위치와 무관하게 맨 아래
  const prevPending = useRef(pending.length);
  useEffect(() => {
    if (sentByMe(prevPending.current, pending.length)) toBottom();
    prevPending.current = pending.length;
  }, [pending.length]);

  // 방 입장·전환 → 즉시 맨 아래
  useEffect(() => {
    toBottom();
  }, [roomId, slice?.snapshotLoaded]);

  function onScroll() {
    const el = scrollerRef.current;
    if (!el) return;
    const near = isNearBottom(el);
    stick.current = near;
    if (near) setShowJump(false);
  }

  const party = (id: string): Party => ({ name: nameOf(id), color: users[id]?.color ?? resolve(id).color });
  const partiesOf = (it: EventItem): Party[] => (it.recipients ?? (it.to ? [it.to] : [])).map(party);

  function renderAgent(it: EventItem | LiveItem, o: { reply?: boolean; noChannel?: boolean } = {}) {
    if (it.kind === 'live') {
      return (
        <AgentRow
          key={it.key}
          author={it.author}
          text={it.entry.text}
          streaming
          phase={it.entry.phase}
          ts={it.entry.updatedAt}
          mode={it.mode}
          auto={it.auto}
          reply={o.reply}
          steps={stepsByTurn.get(it.entry.turnId) ?? []}
          nameOf={nameOf}
        />
      );
    }
    const kind = it.interaction?.kind;
    const channel = it.interaction?.channel;
    const showBadge = !o.noChannel && !o.reply && !!channel && channel !== 'h2a';
    const outside = !o.reply && it.interaction?.threadSeq != null && (kind === 'a2a_result' || kind === 'a2h_report');
    return (
      <AgentRow
        key={it.key}
        author={it.author}
        text={it.text}
        streaming={false}
        ts={it.ts}
        toParties={o.reply ? undefined : partiesOf(it)}
        mode={it.mode}
        auto={it.auto}
        seq={it.seq}
        badge={showBadge ? channel : undefined}
        reply={o.reply}
        resultLink={outside ? it.interaction!.threadSeq : undefined}
        steps={it.turnId ? (stepsByTurn.get(it.turnId) ?? []) : []}
        nameOf={nameOf}
        blocks={it.blocks}
      />
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={scrollerRef} onScroll={onScroll} data-testid="message-scroller" className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
      {slice?.snapshotLoaded && items.length === 0 && (
        <p className="tg-aux mt-10 text-center">아직 대화가 없습니다. 첫 메시지를 보내 보세요.</p>
      )}
      <ul ref={contentRef} role="log" aria-live="polite" aria-label="메시지" className="flex flex-col gap-3">
        {items.map((it, i) => {
          if (it.kind === 'pending') return <PendingRow key={it.key} p={it.pending} color={me?.color ?? FALLBACK_COLOR} />;
          if (it.kind === 'visit')
            return (
              <VisitCard
                key={it.key}
                event={it.event}
                state={visitStates.get(it.event.visitId)}
                room={room}
                meId={meId}
                users={users}
              />
            );
          if (it.kind === 'notice') return <NoticeRow key={it.key} text={it.text} ts={it.ts} tone={it.tone} />;
          if (it.kind === 'approval')
            return (
              <ApprovalCard key={it.key} view={it.view} meId={meId} users={users} />
            );
          if (it.kind === 'live') return renderAgent(it);
          if (it.kind === 'thread') {
            const th = ix.threads.get(it.seq)!;
            const expanded = toggled[it.seq] ?? (it.open || it.seq === latestThread);
            const lastRow = [...it.rows].reverse().find((r): r is EventItem => r.kind === 'event');
            const preview = lastRow ? `↩ ${lastRow.author.name}: ${lastRow.text}` : it.ask.text;
            return (
              <A2AThread
                key={it.key}
                threadSeq={it.seq}
                from={party(th.ask.fromId)}
                to={th.ask.toIds.map(party)}
                answered={it.answered}
                total={it.total}
                open={it.open}
                expanded={expanded}
                onToggle={() => setToggled((m) => ({ ...m, [it.seq]: !expanded }))}
                preview={preview}
              >
                {renderAgent(it.ask, { noChannel: true })}
                {it.rows.map((r) => renderAgent(r, { reply: true }))}
              </A2AThread>
            );
          }
          if (it.author.kind !== 'human') return renderAgent(it);
          const prev = items[i - 1];
          const grouped = prev?.kind === 'event' && prev.author.name === it.author.name && it.ts - prev.ts < 120_000;
          const humanTo = partiesOf(it);
          const humanBadge = it.interaction?.kind === 'h2a_direct' ? 'h2a' : undefined;
          return (
            <li
              key={it.key}
              data-testid="msg"
              data-seq={it.seq}
              className={`flex gap-2.5 ${it.mine ? 'flex-row-reverse' : ''} ${grouped ? '-mt-1.5' : ''}`}
            >
              {!it.mine && (
                <span className={grouped ? 'invisible' : ''}>
                  <Avatar name={it.author.name} color={it.author.color} shape="circle" />
                </span>
              )}
              <div className={`flex flex-col gap-1 ${it.mine ? 'items-end' : 'items-start'}`}>
                {!grouped && !it.mine && (
                  <span className="tg-mono flex items-center gap-1.5 px-1">
                    {humanBadge && <ChannelBadge channel={humanBadge} />}
                    <span style={{ color: ink(it.author.color) }}>{it.author.name}</span>
                    <DirectionChip to={humanTo} />
                    <span className="whitespace-nowrap">{fmtTime(it.ts)}</span>
                  </span>
                )}
                <Bubble text={it.text} color={it.author.color} mine={it.mine} state="sent" />
                {it.mine && !grouped && (
                  <span className="tg-mono flex items-center gap-1.5 px-1">
                    {humanBadge && <ChannelBadge channel={humanBadge} />}
                    <DirectionChip to={humanTo} />
                    {fmtTime(it.ts)}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div ref={endRef} />
    </div>
    {showJump && (
      <button
        type="button"
        data-testid="jump-to-latest"
        onClick={toBottom}
        className="tg-jump absolute bottom-3 left-1/2 -translate-x-1/2"
      >
        새 메시지 ↓
      </button>
    )}
    </div>
  );
}
