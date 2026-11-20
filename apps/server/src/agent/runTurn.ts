import { randomUUID } from 'node:crypto';
import type { ActivityPhase, ToolName } from '@ensemble/shared';
import type { AppContext } from '../context';
import { requireRoom, resolveSubject } from '../domain/rooms';
import { DomainError, forbidden } from '../errors';
import { buildTurnInput } from './context';
import { actorOf, executeTool, isSeedAgent, isToolName, toolsForTurn } from './tools';
import type { A2AJob, AgentKind, AgentProvider, ToolCall, Trigger, TurnOutcome } from './types';

/**
 * 턴 1회 실행 (계획 6절 Claude 호출 / 도구).
 *   ① (scheduler가 이미 `agent_turn_started`를 동기로 append) ② 권한으로 걸러 도구 결정, 기억 recall
 *   ③ provider 스트림 소비: 활동(휘발성) 발행, agent_step(최대 3개) 기록 ④ 첫 tool_call만 실행
 *   ⑤ `agent_turn_ended` 기록. 위반·실패는 `error`로 끝난다.
 */

export const newTurnId = () => `turn_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

export interface TurnJob {
  roomId: string;
  agentId: string;
  agentKind: AgentKind;
  trigger: Trigger;
  /** 방문 턴 상한: 이 도구만 허용 */
  forced: ToolName | null;
  /** A2A 답(answer)·정리(collect) 턴 */
  ask?: A2AJob;
  /** 이 턴에 ask_agents를 줄지(스케줄러가 startJob에서 정한다) */
  allowAsk?: boolean;
  /** 마무리(확정) 턴: say/pass만 허용 (승인 해소로 깨어난 요청자) */
  closing?: boolean;
}

/** 같은 질문의 답 턴을 병렬로 호출할 때의 실행 게이트: 앞 순번이 도구 실행·기록을 마친 뒤에만 내 도구를 실행한다 */
export interface TurnGate {
  wait(): Promise<void>;
  done(): void;
}

const MAX_STEPS = 3;
const ACTIVITY_BATCH_MS = 80;

/** 휘발성 활동 발행기. 텍스트는 80ms 간격으로 묶어 누적 텍스트로 보낸다. */
class ActivityPublisher {
  private text = '';
  private lastFlush = 0;
  private firstDelta = 0;
  private dirty = false;
  constructor(
    private readonly ctx: AppContext,
    private readonly ids: { roomId: string; agentId: string; turnId: string },
  ) {}

  private send(phase: ActivityPhase | undefined, text: string, tokensPerSec: number, final?: boolean) {
    try {
      this.ctx.hub.publishActivity({ type: 'activity', ...this.ids, text, tokensPerSec, ...(phase ? { phase } : {}), ...(final ? { final: true } : {}) });
    } catch (err) {
      console.error('[agent] publishActivity failed', err);
    }
  }

  phase(phase: ActivityPhase) {
    this.send(phase, this.text, 0);
  }

  delta(d: string) {
    const now = Date.now();
    if (!this.firstDelta) this.firstDelta = now;
    this.text += d;
    this.dirty = true;
    if (now - this.lastFlush >= ACTIVITY_BATCH_MS) this.flush();
  }

  flush() {
    if (!this.dirty) return;
    const elapsed = Math.max(1, Date.now() - this.firstDelta) / 1000;
    this.send('writing', this.text, Math.round(this.text.length / 3 / elapsed));
    this.lastFlush = Date.now();
    this.dirty = false;
  }

  end() {
    this.flush();
    this.send(undefined, '', 0, true);
  }
}

const abortedError = () => new DomainError(499, 'aborted', '턴이 중단되었습니다');

/** provider 오류(DomainError가 아닌 것)는 1회 재시도한다. signal이 중단되면 즉시 끝낸다. */
async function collectToolCall(
  provider: AgentProvider,
  input: Parameters<AgentProvider['stream']>[0],
  hooks: {
    onPhase(p: 'thinking' | 'recalling' | 'writing' | 'composing'): void;
    onToolStart(t: ToolName): void;
    onTarget(to: string): void;
    onText(d: string): void;
  },
  signal?: AbortSignal,
): Promise<ToolCall | null> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (signal?.aborted) throw abortedError();
      const it = provider.stream(input, signal)[Symbol.asyncIterator]();
      try {
        for (;;) {
          const r = await it.next();
          if (signal?.aborted) throw abortedError();
          if (r.done) break;
          const ev = r.value;
          if (ev.type === 'phase') hooks.onPhase(ev.phase);
          else if (ev.type === 'tool_start') hooks.onToolStart(ev.tool);
          else if (ev.type === 'target') hooks.onTarget(ev.to);
          else if (ev.type === 'text_delta') hooks.onText(ev.delta);
          else if (ev.type === 'tool_call') return ev.call; // 첫 번째 tool_call만 쓴다
        }
      } finally {
        await it.return?.();
      }
      return null;
    } catch (err) {
      // 중단(서버 종료·Agent 일시정지)이면 재시도하지 않는다
      if (signal?.aborted) throw abortedError();
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('provider_error');
}

/**
 * 턴을 실행하고 결과를 돌려준다. 예외를 던지지 않는다 (모든 실패는 `agent_turn_ended{error}`).
 * `turnId`의 `agent_turn_started`는 호출 전에 scheduler가 이미 append했다.
 */
export async function runTurn(
  ctx: AppContext,
  provider: AgentProvider,
  job: TurnJob,
  turnId: string,
  signal?: AbortSignal,
  gate?: TurnGate,
): Promise<TurnOutcome> {
  try {
    return await runTurnInner(ctx, provider, job, turnId, signal, gate);
  } finally {
    gate?.done();
  }
}

async function runTurnInner(
  ctx: AppContext,
  provider: AgentProvider,
  job: TurnJob,
  turnId: string,
  signal: AbortSignal | undefined,
  gate: TurnGate | undefined,
): Promise<TurnOutcome> {
  const { roomId, agentId, agentKind } = job;
  const actor = actorOf({ agentId, agentKind, turnId });
  const activity = new ActivityPublisher(ctx, { roomId, agentId, turnId });
  const outcome: TurnOutcome = { turnId, roomId, agentId, result: 'error', tool: null };
  let steps = 0;
  const step = (kind: 'recalling' | 'drafting' | 'talking', target?: string) => {
    if (steps >= MAX_STEPS) return;
    steps++;
    ctx.store.append({
      roomId,
      actorKind: actor.kind === 'agent' ? 'agent' : 'room_agent',
      actorId: agentId,
      turnId,
      type: 'agent_step',
      agentId,
      kind,
      ...(target ? { target } : {}),
    });
  };

  try {
    activity.phase('thinking');
    const room = requireRoom(ctx, roomId);
    const subject = resolveSubject(ctx, room, actor);
    if (!subject) throw forbidden('not_in_room', '이 Room에 접근할 수 없습니다');
    // 보수적 턴: 자동 대리(auto_reply)와 A2A 답 턴(a2a_ask). 도구를 say/request_approval/pass로 제한한다.
    const autoReply = job.trigger.reason === 'auto_reply' || job.trigger.reason === 'a2a_ask';
    const allowAsk = !!job.allowAsk && !autoReply;
    const noApproval = job.trigger.reason === 'a2a_ask' && job.ask?.askerKind === 'room_agent';
    const closingOnly = !!job.closing;
    const toolNames = toolsForTurn(subject, job.forced, autoReply, isSeedAgent(ctx, agentId), { allowAsk, noApproval, closingOnly });
    if (toolNames.length === 0) throw forbidden('no_tools', '쓸 수 있는 도구가 없습니다');

    // 기억: gateway만 통과한다. ns는 서버가 정한다.
    const trig = job.trigger.event;
    const query = trig && 'text' in trig && typeof trig.text === 'string' ? trig.text : '';
    const recall = ctx.memory.recallForTurn(agentId, roomId, { query });
    if (recall.items.length > 0) {
      step('recalling');
      activity.phase('recalling');
    }

    const input = buildTurnInput(ctx, {
      turnId,
      roomId,
      agentId,
      agentKind,
      trigger: job.trigger,
      forcedTool: job.forced,
      subject,
      tools: toolNames,
      recall,
      ask: job.ask,
      allowAsk: toolNames.includes('ask_agents'),
      closing: closingOnly,
    });

    let talkingDone = false;
    const markTalking = (to: string) => {
      if (talkingDone) return;
      if (ctx.repo.getAgent(to) || ctx.repo.getRoomAgent(to)) {
        talkingDone = true;
        step('talking', to);
      }
    };

    let drafted = false;
    const call = await collectToolCall(provider, input, {
      onPhase: (p) => activity.phase(p),
      onToolStart: (t) => {
        if (t === 'pass' || drafted) return;
        drafted = true;
        step('drafting');
      },
      onTarget: markTalking,
      onText: (d) => activity.delta(d),
    }, signal);
    activity.flush();
    if (signal?.aborted) throw abortedError();

    if (!call || !isToolName(call.name)) throw new DomainError(502, 'no_tool_call', 'provider가 도구 호출을 내지 않았습니다');
    outcome.tool = call.name;
    if (call.name !== 'pass') activity.phase('acting');

    // `to`가 Agent면 talking 단계를 남긴다 (provider가 target을 못 알렸을 때)
    const to = job.ask?.role === 'answer' ? job.ask.askerId : (call.input as { to?: unknown }).to;
    if (call.name === 'say' && typeof to === 'string') markTalking(to);
    if (call.name === 'ask_agents') {
      const ids = (call.input as { agent_ids?: unknown }).agent_ids;
      if (Array.isArray(ids) && typeof ids[0] === 'string') markTalking(ids[0]);
    }

    // 병렬 답 턴: 앞 순번이 실행을 마칠 때까지 기다려 기록 순서를 수신자 순서로 유지한다
    if (gate) await gate.wait();
    if (signal?.aborted) throw abortedError();
    const res = executeTool(
      ctx,
      {
        roomId,
        agentId,
        agentKind,
        turnId,
        forcedTool: job.forced,
        providedMemoryIds: recall.providedIds,
        autoReply,
        allowAsk,
        noApproval,
        closingOnly,
        ...(input.allowBlocks && input.digest ? { blocks: { digestRefs: input.digest.refs, eventSeqs: input.events.map((e) => e.seq) } } : {}),
        askable: input.askable.map((a) => a.id),
        ...(job.ask ? { reply: { seq: job.ask.askSeq, ...(job.ask.role === 'answer' ? { forceTo: job.ask.askerId } : {}) } } : {}),
      },
      call.name,
      call.input,
    );
    outcome.result = res.result;
    if (res.passReason) outcome.passReason = res.passReason;
  } catch (err) {
    outcome.result = 'error';
    if (err instanceof DomainError) {
      outcome.errorCode = err.code;
      outcome.errorStatus = err.status;
    } else {
      outcome.errorCode = 'provider_error';
      console.error('[agent] turn failed', err);
    }
  }

  try {
    ctx.store.append({
      roomId,
      actorKind: actor.kind === 'agent' ? 'agent' : 'room_agent',
      actorId: agentId,
      turnId,
      type: 'agent_turn_ended',
      agentId,
      result: outcome.result,
      ...(outcome.passReason ? { passReason: outcome.passReason } : {}),
    });
  } catch (err) {
    console.error('[agent] failed to record turn end', err);
  }
  activity.end();
  return outcome;
}
