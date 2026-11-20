import { buildRoomState, type RoomEvent, type ToolName } from '@ensemble/shared';
import type { AppContext } from '../context';
import { AGENT_DEFAULTS } from '../config';
import { endVisit } from '../domain/visits';
import { resolveSubject, type ActorCtx } from '../domain/rooms';
import { newTurnId, runTurn, type TurnJob } from './runTurn';
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

const QUESTION = /[?？]|정리|요약|summar/i;

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
      for (const job of this.triggersFor(e)) this.enqueue(job);
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
      if (repo.getUser(personal.ownerId)?.kind === 'seed') return false; // 시드 사용자의 Agent는 실행하지 않는다
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

    // 내가 올린 decision 승인이 해소되면 요청한 Agent를 깨워 결과를 이어서 처리하게 한다
    if (e.type === 'approval_resolved') {
      const row = repo.getApproval(e.approvalId);
      if (!row || row.kind !== 'decision' || !row.requestedBy || row.roomId !== e.roomId) return [];
      if (!this.runnable(e.roomId, row.requestedBy)) return [];
      const j = this.job(e.roomId, row.requestedBy, 'approval_resolved', e);
      return j ? [j] : [];
    }

    if (!HUMAN_CONTENT.has(e.type)) return [];

    // 2. Agent 이벤트
    if (e.actorKind === 'agent' || e.actorKind === 'room_agent') {
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

    const targets: { agentId: string; reason: TriggerReason }[] = [];
    const add = (agentId: string | undefined, reason: TriggerReason) => {
      if (agentId && agentId !== e.actorId && !targets.some((t) => t.agentId === agentId)) targets.push({ agentId, reason });
    };

    const explicit = e.type === 'message' ? e.to : e.type === 'card_pointed' ? e.toAgentId : undefined;
    if (explicit) {
      // 지정이 있으면 그 Agent만. 사람에게 한 말이면 Agent는 깨우지 않는다.
      if (repo.getAgent(explicit) || repo.getRoomAgent(explicit)) add(explicit, e.type === 'card_pointed' ? 'pointed' : 'addressed');
    } else {
      const state = buildRoomState(room.id, store.listAll(room.id));
      const text = e.type === 'message' ? e.text : '';
      if (room.kind === 'my' && room.ownerId) {
        const ownerAgent = repo.getAgentByOwner(room.ownerId);
        if (e.actorId === room.ownerId) {
          add(ownerAgent?.id, 'owner_message');
        } else if (!state.members[room.ownerId]?.present) {
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
          const ms = state.members[m];
          return !ms || !ms.present;
        });
        const mentionsAbsent = absent.some((m) => {
          const n = repo.getUser(m)?.name;
          return !!n && text.includes(n);
        });
        if (ra && (QUESTION.test(text) || mentionsAbsent)) add(ra.id, 'room_agent_call');
        // 대리 참여 중인 구성원의 Agent
        for (const m of members) {
          const ms = state.members[m];
          if (!ms || ms.present || !ms.mandate || m === e.actorId) continue;
          const n = repo.getUser(m)?.name;
          if (QUESTION.test(text) || (n && text.includes(n))) add(repo.getAgentByOwner(m)?.id, 'representing');
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

  private limits(): SchedulerLimits {
    return limitsOf(this.ctx);
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

  enqueue(job: TurnJob): void {
    if (this.stopped) return;
    let q = this.queues.get(job.roomId);
    if (!q) this.queues.set(job.roomId, (q = { running: false, jobs: [] }));
    // 대기열 중복 제거: 같은 Agent의 대기 턴은 하나만 (강제 턴은 항상 우선 보존)
    const dup = q.jobs.findIndex((j) => j.agentId === job.agentId);
    if (dup >= 0) {
      if (job.forced && !q.jobs[dup]!.forced) q.jobs[dup] = job;
      return;
    }
    q.jobs.push(job);
    this.pump(job.roomId);
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
      const job = q.jobs.shift();
      if (!job) return;
      const started = this.startJob(job);
      if (!started) continue; // 버려진 작업: 다음 것
      q.running = true;
      const p: Promise<void> = started
        .then((outcome) => this.afterTurn(job, outcome))
        .catch((err) => console.error('[scheduler] turn crashed', err))
        .finally(() => {
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
  private startJob(job: TurnJob): Promise<TurnOutcome> | null {
    const { roomId, agentId } = job;
    if (!this.runnable(roomId, agentId)) return null;
    const lim = this.limits();

    // 5. 시간당 상한
    const now = Date.now();
    const log = (this.turnLog.get(roomId) ?? []).filter((t) => now - t < HOUR);
    this.turnLog.set(roomId, log);
    if (log.length >= lim.maxTurnsPerRoomHour) {
      this.appendPaused(roomId, agentId, 'budget');
      return null;
    }

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
    return runTurn(this.ctx, this.getProvider(), job, turnId, ctl.signal).finally(() => this.running.delete(turnId));
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
