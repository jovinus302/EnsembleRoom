/**
 * 실제 Claude 모드 서버 수준 시나리오 (포트를 열지 않는다). 인프로세스 컨텍스트 + 스크래치 DB.
 *
 * 실행 (저장소 루트에서, 셸 환경변수로 모델 지정):
 *   AGENT_MODE=claude ANTHROPIC_MODEL_AGENT=claude-sonnet-5 ANTHROPIC_MODEL_LIGHT=claude-sonnet-4-6 \
 *   SCENARIO_DIR=<스크래치 디렉터리> npx tsx apps/server/scripts/scenario-claude.ts [--steps 1,2,5] [--cap 20]
 *
 * - LLM 호출 합계에 하드 상한(기본 20)이 있다. 넘으면 호출 전에 던진다.
 * - 요청 본문(system·messages·tools·model)은 SCENARIO_DIR/dump/call-NN.json에 덤프한다. 헤더·키·URL은 저장·출력하지 않는다.
 * - 에러는 HTTP 상태와 타입만 출력한다.
 * - 각 step은 독립적으로 시드된 상태에서 시작해도 돌 수 있다(--steps로 일부만 재실행).
 */
import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RoomEvent } from '@ensemble/shared';
import { ClaudeProvider, type MessagesClient, type RawStreamEvent } from '../src/agent/claude';
import { loadConfig } from '../src/config';
import { createContext } from '../src/context';
import { openDb } from '../src/db/index';
import { SEED, seedDatabase } from '../src/db/seed';
import { dispatch } from '../src/domain/actions';
import { acceptVisit, sendAgentVisit } from '../src/domain/visits';
import { ClaudeSummaryProvider, type SummaryClient } from '../src/memory/summarizer';

const args = process.argv.slice(2);
const argVal = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const CAP = Number(argVal('--cap') ?? 20);
const ONLY = argVal('--steps')?.split(',').map((s) => s.trim());
const DIR = process.env.SCENARIO_DIR;
if (!DIR) throw new Error('SCENARIO_DIR 필요');
const DUMP = resolve(DIR, 'dump');
rmSync(DUMP, { recursive: true, force: true });
mkdirSync(DUMP, { recursive: true });
const dbFile = resolve(DIR, 'scenario.db');
for (const suffix of ['', '-wal', '-shm']) rmSync(dbFile + suffix, { force: true });

const config = { ...loadConfig(), agentMode: 'claude' as const, dbPath: dbFile };
const ctx = createContext(openDb(dbFile), config);
seedDatabase(ctx);

/* ------------------------------ 호출 기록 ------------------------------ */

interface CallRec {
  n: number;
  kind: 'agent' | 'summary';
  model: string;
  ms: number;
  firstEventMs: number | null;
  tool: string | null;
  args: Record<string, unknown> | null;
  summaryText?: string;
  error?: string;
  turnId?: string;
  agentName?: string;
}
const calls: CallRec[] = [];
let callCount = 0;
const errInfo = (e: unknown) => {
  const x = e as { status?: number; error?: { error?: { type?: string }; type?: string }; name?: string; message?: string };
  return `status=${x.status ?? '-'} type=${x.error?.error?.type ?? x.error?.type ?? x.name ?? '-'}`;
};

const realClient = (() => {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 없음');
  const baseURL = process.env.ANTHROPIC_BASE_URL?.trim() || undefined;
  return new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}), maxRetries: 0 });
})();

function nextCall(kind: CallRec['kind'], params: Record<string, unknown>): CallRec {
  if (callCount >= CAP) throw new Error(`call_cap_reached(${CAP})`);
  callCount++;
  const rec: CallRec = { n: callCount, kind, model: String(params.model), ms: 0, firstEventMs: null, tool: null, args: null };
  calls.push(rec);
  writeFileSync(
    resolve(DUMP, `call-${String(rec.n).padStart(2, '0')}.json`),
    JSON.stringify({ kind, model: params.model, max_tokens: params.max_tokens, system: params.system, messages: params.messages, tools: params.tools, tool_choice: params.tool_choice }, null, 2),
  );
  return rec;
}

const agentClient: MessagesClient = {
  messages: {
    async create(params, options) {
      const rec = nextCall('agent', params);
      const sys = JSON.stringify(params.system);
      for (const t of inflight.values()) if (sys.includes(t.agentName)) Object.assign(rec, { turnId: t.turnId, agentName: t.agentName });
      const t0 = Date.now();
      let raw: AsyncIterable<RawStreamEvent> & { controller?: AbortController };
      try {
        raw = (await realClient.messages.create(params as never, options)) as never;
      } catch (e) {
        rec.ms = Date.now() - t0;
        rec.error = errInfo(e);
        throw e;
      }
      async function* wrap(): AsyncGenerator<RawStreamEvent> {
        let json = '';
        try {
          for await (const ev of raw) {
            if (rec.firstEventMs === null) rec.firstEventMs = Date.now() - t0;
            const e = ev as RawStreamEvent;
            if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use' && !rec.tool) rec.tool = e.content_block.name ?? null;
            if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta') json += e.delta.partial_json ?? '';
            yield e;
          }
        } catch (e) {
          rec.error = errInfo(e);
          throw e;
        } finally {
          rec.ms = Date.now() - t0;
          try {
            rec.args = JSON.parse(json);
          } catch {
            rec.args = null;
          }
        }
      }
      const it = wrap() as AsyncGenerator<RawStreamEvent> & { controller?: AbortController };
      Object.defineProperty(it, 'controller', { get: () => raw.controller });
      return it;
    },
  },
};

const summaryClient: SummaryClient = {
  messages: {
    async create(params, options) {
      const rec = nextCall('summary', params);
      const t0 = Date.now();
      try {
        const res = (await realClient.messages.create(params as never, options)) as unknown as Awaited<ReturnType<SummaryClient['messages']['create']>>;
        rec.ms = Date.now() - t0;
        rec.summaryText = res.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
        return res;
      } catch (e) {
        rec.ms = Date.now() - t0;
        rec.error = errInfo(e);
        throw e;
      }
    },
  },
};

ctx.agents.setProvider(
  new ClaudeProvider({ client: agentClient, model: process.env.ANTHROPIC_MODEL_AGENT?.trim() || 'claude-sonnet-5', lightModel: process.env.ANTHROPIC_MODEL_LIGHT?.trim() || 'claude-sonnet-4-6' }),
);
ctx.summarizer.setProvider(new ClaudeSummaryProvider({ client: summaryClient, lightModel: process.env.ANTHROPIC_MODEL_LIGHT?.trim() || 'claude-sonnet-4-6' }));

/* ------------------------------ 턴 기록 ------------------------------ */

interface TurnRec {
  turnId: string;
  room: string;
  agentName: string;
  trigger: string;
  startedAt: number;
  ms: number;
  result: string;
  tool: string | null;
  errorCode?: string;
  phases: string[];
  lastText: string;
}
const turns = new Map<string, TurnRec>();
const inflight = new Map<string, TurnRec>();
const nameOf = (id: string): string => ctx.repo.getUser(id)?.name ?? ctx.repo.getAgent(id)?.name ?? ctx.repo.getRoomAgent(id)?.name ?? id;

ctx.store.onAppended((e) => {
  if (e.type === 'agent_turn_started' && e.turnId) {
    const t: TurnRec = {
      turnId: e.turnId,
      room: e.roomId,
      agentName: nameOf(e.agentId),
      trigger: e.trigger.reason,
      startedAt: Date.now(),
      ms: 0,
      result: '?',
      tool: null,
      phases: [],
      lastText: '',
    };
    turns.set(e.turnId, t);
    inflight.set(e.turnId, t);
  }
});
const origPublish = ctx.hub.publishActivity.bind(ctx.hub);
ctx.hub.publishActivity = (m) => {
  const t = turns.get(m.turnId);
  if (t) {
    if (m.phase && t.phases[t.phases.length - 1] !== m.phase) t.phases.push(m.phase);
    if (m.final) t.phases.push('end');
    else if (m.text) t.lastText = m.text;
  }
  origPublish(m);
};
ctx.agents.scheduler.onTurnEnded((o) => {
  const t = turns.get(o.turnId);
  if (!t) return;
  t.ms = Date.now() - t.startedAt;
  t.result = o.result;
  t.tool = o.tool;
  if (o.errorCode) t.errorCode = o.errorCode;
  inflight.delete(o.turnId);
});

ctx.agents.start();

/* ------------------------------ 헬퍼 ------------------------------ */

const U = SEED.users;
const A = SEED.agents;
const R = SEED.rooms;
const human = (userId: string) => ({ kind: 'human' as const, userId });
const say = (userId: string, roomId: string, text: string, to?: string) => dispatch(ctx, human(userId), { type: 'send_message', roomId, text, ...(to ? { to } : {}) });
const enter = (userId: string, roomId: string) => dispatch(ctx, human(userId), { type: 'enter_room', roomId });

async function settle() {
  for (let i = 0; i < 5; i++) {
    await ctx.agents.drain();
    await ctx.summarizer.drain();
    await new Promise((r) => setTimeout(r, 150));
  }
}

const marks = new Map<string, number>();
const watched = [R.myAlice, R.myBob, R.friends];
const SHOW = new Set(['message', 'card_created', 'card_updated', 'comment_added', 'approval_requested', 'approval_voted', 'approval_resolved', 'agreement_formed', 'agent_arrived', 'visit_takeout', 'visit_ended', 'visit_report', 'memory_retained', 'member_left', 'member_rejoined', 'agent_owner_note', 'agent_paused']);

function describe(e: RoomEvent): string {
  const who = nameOf(e.actorId ?? '');
  const x = e as unknown as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  for (const k of ['text', 'to', 'title', 'body', 'cardId', 'summary', 'options', 'outcome', 'option', 'proposal', 'patch', 'ns', 'kind', 'note', 'reason', 'approvers']) if (x[k] !== undefined) body[k] = x[k];
  return `  [${e.roomId.replace('room_', '')}] #${e.seq} ${e.type} (${who}${e.visibility !== 'room' ? ', ' + e.visibility : ''}) ${JSON.stringify(body)}`;
}

function newEvents(): string[] {
  const out: string[] = [];
  for (const r of watched) {
    const since = marks.get(r) ?? 0;
    for (const e of ctx.store.listAll(r, { afterSeq: since })) if (SHOW.has(e.type)) out.push(describe(e));
    marks.set(r, ctx.store.lastSeq(r));
  }
  return out;
}

interface StepRow {
  step: string;
  turns: { agent: string; trigger: string; tool: string | null; result: string; err?: string; ms: number; firstMs: number | null; chars: number | null; streamMatch: string; phases: string }[];
  summaries: { model: string; ms: number; text: string }[];
}
const report: StepRow[] = [];
let callMark = 0;
let turnMark = 0;

function endStep(step: string) {
  const row: StepRow = { step, turns: [], summaries: [] };
  const allTurns = [...turns.values()];
  for (const t of allTurns.slice(turnMark)) {
    const call = calls.find((c) => c.kind === 'agent' && c.turnId === t.turnId && c.n > callMark);
    const text = call?.args && typeof call.args.text === 'string' ? call.args.text : null;
    const streams = call?.tool === 'say' || call?.tool === 'comment';
    row.turns.push({
      agent: t.agentName,
      trigger: t.trigger,
      tool: t.tool ?? call?.tool ?? null,
      result: t.result,
      ...(t.errorCode ? { err: t.errorCode } : {}),
      ms: t.ms,
      firstMs: call?.firstEventMs ?? null,
      chars: text?.length ?? null,
      streamMatch: streams ? (t.lastText === text ? 'match' : `MISMATCH(${t.lastText.length}/${text?.length ?? '-'})`) : '-',
      phases: t.phases.join('>'),
    });
  }
  for (const c of calls.filter((c) => c.kind === 'summary' && c.n > callMark)) row.summaries.push({ model: c.model, ms: c.ms, text: c.summaryText ?? `(error ${c.error ?? ''})` });
  for (const c of calls.filter((c) => c.n > callMark && c.error)) console.log(`  !! call#${c.n} ${c.kind} ${c.error}`);
  callMark = calls.length;
  turnMark = allTurns.length;
  report.push(row);
  console.log(`\n=== ${step} (누적 호출 ${callCount}/${CAP}) ===`);
  for (const l of newEvents()) console.log(l);
  for (const t of row.turns) console.log(`  turn ${t.agent} trig=${t.trigger} tool=${t.tool} result=${t.result}${t.err ? ' err=' + t.err : ''} ${t.ms}ms (first ${t.firstMs}ms) chars=${t.chars} stream=${t.streamMatch} phases=${t.phases}`);
  for (const s of row.summaries) console.log(`  summary[${s.model}] ${s.ms}ms: ${s.text}`);
}

const want = (n: string) => !ONLY || ONLY.includes(n);

function pendingApprovals(roomId: string) {
  const evs = ctx.store.listAll(roomId);
  const resolved = new Set(evs.filter((e) => e.type === 'approval_resolved').map((e) => (e as { approvalId: string }).approvalId));
  return evs.filter((e): e is Extract<RoomEvent, { type: 'approval_requested' }> => e.type === 'approval_requested' && !resolved.has(e.approvalId));
}
function voteAll(roomId: string, optionIndex = 0) {
  for (const req of pendingApprovals(roomId)) {
    for (const userId of req.approvers) {
      try {
        const option = req.options?.[optionIndex];
        dispatch(ctx, human(userId), { type: 'vote_approval', roomId, approvalId: req.approvalId, decision: 'approve', ...(req.kind === 'decision' && option ? { option } : {}) });
      } catch (e) {
        console.log(`  vote 실패 ${nameOf(userId)}: ${(e as { code?: string }).code ?? 'err'}`);
      }
    }
  }
}

/* ------------------------------ 시나리오 ------------------------------ */

try {
  if (want('1')) {
    enter(U.alice, R.myAlice);
    say(U.alice, R.myAlice, '이번 주 토요일에 친구들이랑 점심 먹을 건데, 메뉴 하나만 추천해 줄래?');
    await settle();
    endStep('1 My Room 질문(recall)');
    const c = calls.find((x) => x.kind === 'agent');
    if (c) {
      const p = JSON.stringify(JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(resolve(DUMP, `call-${String(c.n).padStart(2, '0')}.json`), 'utf8'))).messages);
      console.log(`  recall 프롬프트 포함(매운): ${p.includes('매운')}`);
    }
  }

  if (want('2')) {
    enter(U.alice, R.friends);
    enter(U.bob, R.friends);
    say(U.alice, R.friends, '이번 주 토요일 점심 약속 확정해 줘. 후보는 12시 홍대, 13시 성수야.', SEED.roomAgents.friends);
    await settle();
    endStep('2a 일정 확정 요청 → request_approval');
    voteAll(R.friends, 0);
    await settle();
    endStep('2b Alice·Bob 승인 → 합의 → Agent 재개');
  }

  if (want('3')) {
    enter(U.alice, R.myAlice);
    say(U.alice, R.myAlice, "보드에 '토요일 점심' 카드를 만들어서 장소는 홍대 12시라고 적어 줘.");
    await settle();
    endStep('3a My Room 카드 추가(edit_board 기대)');
    enter(U.alice, R.friends);
    enter(U.bob, R.friends);
    say(U.alice, R.friends, '내 Agent야, 이 방 보드에 "토요일 점심" 카드를 새로 제안해 줘. 장소는 홍대로.', A.alice);
    await settle();
    endStep('3b Our Room 카드 제안(propose_edit 기대)');
  }

  if (want('4')) {
    enter(U.alice, R.myAlice);
    const v = sendAgentVisit(ctx, U.bob, R.myAlice, { text: '토요일 점심 시간·장소를 Alice에게 물어보고, 결론을 정리해서 돌아온다. 카드 수정이나 약속 확정은 하지 않는다.', allowedActions: ['chat', 'comment'] });
    acceptVisit(ctx, U.alice, v.visitId, ['chat', 'comment']);
    await settle();
    endStep('4a Bob의 Agent 방문 도착 턴');
    say(U.alice, R.myAlice, '어서 와요. 토요일엔 12시 홍대가 제일 좋아요. 이제 정리해서 돌아가도 돼요.', A.bob);
    await settle();
    endStep('4b Alice 답변 → 방문 Agent 턴');
    if (ctx.repo.getVisit(v.visitId)?.status === 'active') {
      say(U.alice, R.myAlice, '이제 마무리해 줘요.', A.bob);
      await settle();
      endStep('4c 마무리 요청');
    }
    const status = ctx.repo.getVisit(v.visitId)?.status;
    console.log(`  방문 status=${status}`);
    voteAll(R.myAlice);
    await settle();
    endStep('4d takeout 승인');
    const visibleToAlice = JSON.stringify([...ctx.store.listVisible(U.alice, R.myAlice), ...ctx.store.listVisible(U.alice, R.myBob)]);
    const rep = ctx.store.listAll(R.myBob).find((e) => e.type === 'visit_report') as { summary?: string; visibility?: string } | undefined;
    console.log(`  visit_report 존재=${!!rep} visibility=${rep?.visibility}`);
    console.log(`  Bob에게 보임=${ctx.store.listVisible(U.bob, R.myBob).some((e) => e.type === 'visit_report')} Alice에게 보임=${rep?.summary ? visibleToAlice.includes(rep.summary) : 'n/a'}`);
    if (rep?.summary) console.log(`  report 원문: ${rep.summary}`);
  }

  if (want('5')) {
    enter(U.alice, R.friends);
    enter(U.bob, R.friends);
    dispatch(ctx, human(U.alice), { type: 'leave_room', roomId: R.friends, mandate: { text: '토요일 점심 일정 조율만. 장소는 홍대를 선호. 확정이나 결제는 내 승인 필요.', allowedActions: ['chat', 'comment', 'propose_edit', 'request_approval'] } });
    await settle();
    endStep('5a Alice Leave(mandate)');
    say(U.bob, R.friends, 'Alice, 토요일 12시에 홍대에서 보는 걸로 확정해도 돼?');
    await settle();
    endStep('5b Bob 질문 → 대리 응답');
    dispatch(ctx, human(U.alice), { type: 'rejoin_room', roomId: R.friends });
    await settle();
    try {
      const d = await ctx.summarizer.digest(U.alice, R.friends);
      await settle();
      console.log(`  digest 요약: ${d.summary}`);
      console.log(`  missed=${d.missedCount} boardChanges=${d.boardChanges.length} pendingApprovals=${d.pendingApprovals.length}`);
    } catch (e) {
      console.log(`  digest 실패: ${(e as { message?: string }).message ?? 'err'}`);
    }
    endStep('5c Rejoin → 다이제스트(light)');
  }

  if (want('6')) {
    enter(U.alice, R.myAlice);
    say(U.alice, R.myAlice, '이건 기억해 줘: 나는 토요일엔 오전 약속을 잡지 않아.');
    await settle();
    endStep('6 remember');
    for (const e of ctx.store.listAll(R.myAlice)) if (e.type === 'memory_retained') console.log(`  memory ns=${(e as { ns: string }).ns}`);
  }
  for (const [id, question] of [
    ['7', '토요일 3시로 정하자, Alice 어때?'],
    ['8', 'Alice, 토요일 오후에는 보통 시간 괜찮아?'],
  ] as const) {
    if (!want(id)) continue;
    enter(U.alice, R.friends);
    enter(U.bob, R.friends);
    dispatch(ctx, human(U.alice), { type: 'leave_room', roomId: R.friends, mandate: { text: '토요일 오후까지만. 카드 수정은 내 승인.', allowedActions: ['chat', 'comment', 'propose_edit', 'request_approval'] } });
    await settle();
    say(U.bob, R.friends, question);
    await settle();
    endStep(`${id} 대리 장면: ${question}`);
    dispatch(ctx, human(U.alice), { type: 'rejoin_room', roomId: R.friends });
    await settle();
    try {
      const d = await ctx.summarizer.digest(U.alice, R.friends);
      await settle();
      console.log(`  digest 요약: ${d.summary}`);
      console.log(`  pendingApprovals=${d.pendingApprovals.length} approvalRequestedEvents=${pendingApprovals(R.friends).length}`);
    } catch (e) {
      console.log(`  digest 실패: ${(e as { message?: string }).message ?? 'err'}`);
    }
    endStep(`${id} Rejoin 다이제스트`);
  }
} catch (e) {
  console.log(`시나리오 중단: ${(e as { message?: string }).message ?? 'err'}`);
}

/* ------------------------------ 요약 ------------------------------ */
console.log(`\n총 LLM 호출: ${callCount} (agent ${calls.filter((c) => c.kind === 'agent').length}, summary ${calls.filter((c) => c.kind === 'summary').length})`);
console.log('사용 모델:', [...new Set(calls.map((c) => c.model))].join(', '));
const forbidden = /siheon|ryu|@[a-z0-9-]+\.[a-z]{2,}|https?:\/\//i;
let leaks = 0;
for (const c of calls) {
  const dumpTxt = (await import('node:fs')).readFileSync(resolve(DUMP, `call-${String(c.n).padStart(2, '0')}.json`), 'utf8');
  if (forbidden.test(dumpTxt)) leaks++;
}
console.log(`프롬프트 덤프 중 실명·이메일·URL 의심 패턴 포함: ${leaks}개`);
writeFileSync(resolve(DIR, 'report.json'), JSON.stringify({ report, calls: calls.map((c) => ({ ...c, args: c.args })) }, null, 2));
ctx.agents.stop();
process.exit(0);
