import type { RoomEvent } from './events';

/**
 * A2A / A2H / H2A 상호작용 분류 (순수 함수). 새 이벤트 타입 없이 기존 이벤트에서 파생한다.
 * - message.recipients / message.replyTo 는 서버가 채우는 선택 필드다.
 */

export type InteractionChannel = 'a2a' | 'a2h' | 'h2a';
export type InteractionKind =
  | 'h2a_direct'
  | 'h2a_delegate'
  | 'a2a_ask'
  | 'a2a_answer'
  | 'a2a_result'
  | 'a2h_ask'
  | 'a2h_report'
  | 'a2h_approval';

export interface Interaction {
  seq: number;
  ts: number;
  kind: InteractionKind;
  channel: InteractionChannel;
  /** 보낸 이. 시스템이 보낸 보고처럼 알 수 없으면 '' */
  fromId: string;
  fromKind: 'human' | 'agent' | 'room_agent';
  toIds: string[];
  /** 속한 A2A 스레드(질문 seq). 없으면 null */
  threadSeq: number | null;
  /** 이 상호작용을 일으킨 사람 이벤트 seq. 못 찾으면 null */
  rootSeq: number | null;
  approvalId?: string;
  /** a2h_approval: 해소 전 / a2a_ask: 스레드가 열려 있음 */
  pending?: boolean;
  /** a2a_ask: 아직 답도 턴 종료도 없는 수신자 */
  waitingFor?: string[];
  /** 레거시 say{to:Agent}(ping·방문 대화). 스레드를 만들지 않는다. */
  legacy?: boolean;
}

export interface A2AThread {
  ask: Interaction;
  answers: Interaction[];
  results: Interaction[];
  approvals: Interaction[];
  open: boolean;
}

export interface InteractionIndex {
  list: Interaction[];
  bySeq: Map<number, Interaction>;
  threads: Map<number, A2AThread>;
  turns: Map<string, { reason: string; triggerSeq: number; agentId: string }>;
  /** rootSeq → 그 사람 이벤트의 actorId (episodeFlow용) */
  rootActors: Map<number, string | null>;
}

const MAX_ROOT_DEPTH = 10;

const fromKindOf = (e: RoomEvent): Interaction['fromKind'] =>
  e.actorKind === 'human' ? 'human' : e.actorKind === 'room_agent' ? 'room_agent' : 'agent';

export function indexInteractions(
  events: readonly RoomEvent[],
  opts: { isAgentId(id: string): boolean },
): InteractionIndex {
  const evBySeq = new Map<number, RoomEvent>();
  const turns: InteractionIndex['turns'] = new Map();
  const approvalReq = new Map<string, RoomEvent>();
  const resolved = new Set<string>();
  const endedTurns = new Set<string>();
  for (const e of events) {
    evBySeq.set(e.seq, e);
    if (e.type === 'agent_turn_started') {
      turns.set(e.turnId, { reason: e.trigger.reason, triggerSeq: e.trigger.seq, agentId: e.agentId });
    } else if (e.type === 'agent_turn_ended') {
      endedTurns.add(e.turnId);
    } else if (e.type === 'approval_requested') {
      approvalReq.set(e.approvalId, e);
    } else if (e.type === 'approval_resolved') {
      resolved.add(e.approvalId);
    }
  }

  const rootActors = new Map<number, string | null>();
  const rootOf = (start: RoomEvent): number | null => {
    let cur: RoomEvent | undefined = start;
    for (let depth = 0; cur && depth <= MAX_ROOT_DEPTH; depth++) {
      if (cur.type === 'approval_resolved') {
        cur = approvalReq.get(cur.approvalId);
        continue;
      }
      if (cur.actorKind === 'human') {
        rootActors.set(cur.seq, cur.actorId);
        return cur.seq;
      }
      const t: { triggerSeq: number } | undefined = cur.turnId ? turns.get(cur.turnId) : undefined;
      if (!t) return null;
      cur = evBySeq.get(t.triggerSeq);
    }
    return null;
  };

  const list: Interaction[] = [];
  const bySeq = new Map<number, Interaction>();
  const threads = new Map<number, A2AThread>();

  const add = (e: RoomEvent, p: Pick<Interaction, 'kind' | 'channel' | 'toIds'> & Partial<Interaction>): Interaction => {
    const it: Interaction = {
      seq: e.seq,
      ts: e.ts,
      fromId: e.actorId ?? '',
      fromKind: fromKindOf(e),
      threadSeq: null,
      rootSeq: rootOf(e),
      ...p,
    };
    list.push(it);
    bySeq.set(it.seq, it);
    return it;
  };

  for (const e of events) {
    switch (e.type) {
      case 'member_left':
        if (e.mandate) add(e, { kind: 'h2a_delegate', channel: 'h2a', fromId: e.userId, toIds: e.agentId ? [e.agentId] : [] });
        break;
      case 'visit_requested':
        if (e.mandate && e.visitorKind === 'agent' && e.visitorAgentId) {
          add(e, { kind: 'h2a_delegate', channel: 'h2a', fromId: e.visitorUserId, fromKind: 'human', toIds: [e.visitorAgentId] });
        }
        break;
      case 'member_rejoined':
        if (e.missedCount > 0) add(e, { kind: 'a2h_report', channel: 'a2h', toIds: [e.userId] });
        break;
      case 'visit_report':
        add(e, { kind: 'a2h_report', channel: 'a2h', toIds: [] });
        break;
      case 'approval_requested': {
        if (e.actorKind !== 'agent' && e.actorKind !== 'room_agent') break;
        const t = e.turnId ? turns.get(e.turnId) : undefined;
        const a2aTurn = t && (t.reason === 'a2a_ask' || t.reason === 'a2a_collect');
        add(e, {
          kind: 'a2h_approval',
          channel: 'a2h',
          toIds: [...e.approvers],
          approvalId: e.approvalId,
          pending: !resolved.has(e.approvalId),
          threadSeq: a2aTurn ? t.triggerSeq : null,
        });
        break;
      }
      case 'message': {
        if (e.actorKind === 'human') {
          if (e.to && opts.isAgentId(e.to)) add(e, { kind: 'h2a_direct', channel: 'h2a', toIds: [e.to] });
          break;
        }
        if (e.actorKind !== 'agent' && e.actorKind !== 'room_agent') break;
        const turnReason = e.turnId ? turns.get(e.turnId)?.reason : undefined;
        if (e.recipients && e.recipients.length > 0) {
          add(e, { kind: 'a2a_ask', channel: 'a2a', toIds: [...e.recipients], threadSeq: e.seq });
        } else if (e.replyTo !== undefined && bySeq.get(e.replyTo)?.kind === 'a2a_ask' && !bySeq.get(e.replyTo)!.legacy) {
          const ask = bySeq.get(e.replyTo)!;
          if (e.actorId !== ask.fromId) {
            add(e, { kind: 'a2a_answer', channel: 'a2a', toIds: [ask.fromId], threadSeq: ask.seq });
          } else if (turnReason === 'a2a_collect' && e.to && !opts.isAgentId(e.to)) {
            add(e, { kind: 'a2h_report', channel: 'a2h', toIds: [e.to], threadSeq: ask.seq });
          } else {
            add(e, { kind: 'a2a_result', channel: 'a2a', toIds: e.to ? [e.to] : [], threadSeq: ask.seq });
          }
        } else if (e.to) {
          if (opts.isAgentId(e.to)) {
            add(e, { kind: 'a2a_ask', channel: 'a2a', toIds: [e.to], legacy: true });
          } else {
            add(e, { kind: turnReason === 'a2a_collect' ? 'a2h_report' : 'a2h_ask', channel: 'a2h', toIds: [e.to] });
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // 스레드 조립
  for (const it of list) {
    if (it.kind === 'a2a_ask' && !it.legacy) {
      threads.set(it.seq, { ask: it, answers: [], results: [], approvals: [], open: false });
    }
  }
  for (const it of list) {
    if (it.threadSeq === null) continue;
    const th = threads.get(it.threadSeq);
    if (!th) continue;
    if (it.kind === 'a2a_answer') th.answers.push(it);
    else if (it.kind === 'a2a_result') th.results.push(it);
    else if (it.kind === 'a2h_approval') th.approvals.push(it);
  }
  // waitingFor: 답도, 해당 ask 에 대한 턴 종료(pass·error 포함)도 없는 수신자
  const settled = new Map<number, Set<string>>();
  const mark = (seq: number, agentId: string) => {
    let s = settled.get(seq);
    if (!s) settled.set(seq, (s = new Set()));
    s.add(agentId);
  };
  for (const th of threads.values()) for (const a of th.answers) mark(th.ask.seq, a.fromId);
  for (const [turnId, t] of turns) {
    if (t.reason === 'a2a_ask' && endedTurns.has(turnId)) mark(t.triggerSeq, t.agentId);
  }
  for (const th of threads.values()) {
    const s = settled.get(th.ask.seq);
    th.ask.waitingFor = th.ask.toIds.filter((id) => !s?.has(id));
    th.open = th.ask.waitingFor.length > 0 && th.results.length === 0;
    th.ask.pending = th.open;
  }

  return { list, bySeq, threads, turns, rootActors };
}

/** 두 캐릭터 사이를 잇는 연결선. 방향은 항상 (질문자·Agent) → (수신자·사람)이고, `reverse`면 펄스가 반대로 흐른다(답). */
export interface InteractionLink {
  fromId: string;
  toId: string;
  channel: InteractionChannel;
  seq: number;
  at: number;
  pending: boolean;
  reverse?: boolean;
}

const H2A_WINDOW_MS = 4000;

/**
 * 지금 그려야 할 연결선.
 * - a2a_ask: 스레드가 열려 있으면 pending, 닫힌 뒤엔 마지막 답 ts부터 window 동안.
 * - a2a_answer: window 동안 reverse (질문자→답한 Agent 변에 역방향 펄스).
 * - a2h_approval: 해소 전까지 pending (Agent → 승인자마다).
 * - a2h_ask / a2h_report: window 동안.
 * - h2a_direct: 4초 동안.
 * - replaying: 시간 감쇠를 끄고 그 시점에 pending인 것과 마지막 상호작용 1개만 남긴다.
 */
export function activeLinks(
  ix: InteractionIndex,
  nowMs: number,
  opts: { replaying?: boolean; windowMs?: number } = {},
): InteractionLink[] {
  const windowMs = opts.windowMs ?? 8000;
  const replaying = opts.replaying === true;
  const fresh = (at: number, win: number) => replaying || nowMs - at < win;
  const out: InteractionLink[] = [];
  const mk = (
    it: Interaction,
    fromId: string,
    toId: string,
    channel: InteractionChannel,
    at: number,
    pending: boolean,
    reverse = false,
  ): InteractionLink => ({ fromId, toId, channel, seq: it.seq, at, pending, ...(reverse ? { reverse: true } : {}) });

  for (const it of ix.list) {
    if (!it.fromId) continue;
    switch (it.kind) {
      case 'a2a_ask': {
        const th = ix.threads.get(it.seq);
        if (!th) {
          if (fresh(it.ts, windowMs)) for (const to of it.toIds) out.push(mk(it, it.fromId, to, 'a2a', it.ts, false));
        } else if (th.open) {
          for (const to of it.toIds) out.push(mk(it, it.fromId, to, 'a2a', it.ts, true));
        } else {
          const last = Math.max(it.ts, ...th.answers.map((a) => a.ts), ...th.results.map((r) => r.ts));
          if (fresh(last, windowMs)) for (const to of it.toIds) out.push(mk(it, it.fromId, to, 'a2a', last, false));
        }
        break;
      }
      case 'a2a_answer':
        if (fresh(it.ts, windowMs) && it.toIds[0]) out.push(mk(it, it.toIds[0], it.fromId, 'a2a', it.ts, false, true));
        break;
      case 'a2h_approval':
        if (it.pending) for (const to of it.toIds) out.push(mk(it, it.fromId, to, 'a2h', it.ts, true));
        break;
      case 'a2h_ask':
      case 'a2h_report':
        if (fresh(it.ts, windowMs)) for (const to of it.toIds) out.push(mk(it, it.fromId, to, 'a2h', it.ts, false));
        break;
      case 'h2a_direct':
        if (fresh(it.ts, H2A_WINDOW_MS)) for (const to of it.toIds) out.push(mk(it, it.fromId, to, 'h2a', it.ts, false));
        break;
      default:
        break;
    }
  }

  if (!replaying) return out;
  const lastSeq = out.reduce((m, l) => (l.pending ? m : Math.max(m, l.seq)), 0);
  return out.filter((l) => l.pending || l.seq === lastSeq);
}

export interface FlowStep {
  seq: number;
  channel: InteractionChannel;
  kind: InteractionKind;
  fromId: string;
  toIds: string[];
  pending: boolean;
}

const FLOW_KINDS: ReadonlySet<InteractionKind> = new Set([
  'h2a_direct',
  'h2a_delegate',
  'a2a_ask',
  'a2h_ask',
  'a2h_report',
  'a2h_approval',
]);

/**
 * 한 에피소드(사람 이벤트 하나가 일으킨 흐름)의 단계 목록. rootSeq를 생략하면 가장 최근 에피소드.
 * 답(a2a_answer)·정리(a2a_result)는 ask 단계(⇄)에 흡수되어 단계로 나오지 않는다.
 */
export function episodeFlow(
  ix: InteractionIndex,
  rootSeq?: number,
): { rootSeq: number; rootActorId: string | null; steps: FlowStep[] } | null {
  let root = rootSeq;
  if (root === undefined) {
    for (let i = ix.list.length - 1; i >= 0; i--) {
      const r = ix.list[i]!.rootSeq;
      if (r !== null) {
        root = r;
        break;
      }
    }
  }
  if (root === undefined) return null;
  const steps: FlowStep[] = ix.list
    .filter((it) => it.rootSeq === root && FLOW_KINDS.has(it.kind))
    .map((it) => ({
      seq: it.seq,
      channel: it.channel,
      kind: it.kind,
      fromId: it.fromId,
      toIds: it.toIds,
      pending: it.pending === true,
    }));
  if (steps.length === 0) return null;
  return { rootSeq: root, rootActorId: ix.rootActors.get(root) ?? null, steps };
}

/** 조망(world preview)에 싣는 "지금 진행 중인 상호작용" 한 건. 내용 텍스트는 담지 않는다. */
export interface PreviewInteraction {
  channel: 'a2a' | 'a2h';
  fromId: string;
  toIds: string[];
  seq: number;
  at: number;
  pending: boolean;
}

export const PREVIEW_INTERACTION_WINDOW_MS = 20000;

/**
 * 조망에 보일 상호작용 하나를 고른다. 미해소 승인(a2h_approval)과 열린 질문(a2a_ask)이 먼저(가장 최근 seq),
 * 없으면 window(20초) 안의 마지막 a2a/a2h. h2a는 제외한다.
 */
export function pickPreviewInteraction(
  ix: InteractionIndex,
  nowMs: number,
  windowMs = PREVIEW_INTERACTION_WINDOW_MS,
): PreviewInteraction | null {
  let pending: Interaction | null = null;
  let recent: Interaction | null = null;
  for (const it of ix.list) {
    if (it.channel === 'h2a' || !it.fromId) continue;
    const open = it.kind === 'a2h_approval' ? it.pending === true : it.kind === 'a2a_ask' ? ix.threads.get(it.seq)?.open === true : false;
    if (open) {
      if (!pending || it.seq > pending.seq) pending = it;
    } else if (nowMs - it.ts < windowMs && (!recent || it.seq > recent.seq)) recent = it;
  }
  const pick = pending ?? recent;
  if (!pick) return null;
  return {
    channel: pick.channel as 'a2a' | 'a2h',
    fromId: pick.fromId,
    toIds: [...pick.toIds],
    seq: pick.seq,
    at: pick.ts,
    pending: pending !== null,
  };
}

export const INTERACTION_COLORS = { a2a: '#8b7bff', a2h: '#ffb45a', h2a: '#e8edf7' } as const;
export const INTERACTION_LABEL = { a2a: 'A2A', a2h: 'A2H', h2a: 'H→A' } as const;
export const INTERACTION_HINT = {
  a2a: 'Agent끼리 묻고 답함',
  a2h: 'Agent가 사람에게 확인·승인 요청',
  h2a: '사람이 Agent에게 지시·위임',
} as const;
