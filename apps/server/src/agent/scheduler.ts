import { buildRoomState, type RoomEvent, type ToolName } from '@ensemble/shared';
import type { AppContext } from '../context';
import { AGENT_DEFAULTS } from '../config';
import { endVisit } from '../domain/visits';
import { resolveSubject, roomStateOf, type ActorCtx } from '../domain/rooms';
import { a2aLimitsOf, askableAgents, isAutoAway } from './a2a';
import { AUTO_REPLY_MAX_AGENTS, isTrivialReaction } from './rules';
import { newTurnId, runTurn, type TurnGate, type TurnJob } from './runTurn';
import type { AgentProvider, Trigger, TriggerReason, TurnOutcome } from './types';

/**
 * 결정적 스케줄러 (계획 6절 트리거 규칙). LLM으로 발언자를 고르지 않는다.
 *  1. 사람 이벤트(message, card 계열, point): chainCount=0, 대상은 to/point → my Room 소유자 발언이면 소유자 Agent
 *     → 소유자 부재 중 방문자 발언이면 호스트 Agent → Our Room은 Room Agent(질문·"정리"·부재 구성원 언급)
 *  2. Agent 이벤트: `to`로 지정된 다른 Agent만. chainCount+1, AGENT_CHAIN_LIMIT에 도달하면 agent_paused
 *  3. agent_arrived → 방문 Agent에게 도착 턴 1회
 *  4. 방문 턴 수가 VISIT_MAX_TURNS에 도달하면 end_visit만 허용하는 턴을 강제
 *  5. Room당 턴은 직렬. 대기열 중복 제거. Agent는 자기 이벤트로 깨어나지 않는다. 시간당 MAX_TURNS_PER_ROOM_HOUR
 *  6. 트리거 판정 직후 LLM 호출 전에 agent_turn_started를 동기로 append (startJob)
 *
 * 확장(계획에 명시되지 않은 부분):
 *  - 방문 중인 Agent는 호스트 Room의 사람 발언(to가 없거나 자기에게)에도 깨어난다 (mandate 안에서 스스로 참여).
 *  - Our Room에서 대리 참여 중(Leave+mandate)인 구성원의 Agent는 그 구성원이 언급되거나 질문이 나오면 깬다.
 *  - AGENT_AUTO_REPLY(기본 on): Our Room의 사람 메시지는 Room Agent를 항상 깨우고, 접속하지 않은(명시적 Leave 아님) 구성원의 Agent는
 *    이름 언급·지정(to)이면 지목된 부재 구성원 모두, 모두에게 한 말이면(2글자 이하 반응 제외) 구성원 순서대로 최대 2명을 'auto_reply'로 깨운다.
 *    시드 사용자(엄마·Dana)의 Agent도 대상(항상 부재). 구성원이 present가 되면 대기 작업도 버린다.
 *    구성원이 이름으로 지목된 메시지는 Room Agent를 명시적으로 부르지 않는 한(ROOM_CALL) Room Agent가 끼어들지 않는다.
 *  - A2A(AGENT_A2A, 기본 on): Agent가 ask_agents로 보낸 질문(message.recipients)은 수신 Agent마다 'a2a_ask' 턴을 1회 준다.
 *    대기열에 있던 같은 Agent의 auto_reply 등은 이 턴으로 제자리 교체한다. 답(message.replyTo)은 아무도 깨우지 않는다.
 *    수신자 전원이 끝나면(버려진 job 포함) 질문자에게 'a2a_collect' 턴을 1회 준다(fan-in).
 *    한도: 에피소드(사람 발언 1건)당 ask 1라운드, 팬아웃 3, a2a 턴 6(초과 시 agent_paused chain_limit). a2a 턴은 chainCount를 건드리지 않는다.
 */

const HUMAN_CONTENT = new Set(['message', 'card_created', 'card_updated', 'comment_added', 'card_pointed']);
const HOUR = 60 * 60 * 1000;

interface Queue {
  running: boolean;
  jobs: TurnJob[];
}

export interface SchedulerLimits {
  chainLimit: number;
  visitMaxTurns: number;
  maxTurnsPerRoomHour: number;
}

export function limitsOf(ctx: AppContext): SchedulerLimits {
  return {
    chainLimit: ctx.config.agentChainLimit ?? AGENT_DEFAULTS.agentChainLimit,
    visitMaxTurns: ctx.config.visitMaxTurns ?? AGENT_DEFAULTS.visitMaxTurns,
    maxTurnsPerRoomHour: ctx.config.maxTurnsPerRoomHour ?? AGENT_DEFAULTS.maxTurnsPerRoomHour,
  };
}

/** 순번대로 이어지는 실행 게이트: i번째는 i-1번째가 done()을 부른 뒤에 wait()가 풀린다 */
function makeGates(n: number): TurnGate[] {
  let prev: Promise<void> = Promise.resolve();
  return Array.from({ length: n }, () => {
    const before = prev;
    let release!: () => void;
    prev = new Promise<void>((r) => (release = r));
    let once = false;
    return {
      wait: () => before,
      done: () => {
        if (!once) {
          once = true;
          release();
        }
      },
    };
  });
}

const QUESTION =/[?？]|정리|요약|summar/i;

/** 다른 구성원 Agent와의 조율을 발화자 본인 Agent에게 시키는 동사 표현 */
const DELEGATE_VERB = /맞춰\s*줘|물어\s*봐\s*줘|알아\s*봐\s*줘|조율해\s*줘/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Room Agent를 명시적으로 부르는 표현 */
const ROOM_CALL = /룸\s*에이전트|룸\s*봇|room\s*agent|@room\b/i;

export class Scheduler {
  private chain = new Map<string, number>();
  private chainPaused = new Set<string>();
  private queues = new Map<string, Queue>();
  private turnLog = new Map<string, number[]>();
  private inflight = new Set<Promise<void>>();
  private unsubscribe: (() => void) | null = null;
  private turnListeners = new Set<(o: TurnOutcome) => void>();
  /** 진행 중인 턴의 중단 제어 (서버 종료·Agent 일시정지 시 abort) */
  private running = new Map<string, { agentId: string; roomId: string; ctl: AbortController }>();
  private stopped = false;
  /** A2A 에피소드(사람 content 이벤트마다 리셋): ask 라운드와 a2a 턴 수 */
  private episodes = new Map<string, { rounds: number; a2aTurns: number; turns: number; boardTool: boolean }>();
  /** 승인 해소가 여는 확정 에피소드(Room당): 해소로 깨어난 턴 수. 사람의 content 이벤트가 오면 지운다 */
  private resolutions = new Map<string, { turns: number }>();
  /** 정산 대기 중인 A2A 질문 (key: `${roomId}:${askSeq}`) */
  private asks = new Map<string, { roomId: string; askerId: string; askerKind: 'personal' | 'room_agent'; waiting: Set<string>; event: RoomEvent }>();

  constructor(
    private readonly ctx: AppContext,
    private readonly getProvider: () => AgentProvider,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.stopped = false;
    this.unsubscribe = this.ctx.store.onAppended((e) => this.onEvent(e));
  }

  /** 구독을 끊고 대기 중인 턴을 버리며 진행 중인 턴을 중단한다(provider 호출에 AbortSignal이 전달된다). */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopped = true;
    for (const q of this.queues.values()) q.jobs.length = 0;
    for (const r of this.running.values()) r.ctl.abort();
    this.episodes.clear();
    this.resolutions.clear();
    this.asks.clear();
  }

  /** 이 Agent의 진행 중인 턴을 중단한다 (일시정지) */
  abortAgent(agentId: string): void {
    for (const r of this.running.values()) if (r.agentId === agentId) r.ctl.abort();
  }

  onTurnEnded(l: (o: TurnOutcome) => void): () => void {
    this.turnListeners.add(l);
    return () => this.turnListeners.delete(l);
  }

  /** 진행 중이거나 대기 중인 턴이 모두 끝날 때까지 기다린다 (테스트·종료용) */
  async drain(): Promise<void> {
    while (this.inflight.size > 0 || [...this.queues.values()].some((q) => q.jobs.length > 0 || q.running)) {
      await Promise.allSettled([...this.inflight]);
      await Promise.resolve();
    }
  }

  chainCount(roomId: string): number {
    return this.chain.get(roomId) ?? 0;
  }

  /* ------------------------------ 트리거 판정 ------------------------------ */

  onEvent(e: RoomEvent): void {
    try {
      // 한 이벤트가 만든 job들을 모두 큐에 넣은 뒤 펌프한다(같은 질문의 답 턴을 한 묶음으로 병렬 호출하기 위해)
      const jobs = this.triggersFor(e);
      for (const job of jobs) this.enqueue(job, false);
      for (const roomId of new Set(jobs.map((j) => j.roomId))) this.pump(roomId);
    } catch (err) {
      console.error('[scheduler] trigger failed', err);
    }
  }

  private job(roomId: string, agentId: string, reason: TriggerReason, e: RoomEvent): TurnJob | null {
    const { repo } = this.ctx;
    const personal = repo.getAgent(agentId);
    const roomAgent = personal ? undefined : repo.getRoomAgent(agentId);
    if (!personal && !roomAgent) return null;
    const trigger: Trigger = { seq: e.seq, reason, event: e };
    return { roomId, agentId, agentKind: personal ? 'personal' : 'room_agent', trigger, forced: null };
  }

  /** 지금 이 Room에서 턴을 돌 수 있는 Agent인가 */
  private runnable(roomId: string, agentId: string): boolean {
    const { repo } = this.ctx;
    const room = repo.getRoom(roomId);
    if (!room || room.kind === 'dm') return false;
    const personal = repo.getAgent(agentId);
    let actor: ActorCtx;
    if (personal) {
      // 시드 사용자(엄마·Dana)의 Agent도 자동 대리(auto_reply)로 돈다. 승인해 줄 사람이 없으므로
      // request_approval만 막는다(tools.ts의 toolsForTurn noApproval). 다른 트리거(방문 등)는 그대로 허용되지만 시드는 방문하지 않는다.
      const open = repo.findOpenAgentVisit(agentId);
      if (open?.status === 'active' && open.hostRoomId !== roomId) return false; // 방문 중에는 집에서 움직이지 않는다
      actor = { kind: 'agent', agentId };
    } else if (repo.getRoomAgent(agentId)) {
      actor = { kind: 'room_agent', roomAgentId: agentId };
    } else return false;
    return resolveSubject(this.ctx, room, actor) !== null;
  }

  private triggersFor(e: RoomEvent): TurnJob[] {
    const { repo, store } = this.ctx;
    const room = repo.getRoom(e.roomId);
    if (!room || room.kind === 'dm') return [];

    // 3. 방문 도착
    if (e.type === 'agent_arrived') {
      if (!this.runnable(e.roomId, e.agentId)) return [];
      const j = this.job(e.roomId, e.agentId, 'arrival', e);
      return j ? [j] : [];
    }

    // 내가 올린 승인이 해소되면 요청한 Agent를 깨워 결과를 이어서 처리하게 한다.
    //  - decision: 결과를 이어서 처리(propose_edit·마무리)
    //  - edit(Our Room, 승인·수정 반영): 확정 단계의 마무리 턴(say/pass만, closing)
    if (e.type === 'approval_resolved') {
      // 승인 해소는 사람의 투표로만 일어나므로 각 해소가 새 확정 에피소드의 루트다: 승인 1건당 카운터를 새로 시작한다
      this.resolutions.delete(e.roomId);
      const row = repo.getApproval(e.approvalId);
      if (!row || !row.requestedBy || row.roomId !== e.roomId) return [];
      const closing = row.kind === 'edit' && room.kind === 'our' && (e.outcome === 'approved' || e.outcome === 'edited');
      if (row.kind !== 'decision' && !closing) return [];
      if (!this.runnable(e.roomId, row.requestedBy)) return [];
      const j = this.job(e.roomId, row.requestedBy, 'approval_resolved', e);
      return j ? [closing ? { ...j, closing: true } : j] : [];
    }

    if (!HUMAN_CONTENT.has(e.type)) return [];

    // 2. Agent 이벤트
    if (e.actorKind === 'agent' || e.actorKind === 'room_agent') {
      // A2A: 질문은 수신 Agent를 깨우고, 답(replyTo)은 아무도 깨우지 않는다. 레거시 to 판정보다 먼저 본다.
      if (e.type === 'message' && e.recipients?.length) return this.onAsk(e);
      if (e.type === 'message' && e.replyTo !== undefined) return [];
      if (e.type !== 'message' || !e.to || e.to === e.actorId) return [];
      if (!this.runnable(e.roomId, e.to)) return [];
      const n = this.chainCount(e.roomId) + 1;
      this.chain.set(e.roomId, n);
      if (n >= this.limits().chainLimit) {
        if (!this.chainPaused.has(e.roomId)) {
          this.chainPaused.add(e.roomId);
          this.appendPaused(e.roomId, e.to, 'chain_limit');
        }
        return [];
      }
      const j = this.job(e.roomId, e.to, 'agent_chain', e);
      return j ? [j] : [];
    }

    if (e.actorKind !== 'human') return [];

    // 1. 사람 이벤트
    this.chain.set(e.roomId, 0);
    this.chainPaused.delete(e.roomId);
    this.episodes.delete(e.roomId);
    this.resolutions.delete(e.roomId);

    const targets: { agentId: string; reason: TriggerReason }[] = [];
    const add = (agentId: string | undefined, reason: TriggerReason) => {
      if (agentId && agentId !== e.actorId && !targets.some((t) => t.agentId === agentId)) targets.push({ agentId, reason });
    };

    const explicit = e.type === 'message' ? e.to : e.type === 'card_pointed' ? e.toAgentId : undefined;
    let cached: ReturnType<typeof buildRoomState> | null = null;
    const state = () => (cached ??= buildRoomState(room.id, store.listAll(room.id)));
    if (explicit) {
      // 지정이 있으면 그 Agent만. 사람에게 한 말이면 Agent는 깨우지 않는다(자동 대리 대상 구성원에게 한 말은 예외).
      const personal = repo.getAgent(explicit);
      if (personal || repo.getRoomAgent(explicit)) {
        const away =
          e.type === 'message' && personal && personal.ownerId !== e.actorId && room.kind === 'our' && this.autoReplyOn() && this.isAutoAway(room.id, personal.ownerId, state());
        add(explicit, e.type === 'card_pointed' ? 'pointed' : away ? 'auto_reply' : 'addressed');
      } else if (e.type === 'message' && room.kind === 'our' && this.autoReplyOn() && repo.isMember(room.id, explicit) && explicit !== e.actorId) {
        if (this.isAutoAway(room.id, explicit, state())) add(repo.getAgentByOwner(explicit)?.id, 'auto_reply');
      }
    } else {
      const st = state();
      const text = e.type === 'message' ? e.text : '';
      if (room.kind === 'my' && room.ownerId) {
        const ownerAgent = repo.getAgentByOwner(room.ownerId);
        if (e.actorId === room.ownerId) {
          add(ownerAgent?.id, 'owner_message');
        } else if (!st.members[room.ownerId]?.present) {
          add(ownerAgent?.id, 'visitor_message');
        }
        // 방문 중인 Agent: 호스트 Room의 사람 발언에 스스로 참여
        for (const v of repo.listVisitsByHost(room.id)) {
          if (v.visitorKind === 'agent' && v.status === 'active') add(v.visitorAgentId ?? undefined, 'host_message');
        }
      } else if (room.kind === 'our') {
        const ra = repo.getRoomAgentByRoom(room.id);
        const members = repo.memberIds(room.id);
        const absent = members.filter((m) => {
          const ms = st.members[m];
          return !ms || !ms.present;
        });
        const mentionsAbsent = absent.some((m) => {
          const n = repo.getUser(m)?.name;
          return !!n && text.includes(n);
        });
        const auto = this.autoReplyOn() && e.type === 'message';
        // 발화자 외 구성원이 이름으로 지목됐는가 (표시 이름 포함 여부: "Alice,", "Alice야", "@Alice", 문중 언급 모두)
        const lowerText = text.toLowerCase();
        const namedMembers = members.filter((m) => {
          const n = repo.getUser(m)?.name?.toLowerCase();
          return m !== e.actorId && !!n && lowerText.includes(n);
        });
        // 자동 반응: 사람이 보낸 모든 메시지에 Room Agent가 깬다(할 말이 없으면 스스로 pass).
        // 단 구성원이 지목된 메시지는 그 구성원(또는 그 Agent)이 답할 일이라, Room Agent를 명시적으로 부르지 않았다면 끼어들지 않는다.
        // "내 Agent에게 맡김": 다른 구성원의 Agent를 지목해(또는 맞춰 달라고) 시킨 말은 발화자 자신의 Agent가 맡아 그 Agent에게 묻는다.
        const ownAgent = e.type === 'message' && e.actorId ? repo.getAgentByOwner(e.actorId) : undefined;
        const delegated =
          !!ownAgent &&
          namedMembers.length > 0 &&
          (namedMembers.some((m) => {
            const n = repo.getUser(m)?.name;
            return !!n && new RegExp(`${escapeRe(n)}\\s*(의)?\\s*(agent|에이전트)`, 'i').test(text);
          }) ||
            DELEGATE_VERB.test(text));
        if (delegated) add(ownAgent!.id, 'addressed');
        const roomAgentWanted = auto && namedMembers.length > 0 ? ROOM_CALL.test(text) : QUESTION.test(text) || mentionsAbsent || auto;
        if (ra && roomAgentWanted && !(delegated && !ROOM_CALL.test(text))) add(ra.id, 'room_agent_call');
        // 대리 참여 중인 구성원의 Agent
        for (const m of members) {
          const ms = st.members[m];
          if (!ms || ms.present || !ms.mandate || m === e.actorId) continue;
          const n = repo.getUser(m)?.name;
          if (QUESTION.test(text) || (n && text.includes(n))) add(repo.getAgentByOwner(m)?.id, 'representing');
        }
        // 자동 대리: 접속하지 않은(명시적 Leave 아님) 구성원의 Agent를 깨운다.
        // (a) 이름이 언급된 구성원이 있으면 그 부재 구성원 전원
        // (b) 모두에게 한 말이면 구성원 순서대로 최대 AUTO_REPLY_MAX_AGENTS명 (질문이 아닌 잡담도 포함, 2글자 이하 반응은 제외)
        // 시드 사용자(엄마, Dana)는 로그인하지 않으므로 항상 부재 → 대리 대상. 사람 메시지 1건당 각 Agent는 최대 1턴.
        if (auto && !delegated) {
          const cands = members.filter((m) => m !== e.actorId && this.isAutoAway(room.id, m, st));
          const named = cands.filter((m) => namedMembers.includes(m));
          const picks = named.length > 0 ? named : isTrivialReaction(text) ? [] : cands.slice(0, AUTO_REPLY_MAX_AGENTS);
          for (const pick of picks) add(repo.getAgentByOwner(pick)?.id, 'auto_reply');
        }
      }
    }

    const jobs: TurnJob[] = [];
    for (const t of targets) {
      if (!this.runnable(room.id, t.agentId)) continue;
      const j = this.job(room.id, t.agentId, t.reason, e);
      if (j) jobs.push(j);
    }
    return jobs;
  }

  private episode(roomId: string) {
    let ep = this.episodes.get(roomId);
    if (!ep) this.episodes.set(roomId, (ep = { rounds: 0, a2aTurns: 0, turns: 0, boardTool: false }));
    return ep;
  }

  /** Agent의 ask_agents 질문: 수신 Agent마다 답 턴(a2a_ask) job을 만든다. 수신자가 없으면 바로 정리 턴. */
  private onAsk(e: Extract<RoomEvent, { type: 'message' }>): TurnJob[] {
    const lim = a2aLimitsOf(this.ctx);
    if (!lim.on || !e.actorId) return [];
    const ep = this.episode(e.roomId);
    if (ep.rounds >= lim.maxRounds) return [];
    ep.rounds++;
    const askerKind: 'personal' | 'room_agent' = e.actorKind === 'agent' ? 'personal' : 'room_agent';
    const wanted = new Set(e.recipients ?? []);
    // askable(구성원 순서, runnable 포함)와 질문의 수신자의 교집합 중 앞의 fanoutMax명
    const recipients = askableAgents(this.ctx, e.roomId, e.actorId)
      .map((a) => a.id)
      .filter((id) => wanted.has(id))
      .slice(0, lim.fanoutMax);
    const key = `${e.roomId}:${e.seq}`;
    const base = { askSeq: e.seq, askerId: e.actorId, askerKind } as const;
    this.asks.set(key, { roomId: e.roomId, askerId: e.actorId, askerKind, waiting: new Set(recipients), event: e });
    if (recipients.length === 0) {
      this.asks.delete(key);
      const c = this.collectJob(e.roomId, base, e);
      return c ? [c] : [];
    }
    const jobs: TurnJob[] = [];
    for (const id of recipients) {
      const j = this.job(e.roomId, id, 'a2a_ask', e);
      if (j) jobs.push({ ...j, ask: { ...base, role: 'answer' } });
      else this.asks.get(key)?.waiting.delete(id);
    }
    return jobs;
  }

  private collectJob(roomId: string, base: { askSeq: number; askerId: string; askerKind: 'personal' | 'room_agent' }, ev: RoomEvent): TurnJob | null {
    if (!this.runnable(roomId, base.askerId)) return null;
    const j = this.job(roomId, base.askerId, 'a2a_collect', ev);
    return j ? { ...j, ask: { ...base, role: 'collect' } } : null;
  }

  /** 답 턴이 끝났거나 버려졌다: 대기 목록에서 빼고, 모두 정산되면 질문자에게 정리 턴을 준다(fan-in). */
  private settleAsk(job: TurnJob): void {
    if (!job.ask || job.ask.role !== 'answer') return;
    const key = `${job.roomId}:${job.ask.askSeq}`;
    const a = this.asks.get(key);
    if (!a) return;
    a.waiting.delete(job.agentId);
    if (a.waiting.size > 0) return;
    this.asks.delete(key);
    const c = this.collectJob(a.roomId, { askSeq: job.ask.askSeq, askerId: a.askerId, askerKind: a.askerKind }, a.event);
    if (c) this.enqueue(c);
  }

  private limits(): SchedulerLimits {
    return limitsOf(this.ctx);
  }

  private autoReplyOn(): boolean {
    return this.ctx.config.agentAutoReply ?? true;
  }

  /**
   * 자동 대리 대상인가: 지금 이 Room에 접속(present)하지 않았고 명시적 Leave도 하지 않은 구성원.
   * 한 번도 들어온 적 없거나 암묵적 퇴장(구독 끊김)만 한 사람이다. 명시적 Leave(위임 있든 없든)는 해당하지 않는다.
   */
  private isAutoAway(roomId: string, userId: string, state: ReturnType<typeof buildRoomState>): boolean {
    return isAutoAway(this.ctx, roomId, userId, state);
  }

  private appendPaused(roomId: string, agentId: string, reason: 'chain_limit' | 'budget' | 'visit_turn_limit'): void {
    const isPersonal = !!this.ctx.repo.getAgent(agentId);
    try {
      this.abortAgent(agentId);
      this.ctx.store.append({
        roomId,
        actorKind: isPersonal ? 'agent' : 'room_agent',
        actorId: agentId,
        type: 'agent_paused',
        agentId,
        reason,
      });
    } catch (err) {
      console.error('[scheduler] agent_paused failed', err);
    }
  }

  /* ------------------------------ 큐 / 실행 ------------------------------ */

  enqueue(job: TurnJob, pump = true): void {
    if (this.stopped) return;
    let q = this.queues.get(job.roomId);
    if (!q) this.queues.set(job.roomId, (q = { running: false, jobs: [] }));
    // 대기열 중복 제거: 같은 Agent의 대기 턴은 하나만 (강제 턴은 항상 우선 보존)
    const dup = q.jobs.findIndex((j) => j.agentId === job.agentId);
    if (dup >= 0) {
      const old = q.jobs[dup]!;
      if (job.forced && !old.forced) q.jobs[dup] = job;
      // A2A 승격: 대기 중이던 일반 job(auto_reply 등)을 질문 job으로 제자리 교체한다(큐 위치 유지). forced·다른 ask job은 건드리지 않는다.
      else if (job.ask && !old.forced && !old.ask) q.jobs[dup] = job;
      // 교체도 못 하고 버려지는 답 job은 정산한다(fan-in이 멈추지 않게)
      else if (job.ask?.role === 'answer') this.settleAsk(job);
      return;
    }
    q.jobs.push(job);
    if (pump) this.pump(job.roomId);
  }

  private visitOf(roomId: string, agentId: string) {
    const v = this.ctx.repo.findOpenAgentVisit(agentId);
    return v && v.status === 'active' && v.hostRoomId === roomId ? v : undefined;
  }

  /** 이 방문에서 Agent가 시작한 턴 수 */
  visitTurnCount(roomId: string, agentId: string, startSeq: number | null): number {
    return this.ctx.store
      .listAll(roomId, { afterSeq: Math.max(0, (startSeq ?? 1) - 1) })
      .filter((e) => e.type === 'agent_turn_started' && e.agentId === agentId).length;
  }

  private pump(roomId: string): void {
    const q = this.queues.get(roomId);
    if (!q || q.running) return;
    for (;;) {
      if (q.running) return; // settleAsk가 버려진 job 정산 중에 enqueue→pump로 다음 턴을 이미 시작했을 수 있다
      const first = q.jobs.shift();
      if (!first) return;
      // 같은 질문(askSeq)의 답 턴이 큐 앞에 이어져 있으면 한 묶음으로 꺼내 병렬로 호출한다. 기록은 수신자 순서(게이트)로 한다.
      const batch: TurnJob[] = [first];
      if (first.ask?.role === 'answer') {
        while (q.jobs[0]?.ask?.role === 'answer' && q.jobs[0].ask.askSeq === first.ask.askSeq) batch.push(q.jobs.shift()!);
      }
      // 시작하는 동안 settleAsk→enqueue→pump가 끼어들지 못하게 막는다
      q.running = true;
      const gates = batch.length > 1 ? makeGates(batch.length) : null;
      const runs: { job: TurnJob; started: Promise<TurnOutcome> }[] = [];
      try {
        batch.forEach((job, i) => {
          let started: Promise<TurnOutcome> | null = null;
          try {
            started = this.startJob(job, gates?.[i]);
          } catch (err) {
            console.error('[scheduler] startJob threw', err);
          }
          if (!started) {
            gates?.[i]!.done();
            this.settleAsk(job); // 버려진 A2A 답 job도 정산한다
          } else runs.push({ job, started });
        });
      } catch (err) {
        q.running = false;
        throw err;
      }
      if (runs.length === 0) {
        q.running = false;
        continue; // 버려진 작업: 다음 것
      }
      const p: Promise<void> = Promise.all(
        runs.map(({ job, started }) =>
          started.then((outcome) => this.afterTurn(job, outcome)).catch((err) => console.error('[scheduler] turn crashed', err)),
        ),
      ).then(() => {
        this.inflight.delete(p);
        q.running = false;
        this.pump(roomId);
      });
      this.inflight.add(p);
      return;
    }
  }

  /**
   * 트리거 판정 직후, LLM 호출 전에 `agent_turn_started`를 동기로 append하고 턴을 시작한다.
   * 한도에 걸리면 null.
   */
  private startJob(job: TurnJob, gate?: TurnGate): Promise<TurnOutcome> | null {
    const { roomId, agentId } = job;
    if (!this.runnable(roomId, agentId)) return null;
    // 자동 대리는 구성원이 다시 접속(present)하면 즉시 멈춘다: 대기 중이던 작업은 버린다
    if (job.trigger.reason === 'auto_reply') {
      const owner = this.ctx.repo.getAgent(agentId)?.ownerId;
      if (!this.autoReplyOn() || !owner || !this.isAutoAway(roomId, owner, roomStateOf(this.ctx, roomId))) return null;
    }
    // Room Agent가 같은 에피소드에서 보드 도구를 만들었으면 큐에 남은 자동 대리는 버린다(잡담·호출 절약)
    if (job.trigger.reason === 'auto_reply' && this.episodes.get(roomId)?.boardTool) return null;
    // A2A 답 턴: 소유자가 그 사이 접속했거나 위임 없이 떠났으면(askable 재확인) 버린다
    if (job.trigger.reason === 'a2a_ask') {
      const askerId = job.ask?.askerId ?? '';
      if (!a2aLimitsOf(this.ctx).on || !askableAgents(this.ctx, roomId, askerId).some((a) => a.id === agentId)) return null;
    }
    const lim = this.limits();
    const a2aLim = a2aLimitsOf(this.ctx);

    // 5. 시간당 상한
    const now = Date.now();
    const log = (this.turnLog.get(roomId) ?? []).filter((t) => now - t < HOUR);
    this.turnLog.set(roomId, log);
    if (log.length >= lim.maxTurnsPerRoomHour) {
      this.appendPaused(roomId, agentId, 'budget');
      return null;
    }

    // 사람 메시지 1건당 전체 턴 상한 / 승인 해소가 여는 확정 에피소드 상한
    const reasonIn = job.trigger.reason;
    if (reasonIn === 'approval_resolved') {
      let res = this.resolutions.get(roomId);
      if (!res) this.resolutions.set(roomId, (res = { turns: 0 }));
      if (res.turns >= a2aLim.maxTurnsPerResolution) {
        this.appendPaused(roomId, agentId, 'chain_limit');
        return null;
      }
      res.turns++;
    } else if (reasonIn !== 'arrival' && reasonIn !== 'a2a_collect' && !job.forced) {
      const ep = this.episode(roomId);
      if (ep.turns >= a2aLim.maxTurnsPerHumanEvent) {
        this.appendPaused(roomId, agentId, 'chain_limit');
        return null;
      }
      ep.turns++;
    }

    // A2A 에피소드 하드캡: a2a 턴(답+정리)이 상한을 넘으면 일시정지
    const a2a = a2aLimitsOf(this.ctx);
    if (job.trigger.reason === 'a2a_ask' || job.trigger.reason === 'a2a_collect') {
      const ep = this.episode(roomId);
      if (ep.a2aTurns >= a2a.maxTurnsPerEpisode) {
        this.appendPaused(roomId, agentId, 'chain_limit');
        return null;
      }
      ep.a2aTurns++;
    }
    // ask_agents는 Our Room의 room_agent_call·addressed(Personal Agent)·a2a_collect 턴에, 라운드가 남고 물을 대상이 있을 때만 준다
    const reasonNow = job.trigger.reason;
    job.allowAsk =
      a2a.on &&
      this.ctx.repo.getRoom(roomId)?.kind === 'our' &&
      this.episode(roomId).rounds < a2a.maxRounds &&
      (reasonNow === 'room_agent_call' || reasonNow === 'a2a_collect' || (reasonNow === 'addressed' && job.agentKind === 'personal')) &&
      askableAgents(this.ctx, roomId, agentId).length > 0;

    // 4. 방문 턴 상한: end_visit만 허용하는 턴을 강제
    let forced: ToolName | null = job.forced;
    const visit = this.visitOf(roomId, agentId);
    if (visit && !forced && this.visitTurnCount(roomId, agentId, visit.startSeq) >= lim.visitMaxTurns) forced = 'end_visit';
    if (forced) this.appendPaused(roomId, agentId, 'visit_turn_limit');
    const reason: TriggerReason = forced ? 'visit_turn_limit' : job.trigger.reason;

    const turnId = newTurnId();
    const isPersonal = job.agentKind === 'personal';
    this.ctx.store.append({
      roomId,
      actorKind: isPersonal ? 'agent' : 'room_agent',
      actorId: agentId,
      turnId,
      type: 'agent_turn_started',
      agentId,
      trigger: { seq: job.trigger.seq, reason },
    });
    log.push(now);

    job.forced = forced; // afterTurn이 강제 턴이었는지 안다
    job.trigger = { ...job.trigger, reason };
    const ctl = new AbortController();
    this.running.set(turnId, { agentId, roomId, ctl });
    return runTurn(this.ctx, this.getProvider(), job, turnId, ctl.signal, gate).finally(() => this.running.delete(turnId));
  }

  private afterTurn(job: TurnJob, outcome: TurnOutcome): void {
    for (const l of this.turnListeners) {
      try {
        l(outcome);
      } catch (err) {
        console.error('[scheduler] turn listener failed', err);
      }
    }
    if (this.stopped) return;
    if (job.agentKind === 'room_agent' && outcome.tool === 'create_board_tool' && outcome.result === 'acted') this.episode(job.roomId).boardTool = true;
    this.settleAsk(job);
    // 방문 Agent: 턴을 다 썼으면 end_visit 강제 턴을 바로 이어 붙이고, 그 턴 뒤에도 방문이 남으면 서버가 끝낸다.
    const visit = this.visitOf(job.roomId, job.agentId);
    if (!visit) return;
    const lim = this.limits();
    if (job.forced === 'end_visit') {
      this.forceEnd(visit.id);
      return;
    }
    if (this.visitTurnCount(job.roomId, job.agentId, visit.startSeq) >= lim.visitMaxTurns) {
      this.enqueue({ ...job, forced: 'end_visit', trigger: { ...job.trigger, reason: 'visit_turn_limit' } });
    }
  }

  /** 강제 end_visit 턴이 방문을 끝내지 못했을 때의 마무리 */
  private forceEnd(visitId: string): void {
    try {
      if (this.ctx.repo.getVisit(visitId)?.status === 'active') endVisit(this.ctx, { kind: 'system' }, visitId, { reason: 'turn_limit' });
    } catch (err) {
      console.error('[scheduler] forced end_visit failed', err);
    }
  }
}
