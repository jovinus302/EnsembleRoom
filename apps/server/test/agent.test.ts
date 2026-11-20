import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityMessageSchema, buildAgentState, type RoomEvent } from '@ensemble/shared';
import type { AgentProvider, ProviderEvent, ToolCall, TurnInput } from '../src/agent/types';
import { MockProvider } from '../src/agent/mock';
import type { AppContext } from '../src/context';
import { dispatch } from '../src/domain/actions';
import { acceptVisit, requestHumanVisit, sendAgentVisit } from '../src/domain/visits';
import type { Config } from '../src/config';
import { SEED, makeCtx } from './helpers';

const { alice, bob, mom } = SEED.users;
const A = SEED.agents;
const R = SEED.rooms;

let ctx: AppContext;

const start = (config: Partial<Config> = {}) => {
  ctx = makeCtx(config);
  ctx.agents.start();
  return ctx;
};
afterEach(() => ctx?.agents.stop());

const say = (userId: string, roomId: string, text: string, to?: string) =>
  dispatch(ctx, { kind: 'human', userId }, { type: 'send_message', roomId, text, to });
const ofType = (roomId: string, ...t: string[]) => ctx.store.listAll(roomId).filter((e) => t.includes(e.type));
const turnsOf = (roomId: string, agentId: string) => ofType(roomId, 'agent_turn_started').filter((e) => e.type === 'agent_turn_started' && e.agentId === agentId);
const lastOutcome = () => ctx.agents.outcomes[ctx.agents.outcomes.length - 1]!;

/** 지정한 도구 호출을 그대로 내는 provider. 입력을 기록한다. */
function scripted(fn: (input: TurnInput) => ToolCall | ToolCall[] | Error): AgentProvider & { inputs: TurnInput[] } {
  const inputs: TurnInput[] = [];
  return {
    name: 'scripted',
    inputs,
    async *stream(input): AsyncGenerator<ProviderEvent> {
      inputs.push(input);
      const r = fn(input);
      if (r instanceof Error) throw r;
      for (const call of Array.isArray(r) ? r : [r]) yield { type: 'tool_call', call };
    },
  };
}

/** mock을 감싸 입력을 기록한다 */
function spy(base: AgentProvider = new MockProvider()): AgentProvider & { inputs: TurnInput[] } {
  const inputs: TurnInput[] = [];
  return { name: 'spy', inputs, stream: (input, signal) => (inputs.push(input), base.stream(input, signal)) };
}

const enter = (userId: string, roomId: string) => dispatch(ctx, { kind: 'human', userId }, { type: 'enter_room', roomId });

describe('스케줄러: 결정적 순서와 turn_started 선기록', () => {
  beforeEach(() => start());

  it('agent_turn_started는 트리거 직후 동기로, LLM 호출(provider.stream) 전에 기록된다', async () => {
    let startedBeforeCall = false;
    const p = spy();
    const base = p.stream.bind(p);
    p.stream = (input, signal) => {
      startedBeforeCall = ofType(R.myAlice, 'agent_turn_started').length === 1;
      return base(input, signal);
    };
    ctx.agents.setProvider(p);
    enter(alice, R.myAlice);

    say(alice, R.myAlice, '안녕', A.alice);
    // dispatch가 돌아온 시점에 이미 기록돼 있다 (await 없음)
    const sync = ctx.store.listAll(R.myAlice).filter((e) => e.type === 'message' || e.type === 'agent_turn_started');
    expect(sync.map((e) => e.type)).toEqual(['message', 'agent_turn_started']);
    expect(sync[1]).toMatchObject({ agentId: A.alice, trigger: { reason: 'addressed' } });

    await ctx.agents.drain();
    expect(startedBeforeCall).toBe(true);
    const seq = ctx.store.listAll(R.myAlice).filter((e) => e.seq > 0 && ['message', 'agent_turn_started', 'agent_step', 'agent_turn_ended'].includes(e.type));
    // 소유자 동행 My Room이라 private 기억이 제공된다 → recalling 후 drafting
    expect(seq.map((e) => e.type)).toEqual(['message', 'agent_turn_started', 'agent_step', 'agent_step', 'message', 'agent_turn_ended']);
    const [, started, recalling, drafting, reply, ended] = seq as RoomEvent[];
    expect(new Set([started!.turnId, recalling!.turnId, drafting!.turnId, reply!.turnId, ended!.turnId]).size).toBe(1);
    expect(reply).toMatchObject({ actorKind: 'agent', actorId: A.alice, type: 'message' });
    expect(ended).toMatchObject({ type: 'agent_turn_ended', result: 'acted' });
    expect([recalling, drafting]).toMatchObject([
      { type: 'agent_step', kind: 'recalling' },
      { type: 'agent_step', kind: 'drafting' },
    ]);
  });

  it('같은 입력이면 같은 결과 (mock은 결정적이다)', async () => {
    const run = async () => {
      start();
      enter(alice, R.myAlice);
      say(alice, R.myAlice, '안녕', A.alice);
      await ctx.agents.drain();
      const m = ofType(R.myAlice, 'message').at(-1)!;
      return m.type === 'message' ? m.text : '';
    };
    const first = await run();
    ctx.agents.stop();
    expect(await run()).toBe(first);
  });

  it('동행 중 소유자 발언이 Agent를 부르지 않으면 pass한다 (거의 침묵)', async () => {
    enter(alice, R.myAlice);
    say(alice, R.myAlice, '오늘은 조용히 작업할게');
    await ctx.agents.drain();
    expect(lastOutcome()).toMatchObject({ agentId: A.alice, result: 'pass', passReason: 'nothing_to_add' });
    expect(ofType(R.myAlice, 'message')).toHaveLength(1);
    expect(ofType(R.myAlice, 'agent_turn_ended')).toMatchObject([{ result: 'pass', passReason: 'nothing_to_add' }]);
  });

  it('시드 사용자(엄마)의 Agent도 지목되면 auto_reply로 돈다 (승인 요청 도구는 없다)', async () => {
    say(alice, R.family, '엄마에게', A.mom);
    await ctx.agents.drain();
    expect(turnsOf(R.family, A.mom)).toMatchObject([{ trigger: { reason: 'auto_reply' } }]);
    expect(mom).toBeDefined();
  });

  it('DM에서는 Agent가 돌지 않는다', async () => {
    say(alice, R.dmAliceBob, '안녕', A.alice);
    await ctx.agents.drain();
    expect(ofType(R.dmAliceBob, 'agent_turn_started')).toHaveLength(0);
  });

  it('턴당 agent_step은 최대 3개', async () => {
    enter(alice, R.myAlice);
    say(alice, R.myAlice, '안녕', A.alice);
    await ctx.agents.drain();
    expect(ofType(R.myAlice, 'agent_step').length).toBeLessThanOrEqual(3);
  });
});

describe('연쇄 상한 (AGENT_CHAIN_LIMIT=4)', () => {
  beforeEach(() => start());

  it('Agent끼리 ping-pong하면 4번째에서 agent_paused, 사람 발언으로 풀린다', async () => {
    say(alice, R.friends, `ping ${A.bob}`, A.alice);
    await ctx.agents.drain();

    const agentMsgs = ofType(R.friends, 'message').filter((e) => e.actorKind === 'agent');
    expect(agentMsgs.map((e) => e.actorId)).toEqual([A.alice, A.bob, A.alice, A.bob]);
    const paused = ofType(R.friends, 'agent_paused');
    expect(paused).toMatchObject([{ agentId: A.alice, reason: 'chain_limit' }]);
    expect(turnsOf(R.friends, A.alice)).toHaveLength(2);
    expect(turnsOf(R.friends, A.bob)).toHaveLength(2);
    expect(ctx.agents.scheduler.chainCount(R.friends)).toBe(4);

    // Alice(agentState)는 paused. 사람이 다시 말하면 chainCount가 0으로 돌아가고 다시 진행된다.
    const st = buildAgentState({ agentId: A.alice, ownerUserId: alice, homeRoomId: R.friends }, ctx.store.listAll(R.friends));
    expect(st.activity).toBe('paused');
    say(bob, R.friends, `ping ${A.alice}`, A.bob);
    expect(ctx.agents.scheduler.chainCount(R.friends)).toBe(0);
    await ctx.agents.drain();
    expect(ofType(R.friends, 'agent_paused')).toHaveLength(2);
  });

  it('Agent 이벤트는 to로 지정된 다른 Agent만 깨운다 (to 없으면 아무도 깨우지 않는다)', async () => {
    ctx.agents.setProvider(scripted(() => ({ name: 'say', input: { text: '혼잣말' } })));
    say(alice, R.friends, '안녕', A.alice);
    await ctx.agents.drain();
    expect(turnsOf(R.friends, A.alice)).toHaveLength(1);
    expect(turnsOf(R.friends, A.bob)).toHaveLength(0);
    expect(ofType(R.friends, 'agent_turn_started')).toHaveLength(1);
  });

  it('시간당 상한(MAX_TURNS_PER_ROOM_HOUR)을 넘으면 agent_paused{budget}', async () => {
    ctx.agents.stop();
    start({ maxTurnsPerRoomHour: 2 });
    for (let i = 0; i < 3; i++) {
      say(alice, R.friends, `안녕 ${i}`, A.alice);
      await ctx.agents.drain();
    }
    expect(turnsOf(R.friends, A.alice)).toHaveLength(2);
    expect(ofType(R.friends, 'agent_paused')).toMatchObject([{ agentId: A.alice, reason: 'budget' }]);
  });
});

describe('방문 Agent', () => {
  const mandate = { text: '인사하고 가볍게 이야기만', allowedActions: ['chat', 'comment'] as const };

  const visit = async () => {
    const v = sendAgentVisit(ctx, bob, R.myAlice, { text: mandate.text, allowedActions: [...mandate.allowedActions] });
    acceptVisit(ctx, alice, v.visitId, ['chat', 'comment']);
    await ctx.agents.drain();
    return v.visitId;
  };

  beforeEach(() => start());

  it('도착하면 도착 턴을 1회 받는다', async () => {
    const visitId = await visit();
    const turns = turnsOf(R.myAlice, A.bob);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ trigger: { reason: 'arrival' } });
    const greeting = ofType(R.myAlice, 'message').find((e) => e.actorId === A.bob);
    expect(greeting).toMatchObject({ actorKind: 'agent' });
    expect(ctx.repo.getVisit(visitId)!.status).toBe('active');
  });

  it('턴 한도(VISIT_MAX_TURNS=6)에 도달하면 end_visit 강제 턴으로 끝나고 takeout이 공개된다', async () => {
    const visitId = await visit();
    for (let i = 0; i < 5; i++) {
      say(alice, R.myAlice, `질문 ${i}?`);
      await ctx.agents.drain();
    }
    // 도착 1 + 질문 5 = 6턴 → 강제 end_visit 턴 1개
    expect(turnsOf(R.myAlice, A.bob)).toHaveLength(7);
    expect(ofType(R.myAlice, 'agent_paused')).toMatchObject([{ agentId: A.bob, reason: 'visit_turn_limit' }]);
    expect(ctx.repo.getVisit(visitId)!.status).toBe('ended');
    expect(ofType(R.myAlice, 'visit_ended')).toMatchObject([{ visitId, reason: 'turn_limit' }]);
    const takeout = ofType(R.myAlice, 'visit_takeout');
    expect(takeout).toHaveLength(1);
    expect(takeout[0]).toMatchObject({ visibility: 'room', actorKind: 'agent', actorId: A.bob });
    // 출발 Room에는 소유자(Bob)만 보는 보고가 남는다
    expect(ofType(R.myBob, 'visit_report')).toMatchObject([{ visibility: `private:${bob}` }]);
    expect(ofType(R.myBob, 'agent_returned')).toHaveLength(1);
    // 방문이 끝난 뒤에는 더 이상 깨어나지 않는다
    say(alice, R.myAlice, '또 질문?');
    await ctx.agents.drain();
    expect(turnsOf(R.myAlice, A.bob)).toHaveLength(7);
  });

  it('end_visit 도구를 스스로 쓰면 agent_ended로 끝난다', async () => {
    ctx.agents.setProvider(
      scripted((i) =>
        i.trigger.reason === 'arrival'
          ? { name: 'end_visit', input: { public_takeout: '잘 봤어요', report_for_owner: '문제 없었어요' } }
          : { name: 'pass', input: { reason: 'nothing_to_add' } },
      ),
    );
    const v = sendAgentVisit(ctx, bob, R.myAlice, { text: 'x', allowedActions: ['chat'] });
    acceptVisit(ctx, alice, v.visitId, ['chat']);
    await ctx.agents.drain();
    expect(ofType(R.myAlice, 'visit_ended')).toMatchObject([{ reason: 'agent_ended' }]);
    expect(ofType(R.myAlice, 'visit_takeout')).toMatchObject([{ text: '잘 봤어요' }]);
  });

  it('방문 Agent에게는 edit_board·remember 도구가 주어지지 않고, 써도 거부된다', async () => {
    const p = scripted(() => ({ name: 'edit_board', input: { op: 'create', title: '몰래 카드' } }));
    ctx.agents.setProvider(p);
    await visit();
    const tools = p.inputs[0]!.tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['say', 'comment', 'end_visit', 'pass']));
    expect(tools).not.toContain('edit_board');
    expect(tools).not.toContain('remember');
    expect(tools).not.toContain('propose_edit'); // grant에 없다
    expect(lastOutcome()).toMatchObject({ result: 'error', errorCode: 'tool_not_allowed', errorStatus: 403 });
    expect(ofType(R.myAlice, 'card_created')).toHaveLength(0);
    expect(ofType(R.myAlice, 'agent_turn_ended')).toMatchObject([{ result: 'error' }]);

    ctx.agents.setProvider(scripted(() => ({ name: 'remember', input: { text: '엿듣기', kind: 'fact' } })));
    say(alice, R.myAlice, '질문?');
    await ctx.agents.drain();
    const o = ctx.agents.outcomes.filter((x) => x.agentId === A.bob).at(-1)!;
    expect(o).toMatchObject({ result: 'error', errorCode: 'tool_not_allowed' });
    expect(ofType(R.myAlice, 'memory_retained').filter((e) => e.actorId === A.bob)).toHaveLength(0);
  });

  it('방문 Agent 프롬프트에는 개인 ns와 방문 범위 밖 이벤트가 없다', async () => {
    say(alice, R.myAlice, '방문 전 비밀 이야기');
    const p = spy();
    ctx.agents.setProvider(p);
    await visit();
    const input = p.inputs.find((i) => i.agent.id === A.bob)!;
    expect(input.mode).toBe('visiting');
    expect(input.memories).toEqual([]);
    expect(input.mandate?.text).toBe(mandate.text);
    const all = `${input.system}\n${input.prompt}`;
    expect(all).not.toContain('매운 음식'); // Alice의 private 기억
    expect(all).not.toContain('방문 전 비밀 이야기');
    expect(input.roomSummary).toBeNull();
  });

  it('호스트 Agent의 턴에도 방문자가 있으면 private 기억이 없다', async () => {
    enter(alice, R.myAlice);
    const p = spy();
    ctx.agents.setProvider(p);
    say(alice, R.myAlice, '혼자 있을 때', A.alice);
    await ctx.agents.drain();
    expect(p.inputs.at(-1)!.memories.map((m) => m.id)).toContain('mem_seed_alice_private');

    await visit();
    say(alice, R.myAlice, '손님 있을 때', A.alice);
    await ctx.agents.drain();
    const hostTurn = p.inputs.filter((i) => i.agent.id === A.alice).at(-1)!;
    expect(hostTurn.memories.map((m) => m.id)).not.toContain('mem_seed_alice_private');
  });
});

describe('권한 강제와 검증', () => {
  beforeEach(() => start());

  it('동행 중 소유자 Agent는 edit_board를 쓸 수 있고, 대리 참여 중에는 쓸 수 없다', async () => {
    const p = scripted(() => ({ name: 'edit_board', input: { op: 'create', title: '메모', body: 'b' } }));
    ctx.agents.setProvider(p);
    enter(alice, R.myAlice);
    say(alice, R.myAlice, '카드 하나', A.alice);
    await ctx.agents.drain();
    expect(p.inputs[0]!.mode).toBe('accompanied');
    expect(p.inputs[0]!.tools.map((t) => t.name)).toContain('edit_board');
    expect(ofType(R.myAlice, 'card_created')).toMatchObject([{ ownerTag: `agent:${A.alice}`, actorKind: 'agent' }]);

    dispatch(ctx, { kind: 'human', userId: alice }, { type: 'leave_room', roomId: R.myAlice, mandate: { text: '대신 응대', allowedActions: ['chat', 'comment'] } });
    say(alice, R.myAlice, '또 카드', A.alice);
    await ctx.agents.drain();
    expect(p.inputs.at(-1)!.mode).toBe('representing');
    expect(p.inputs.at(-1)!.tools.map((t) => t.name)).not.toContain('edit_board');
    expect(lastOutcome()).toMatchObject({ result: 'error', errorCode: 'tool_not_allowed' });
    expect(ofType(R.myAlice, 'card_created')).toHaveLength(1);
  });

  it('Room Agent는 edit_board·remember를 쓸 수 없다', async () => {
    ctx.agents.setProvider(scripted(() => ({ name: 'edit_board', input: { op: 'create', title: 'x' } })));
    say(alice, R.friends, '정리해줘', SEED.roomAgents.friends);
    await ctx.agents.drain();
    expect(lastOutcome()).toMatchObject({ agentId: SEED.roomAgents.friends, errorCode: 'tool_not_allowed' });
    expect(ofType(R.friends, 'card_created')).toHaveLength(1); // 시드 카드뿐 (Room Agent가 새로 만들지 못했다)
  });

  it('제공되지 않은 memory id를 쓰면 403(memory_not_provided)로 거부된다', async () => {
    ctx.agents.setProvider(scripted(() => ({ name: 'say', input: { text: '이거 기억나요', used_memory_ids: ['mem_seed_team_1'] } })));
    say(alice, R.family, '안녕', A.alice);
    await ctx.agents.drain();
    expect(lastOutcome()).toMatchObject({ result: 'error', errorCode: 'memory_not_provided', errorStatus: 403 });
    expect(ofType(R.family, 'message').filter((e) => e.actorKind === 'agent')).toHaveLength(0);
  });

  it('제공된 memory id는 통과하고 message.memoryRefs로 남는다 (mock은 첫 기억을 인용)', async () => {
    const p = spy();
    ctx.agents.setProvider(p);
    say(alice, R.family, '안녕', A.alice);
    await ctx.agents.drain();
    const input = p.inputs[0]!;
    expect(input.memories.length).toBeGreaterThan(0);
    const reply = ofType(R.family, 'message').find((e) => e.actorKind === 'agent')!;
    expect(reply.type === 'message' && reply.memoryRefs).toEqual([input.memories[0]!.id]);
    // 가족 Room 턴에는 팀 Room의 기억이 없다
    expect(input.memories.map((m) => m.id)).not.toContain('mem_seed_team_1');
  });

  it('존재하지 않는 to·card_id는 거부된다', async () => {
    ctx.agents.setProvider(scripted(() => ({ name: 'say', input: { text: 'hi', to: 'nobody' } })));
    say(alice, R.friends, '안녕', A.alice);
    await ctx.agents.drain();
    expect(lastOutcome()).toMatchObject({ errorCode: 'unknown_recipient' });

    ctx.agents.setProvider(scripted(() => ({ name: 'comment', input: { card_id: 'c_none', text: 'hi' } })));
    say(alice, R.friends, '안녕', A.alice);
    await ctx.agents.drain();
    expect(lastOutcome()).toMatchObject({ errorCode: 'card_not_found' });
  });

  it('잘못된 도구 입력과 여러 tool_use: 첫 번째만 실행한다', async () => {
    ctx.agents.setProvider(scripted(() => ({ name: 'say', input: { nope: 1 } })));
    say(alice, R.friends, '안녕', A.alice);
    await ctx.agents.drain();
    expect(lastOutcome()).toMatchObject({ errorCode: 'invalid_tool_input' });

    ctx.agents.setProvider(
      scripted(() => [
        { name: 'say', input: { text: '첫째' } },
        { name: 'say', input: { text: '둘째' } },
      ]),
    );
    say(alice, R.friends, '다시', A.alice);
    await ctx.agents.drain();
    const texts = ofType(R.friends, 'message').filter((e) => e.actorKind === 'agent').map((e) => (e.type === 'message' ? e.text : ''));
    expect(texts).toEqual(['첫째']);
  });

  it('provider 오류는 1회 재시도하고, 계속 실패하면 error로 끝난다', async () => {
    let n = 0;
    ctx.agents.setProvider(scripted(() => (n++ === 0 ? new Error('boom') : { name: 'say', input: { text: '재시도 성공' } })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    say(alice, R.friends, '안녕', A.alice);
    await ctx.agents.drain();
    expect(lastOutcome()).toMatchObject({ result: 'acted' });

    ctx.agents.setProvider(scripted(() => new Error('boom')));
    say(alice, R.friends, '또', A.alice);
    await ctx.agents.drain();
    expect(lastOutcome()).toMatchObject({ result: 'error', errorCode: 'provider_error' });
    expect(ofType(R.friends, 'agent_turn_ended').at(-1)).toMatchObject({ result: 'error' });
    vi.restoreAllMocks();
  });

  it('remember는 서버가 정한 ns에 저장된다 (My Room 단독이면 private, 방문자가 있으면 room ns)', async () => {
    ctx.agents.setProvider(scripted(() => ({ name: 'remember', input: { text: '커피는 아메리카노', kind: 'preference' } })));
    enter(alice, R.myAlice);
    say(alice, R.myAlice, '기억해줘', A.alice);
    await ctx.agents.drain();
    expect(lastOutcome()).toMatchObject({ result: 'acted', tool: 'remember' });
    expect(ofType(R.myAlice, 'memory_retained')).toMatchObject([{ ns: `agent:${A.alice}:private`, visibility: `private:${alice}` }]);

    // 방문자(사람)가 들어와 있으면 private에 쓰지 않는다 (room ns, 공개 가시성)
    const v = requestHumanVisit(ctx, bob, R.myAlice);
    acceptVisit(ctx, alice, v.visitId, ['chat']);
    say(alice, R.myAlice, '또 기억해줘', A.alice);
    await ctx.agents.drain();
    expect(lastOutcome()).toMatchObject({ result: 'acted', tool: 'remember' });
    expect(ofType(R.myAlice, 'memory_retained').at(-1)).toMatchObject({ ns: `room:${R.myAlice}`, visibility: 'room' });
  });
});

describe('대리 참여(representing)와 승인 요청', () => {
  beforeEach(() => start());

  const leave = () =>
    dispatch(ctx, { kind: 'human', userId: alice }, {
      type: 'leave_room',
      roomId: R.myAlice,
      mandate: { text: '토요일 오후, 확정은 내 승인', allowedActions: ['chat', 'comment', 'propose_edit', 'request_approval'] },
    });
  const bobVisits = () => {
    const v = requestHumanVisit(ctx, bob, R.myAlice);
    acceptVisit(ctx, alice, v.visitId, ['chat', 'comment']);
  };

  it('Leave(mandate)한 방에서 소유자 부재 중 방문자 발언에 호스트 Agent가 representing으로 응답한다', async () => {
    enter(alice, R.myAlice);
    leave();
    const p = spy();
    ctx.agents.setProvider(p);
    bobVisits();
    say(bob, R.myAlice, '토요일 어때요?');
    await ctx.agents.drain();
    const input = p.inputs.find((i) => i.agent.id === A.alice)!;
    expect(input.mode).toBe('representing');
    expect(input.mandate?.text).toContain('토요일 오후');
    expect(input.trigger.reason).toBe('visitor_message');
    expect(input.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['say', 'propose_edit', 'request_approval', 'remember']));
    expect(input.tools.map((t) => t.name)).not.toContain('edit_board');
    expect(ofType(R.myAlice, 'message').filter((e) => e.actorId === A.alice)).toHaveLength(1);
  });

  it('소유자가 자리에 있으면 방문자 발언에 호스트 Agent를 깨우지 않는다', async () => {
    enter(alice, R.myAlice);
    bobVisits();
    say(bob, R.myAlice, '안녕하세요');
    await ctx.agents.drain();
    expect(turnsOf(R.myAlice, A.alice)).toHaveLength(0);
  });

  it('"확정"은 직접 하지 않고 request_approval로 넘긴다 (승인자는 소유자)', async () => {
    enter(alice, R.myAlice);
    leave();
    bobVisits();
    say(bob, R.myAlice, '토요일로 확정하자', A.alice);
    await ctx.agents.drain();
    const req = ofType(R.myAlice, 'approval_requested');
    expect(req).toHaveLength(1);
    expect(req[0]).toMatchObject({ kind: 'decision', approvers: [alice], options: ['확정', '보류'], actorId: A.alice });
    const row = ctx.db.raw.prepare('SELECT kind, status FROM approvals').all();
    expect(row).toEqual([{ kind: 'decision', status: 'pending' }]);
    const st = buildAgentState({ agentId: A.alice, ownerUserId: alice, homeRoomId: R.myAlice }, ctx.store.listAll(R.myAlice));
    expect(st.activity).toBe('awaiting');
  });

  it('request_approval의 room_message는 승인 요청과 함께 상대에게 보이는 안내 메시지로 남는다', async () => {
    enter(alice, R.myAlice);
    leave();
    bobVisits();
    ctx.agents.setProvider(
      scripted(() => ({ name: 'request_approval', input: { question: '토요일 3시로 할까요?', options: ['3시', '보류'], room_message: 'Alice님께 확인을 요청해 두었어요.' } })),
    );
    say(bob, R.myAlice, '토요일 3시로 정하자, Alice 어때?', A.alice);
    await ctx.agents.drain();
    expect(ofType(R.myAlice, 'approval_requested')).toHaveLength(1);
    const msgs = ofType(R.myAlice, 'message').filter((e) => e.actorId === A.alice);
    expect(msgs.map((m) => (m as { text?: string }).text)).toEqual(['Alice님께 확인을 요청해 두었어요.']);
  });

  it('propose_edit는 소유자 승인으로 올라가고 수정안이 이벤트에 실린다', async () => {
    const card = dispatch(ctx, { kind: 'human', userId: alice }, { type: 'create_card', roomId: R.myAlice, title: '약속', body: '' });
    enter(alice, R.myAlice);
    leave();
    bobVisits();
    say(bob, R.myAlice, '이 카드 수정 제안해줘', A.alice);
    ctx.agents.setProvider(scripted(() => ({ name: 'propose_edit', input: { card_id: card.data.cardId, body: '토요일 15시', public_rationale: '시간 확정 필요' } })));
    await ctx.agents.drain();
    expect(ofType(R.myAlice, 'approval_requested')).toMatchObject([
      { kind: 'edit', approvers: [alice], publicRationale: '시간 확정 필요', proposal: { cardId: card.data.cardId, body: '토요일 15시' } },
    ]);
    // 카드는 아직 바뀌지 않았다 (승인 전)
    expect(ctx.repo.getCard(R.myAlice, card.data.cardId as string)!.body).toBe('');
  });
});

describe('Our Room (AGENT_AUTO_REPLY=off: 이전 규칙)', () => {
  beforeEach(() => start({ agentAutoReply: false }));

  it('질문이나 "정리"가 있으면 Room Agent가 말하고, 평범한 대화에는 조용하다', async () => {
    say(alice, R.friends, '오늘 점심 뭐 먹을까');
    await ctx.agents.drain();
    expect(ofType(R.friends, 'agent_turn_started')).toHaveLength(0);

    say(alice, R.friends, '다들 언제 모일까요?');
    await ctx.agents.drain();
    expect(turnsOf(R.friends, SEED.roomAgents.friends)).toHaveLength(1);
    const reply = ofType(R.friends, 'message').find((e) => e.actorKind === 'room_agent');
    expect(reply).toMatchObject({ actorId: SEED.roomAgents.friends });
    // 작성자의 Agent는 부르지 않는다
    expect(turnsOf(R.friends, A.alice)).toHaveLength(0);
  });

  it('"확정"이 있으면 Room Agent는 선택지로 request_approval (승인자는 시드가 아닌 사람 구성원 전원)', async () => {
    say(alice, R.friends, '금요일로 확정할까요?', SEED.roomAgents.friends);
    await ctx.agents.drain();
    expect(ofType(R.friends, 'approval_requested')).toMatchObject([{ kind: 'decision', approvers: [alice, bob], actorKind: 'room_agent' }]);

    say(alice, R.family, '이번 주 정하자 확정?', SEED.roomAgents.family);
    await ctx.agents.drain();
    expect(ofType(R.family, 'approval_requested')).toMatchObject([{ approvers: [alice] }]); // 엄마는 시드
  });

  it('구성원 Agent의 propose_edit 승인자는 소유자를 제외한 사람 구성원 1인', async () => {
    ctx.agents.setProvider(scripted(() => ({ name: 'propose_edit', input: { title: '새 안건', body: '내용' } })));
    say(alice, R.friends, '제안해줘', A.alice);
    await ctx.agents.drain();
    expect(ofType(R.friends, 'approval_requested')).toMatchObject([{ kind: 'edit', approvers: [bob] }]);
  });

  it('Leave(대리 참여)한 구성원은 언급되면 그 Agent가 representing으로 응답한다', async () => {
    dispatch(ctx, { kind: 'human', userId: bob }, { type: 'enter_room', roomId: R.friends });
    dispatch(ctx, { kind: 'human', userId: alice }, { type: 'enter_room', roomId: R.friends });
    dispatch(ctx, { kind: 'human', userId: bob }, { type: 'leave_room', roomId: R.friends, mandate: { text: '일정만 조율', allowedActions: ['chat'] } });
    const p = spy();
    ctx.agents.setProvider(p);
    say(alice, R.friends, 'Bob 토요일 되나요?');
    await ctx.agents.drain();
    const input = p.inputs.find((i) => i.agent.id === A.bob)!;
    expect(input.mode).toBe('representing');
    expect(input.mandate?.text).toBe('일정만 조율');
  });
});

describe('Our Room 자동 반응·자동 대리 (기본 켬)', () => {
  beforeEach(() => start());
  const bobAgentTurns = () => turnsOf(R.friends, A.bob);
  const roomAgentTurns = () => turnsOf(R.friends, SEED.roomAgents.friends);

  it('모두에게 평범한 말을 해도 Room Agent와 부재 구성원 Bob의 Agent가 각각 한 번씩 반응한다 (질문 여부와 무관)', async () => {
    say(alice, R.friends, '오늘 점심은 간단히 먹었어');
    await ctx.agents.drain();
    expect(roomAgentTurns()).toMatchObject([{ trigger: { reason: 'room_agent_call' } }]);
    expect(bobAgentTurns()).toMatchObject([{ trigger: { reason: 'auto_reply' } }]);
    expect(ofType(R.friends, 'message').filter((e) => e.actorKind === 'room_agent')).toHaveLength(1);
  });

  it('2글자 이하 반응("ㅇㅇ", "ㅋㅋ")에는 부재 구성원 Agent를 깨우지 않는다', async () => {
    say(alice, R.friends, 'ㅇㅇ');
    say(alice, R.friends, 'ㅋㅋ!');
    await ctx.agents.drain();
    expect(bobAgentTurns()).toHaveLength(0);
    expect(ofType(R.friends, 'message').filter((e) => e.actorKind === 'room_agent' || e.actorKind === 'agent')).toHaveLength(0);
  });

  it('Bob 이름 언급: 접속하지 않은 Bob의 Agent가 auto_reply(representing, 도구는 say·request_approval·pass)로 응답한다', async () => {
    const p = spy();
    ctx.agents.setProvider(p);
    say(alice, R.friends, 'Bob, 토요일 어때?');
    await ctx.agents.drain();
    // 지목된 Bob의 Agent만 (Room Agent는 끼어들지 않는다)
    expect(ofType(R.friends, 'agent_turn_started')).toHaveLength(1);
    expect(roomAgentTurns()).toHaveLength(0);
    expect(bobAgentTurns()).toMatchObject([{ trigger: { reason: 'auto_reply' } }]);
    const input = p.inputs.find((i) => i.agent.id === A.bob)!;
    expect(input.mode).toBe('representing');
    expect(input.mandate?.allowedActions).toEqual(['chat', 'request_approval']);
    expect(input.tools.map((t) => t.name).sort()).toEqual(['pass', 'request_approval', 'say']);
    // 소유자 결정이 필요한 일정이라 승인으로 넘어가고, 소유자(Bob)가 승인자다
    expect(ofType(R.friends, 'approval_requested')).toMatchObject([{ kind: 'decision', approvers: [bob], actorId: A.bob }]);
  });

  it('팀 방 일반 메시지: Room Agent → Bob → Dana 순(결정적)으로 각 1턴, 부재 Agent는 최대 2명', async () => {
    say(alice, R.team, '다 같이 점심 먹자, 괜찮아?');
    await ctx.agents.drain();
    const started = ofType(R.team, 'agent_turn_started');
    expect(started.map((e) => (e.type === 'agent_turn_started' ? e.agentId : ''))).toEqual([SEED.roomAgents.team, A.bob, A.dana]);
    const personal = ofType(R.team, 'message').filter((e) => e.actorKind === 'agent');
    expect(personal.map((e) => e.actorId)).toEqual([A.bob, A.dana]);
    expect(ofType(R.team, 'approval_requested').filter((e) => e.actorId === A.dana)).toHaveLength(0);
  });

  it('가족 방 일반 메시지: Room Agent와 엄마·아빠의 Agent가 이 순서로 auto_reply로 say한다', async () => {
    say(alice, R.family, '이번 주말에 뭐 할까?');
    await ctx.agents.drain();
    const started = ofType(R.family, 'agent_turn_started').map((e) => (e.type === 'agent_turn_started' ? e.agentId : ''));
    expect(started).toEqual([SEED.roomAgents.family, A.mom, A.dad]);
    const reply = ofType(R.family, 'message').find((e) => e.actorId === A.mom);
    expect(reply).toMatchObject({ actorKind: 'agent', type: 'message' });
    expect(ctx.agents.outcomes.filter((o) => o.agentId === A.mom)).toMatchObject([{ result: 'acted', tool: 'say' }]);
    expect(ctx.agents.outcomes.filter((o) => o.agentId === A.dad)).toMatchObject([{ result: 'acted', tool: 'say' }]);
  });

  it('아빠 지목: 아빠의 Agent만 응답하고, 아빠 Agent는 request_approval을 쓸 수 없다', async () => {
    const p = spy();
    ctx.agents.setProvider(p);
    say(alice, R.family, '아빠, 일요일 오전 확정하자');
    await ctx.agents.drain();
    expect(ofType(R.family, 'agent_turn_started').map((e) => (e.type === 'agent_turn_started' ? e.agentId : ''))).toEqual([A.dad]);
    expect(p.inputs.find((i) => i.agent.id === A.dad)!.tools.map((t) => t.name).sort()).toEqual(['pass', 'say']);
    expect(ofType(R.family, 'approval_requested')).toHaveLength(0);
  });

  it('엄마 지목: 엄마의 Agent만 응답하고 Room Agent는 끼어들지 않는다', async () => {
    say(alice, R.family, '엄마, 점심 뭐 먹을까?');
    await ctx.agents.drain();
    expect(ofType(R.family, 'agent_turn_started').map((e) => (e.type === 'agent_turn_started' ? e.agentId : ''))).toEqual([A.mom]);
  });

  it('시드 사용자 Agent의 request_approval은 도구 목록에서도 서버 검증에서도 막힌다', async () => {
    const p = spy();
    ctx.agents.setProvider(p);
    say(alice, R.family, '엄마, 일요일 오전 확정하자');
    await ctx.agents.drain();
    expect(p.inputs.find((i) => i.agent.id === A.mom)!.tools.map((t) => t.name).sort()).toEqual(['pass', 'say']);
    expect(ofType(R.family, 'approval_requested')).toHaveLength(0);

    ctx.agents.setProvider(scripted(() => ({ name: 'request_approval', input: { question: '확정할까요?', options: ['예', '아니오'] } })));
    say(alice, R.family, '엄마, 다시 확정하자');
    await ctx.agents.drain();
    expect(ctx.agents.outcomes.filter((o) => o.agentId === A.mom).at(-1)).toMatchObject({ result: 'error', errorCode: 'tool_not_allowed' });
    expect(ofType(R.family, 'approval_requested')).toHaveLength(0);
  });

  it('Bob은 사람이라 자동 대리에서 request_approval을 쓸 수 있다 (시드 사용자와 다름)', async () => {
    const p = spy();
    ctx.agents.setProvider(p);
    say(alice, R.friends, 'Bob, 토요일 어때?');
    await ctx.agents.drain();
    expect(p.inputs.find((i) => i.agent.id === A.bob)!.tools.map((t) => t.name)).toContain('request_approval');
  });

  it('인물 설정(persona)이 시스템 프롬프트에 반영된다', async () => {
    const p = spy();
    ctx.agents.setProvider(p);
    say(alice, R.team, '다 같이 점심 먹자, 괜찮아?');
    await ctx.agents.drain();
    const dana = p.inputs.find((i) => i.agent.id === A.dana)!;
    expect(dana.system).toContain('30분을 넘기는 것을 싫어한다');
    expect(dana.system).toContain('[인물 대리 응답]');
    expect(p.inputs.find((i) => i.agent.id === A.bob)!.system).toContain('유머');
  });

  it('연쇄 제한: 부재 구성원 Agent의 say는 다른 Agent를 다시 깨우지 않는다 (사람 메시지 1건당 각 1턴)', async () => {
    say(alice, R.team, '다 같이 점심 먹자');
    await ctx.agents.drain();
    for (const id of [SEED.roomAgents.team, A.bob, A.dana]) expect(turnsOf(R.team, id)).toHaveLength(1);
    expect(ofType(R.team, 'agent_paused')).toHaveLength(0);
  });

  it('작성자 본인의 Agent와 접속 중인 구성원의 Agent는 끼어들지 않는다', async () => {
    enter(bob, R.friends);
    say(alice, R.friends, 'Bob, 토요일 어때?');
    await ctx.agents.drain();
    expect(bobAgentTurns()).toHaveLength(0);
    expect(turnsOf(R.friends, A.alice)).toHaveLength(0);
    expect(roomAgentTurns()).toHaveLength(0); // 본인이 답할 일: Room Agent도 끼어들지 않는다
  });

  it('지목 형태별(Bob야 / @Bob / 문중)로 Bob의 Agent만 응답하고 Room Agent는 조용하다', async () => {
    for (const t of ['Bob야 토요일 어때', '@Bob 토요일 어때', '토요일에 Bob도 올 수 있나']) {
      say(alice, R.friends, t);
      await ctx.agents.drain();
    }
    expect(bobAgentTurns()).toHaveLength(3);
    expect(roomAgentTurns()).toHaveLength(0);
  });

  it('지목 + Room Agent 명시 호출이면 둘 다 응답할 수 있다', async () => {
    say(alice, R.friends, 'Bob, 토요일 어때? 룸 에이전트도 정리해줘');
    await ctx.agents.drain();
    expect(bobAgentTurns()).toMatchObject([{ trigger: { reason: 'auto_reply' } }]);
    expect(roomAgentTurns()).toMatchObject([{ trigger: { reason: 'room_agent_call' } }]);
  });

  it('명시적 Leave(위임 없음)한 Bob을 지목해도 Room Agent가 대신 답하지 않는다', async () => {
    enter(bob, R.friends);
    dispatch(ctx, { kind: 'human', userId: bob }, { type: 'leave_room', roomId: R.friends });
    say(alice, R.friends, 'Bob, 토요일 어때?');
    await ctx.agents.drain();
    expect(bobAgentTurns()).toHaveLength(0);
    expect(roomAgentTurns()).toHaveLength(0);
  });

  it('위임(mandate)하고 Leave한 Bob을 지목하면 기존대로 Bob의 Agent가 representing으로 응답한다', async () => {
    enter(bob, R.friends);
    dispatch(ctx, { kind: 'human', userId: bob }, { type: 'leave_room', roomId: R.friends, mandate: { text: '일정만 조율', allowedActions: ['chat'] } });
    say(alice, R.friends, 'Bob, 토요일 어때?');
    await ctx.agents.drain();
    expect(bobAgentTurns()).toMatchObject([{ trigger: { reason: 'representing' } }]);
    expect(roomAgentTurns()).toHaveLength(0);
  });

  it('Bob이 접속(present)하면 자동 대리가 즉시 멈춘다: 대기 중 작업도 버린다', async () => {
    say(alice, R.friends, 'Bob, 토요일 어때? @room'); // Room Agent 턴이 먼저 돌아 Bob의 job이 대기열에 남는다
    enter(bob, R.friends); // 대기열에 자동 대리 job이 남아 있는 사이 입장
    await ctx.agents.drain();
    expect(bobAgentTurns()).toHaveLength(0);
    say(alice, R.friends, 'Bob, 일요일은?');
    await ctx.agents.drain();
    expect(bobAgentTurns()).toHaveLength(0);
  });

  it('명시적 Leave(위임 없음)한 구성원은 자동 대리하지 않고, 위임 있는 Leave는 기존 representing이다', async () => {
    enter(bob, R.friends);
    dispatch(ctx, { kind: 'human', userId: bob }, { type: 'leave_room', roomId: R.friends });
    say(alice, R.friends, 'Bob, 토요일 어때?');
    await ctx.agents.drain();
    expect(bobAgentTurns()).toHaveLength(0);
  });

  it('암묵적 퇴장(구독 끊김)한 구성원은 자동 대리 대상이다', async () => {
    enter(bob, R.friends);
    dispatch(ctx, { kind: 'system' }, { type: 'implicit_leave', roomId: R.friends, userId: bob });
    say(alice, R.friends, 'Bob, 토요일 어때?');
    await ctx.agents.drain();
    expect(bobAgentTurns()).toMatchObject([{ trigger: { reason: 'auto_reply' } }]);
  });

  it('Bob에게 지정(to)한 말도 접속하지 않았다면 Bob의 Agent가 자동 대리한다 (Room Agent는 깨우지 않음)', async () => {
    say(alice, R.friends, '이번 주말 괜찮아요?', bob);
    await ctx.agents.drain();
    expect(bobAgentTurns()).toMatchObject([{ trigger: { reason: 'auto_reply' } }]);
    expect(roomAgentTurns()).toHaveLength(0);
  });

  it('자동 대리가 보낸 도구가 say·request_approval·pass 밖이면 거부한다', async () => {
    ctx.agents.setProvider(scripted(() => ({ name: 'propose_edit', input: { title: '제안', body: '내용' } })));
    say(alice, R.friends, 'Bob, 토요일 어때?');
    await ctx.agents.drain();
    expect(ctx.agents.outcomes.filter((o) => o.agentId === A.bob)).toMatchObject([{ result: 'error', errorCode: 'tool_not_allowed' }]);
    expect(ofType(R.friends, 'approval_requested').filter((e) => e.actorId === A.bob)).toHaveLength(0);
  });

  it('자동 대리 턴에는 소유자의 private 기억이 제공되지 않는다 (Room·for-room 범위만)', async () => {
    const p = spy();
    ctx.agents.setProvider(p);
    say(alice, R.friends, 'Bob, 토요일 어때?');
    await ctx.agents.drain();
    const input = p.inputs.find((i) => i.agent.id === A.bob)!;
    expect(input.memories.every((m) => !m.id.includes('private'))).toBe(true);
  });

  it('AGENT_AUTO_REPLY=off면 평범한 말에 아무도 깨우지 않는다', async () => {
    ctx.agents.stop();
    start({ agentAutoReply: false });
    say(alice, R.friends, 'Bob, 토요일 어때');
    await ctx.agents.drain();
    expect(ofType(R.friends, 'agent_turn_started')).toHaveLength(1); // 이름 언급 부재 구성원 → Room Agent만(이전 규칙)
    expect(bobAgentTurns()).toHaveLength(0);
  });

  it('My Room과 DM은 그대로다', async () => {
    enter(alice, R.myAlice);
    say(alice, R.myAlice, '오늘은 조용히 작업할게');
    await ctx.agents.drain();
    expect(turnsOf(R.myAlice, A.alice)).toHaveLength(1); // 소유자 발언 → 소유자 Agent (pass)
    expect(lastOutcome()).toMatchObject({ result: 'pass' });
    expect(ofType(R.myAlice, 'agent_turn_started')).toHaveLength(1);
  });
});

describe('활동 채널 (휘발성)', () => {
  beforeEach(() => start());

  it('thinking → writing(스트리밍 텍스트) → acting → final 순으로 activity를 발행한다', async () => {
    const sent: unknown[] = [];
    vi.spyOn(ctx.hub, 'publishActivity').mockImplementation((m) => void sent.push(m));
    enter(alice, R.myAlice);
    say(alice, R.myAlice, '안녕하세요 오늘 일정 알려줘', A.alice);
    await ctx.agents.drain();

    const msgs = sent.map((m) => ActivityMessageSchema.parse(m));
    expect(msgs.length).toBeGreaterThanOrEqual(4);
    expect(msgs.every((m) => m.agentId === A.alice && m.roomId === R.myAlice)).toBe(true);
    expect(new Set(msgs.map((m) => m.turnId)).size).toBe(1);
    expect(msgs[0]).toMatchObject({ phase: 'thinking' });
    const writing = msgs.filter((m) => m.phase === 'writing');
    expect(writing.length).toBeGreaterThan(0);
    const reply = ofType(R.myAlice, 'message').find((e) => e.actorKind === 'agent')!;
    expect(writing.at(-1)!.text).toBe(reply.type === 'message' ? reply.text : '');
    expect(msgs.some((m) => m.phase === 'acting')).toBe(true);
    expect(msgs.at(-1)).toMatchObject({ final: true, text: '' });
  });

  it('기억을 불러오면 recalling 단계를 발행하고 agent_step{recalling}을 남긴다', async () => {
    const sent: { phase?: string }[] = [];
    vi.spyOn(ctx.hub, 'publishActivity').mockImplementation((m) => void sent.push(m));
    say(alice, R.family, '안녕', A.alice);
    await ctx.agents.drain();
    expect(sent.map((m) => m.phase)).toContain('recalling');
    expect(ofType(R.family, 'agent_step').map((e) => (e.type === 'agent_step' ? e.kind : ''))).toContain('recalling');
  });

  it('mock 지연 설정: delayMs>0이면 실제로 시간이 걸리고 0이면 즉시 끝난다', async () => {
    const t0 = Date.now();
    const slow = new MockProvider({ delayMs: 30 });
    const input = spy();
    ctx.agents.setProvider(input);
    say(alice, R.friends, '안녕', A.alice);
    await ctx.agents.drain();
    const fast = Date.now() - t0;
    ctx.agents.setProvider(slow);
    const t1 = Date.now();
    say(alice, R.friends, '안녕 또', A.alice);
    await ctx.agents.drain();
    expect(Date.now() - t1).toBeGreaterThanOrEqual(60);
    expect(fast).toBeLessThan(60);
  });
});

describe('My Room: 소유자의 질문은 자기 Agent에게 한 말이다', () => {
  beforeEach(() => start());

  it('"토요일에 뭐 있어?" 같은 질문에는 say로 답한다', async () => {
    enter(alice, R.myAlice);
    say(alice, R.myAlice, '토요일에 뭐 있어?');
    await ctx.agents.drain();
    expect(lastOutcome()).toMatchObject({ agentId: A.alice, result: 'acted', tool: 'say' });
    const msgs = ofType(R.myAlice, 'message');
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({ actorKind: 'agent', actorId: A.alice });
  });

  it('owner_message 트리거의 마지막 지시와 accompanied 규칙이 프롬프트에 실린다', async () => {
    const p = spy();
    ctx.agents.setProvider(p);
    enter(alice, R.myAlice);
    say(alice, R.myAlice, '이번 주 일정 알려줘');
    await ctx.agents.drain();
    const input = p.inputs.find((i) => i.trigger.reason === 'owner_message')!;
    expect(input.prompt).toContain('소유자가 자기 Room에서 당신에게 말했다');
    expect(input.system).toContain('소유자의 질문은 당신에게 한 말이다');
    expect(input.system).toContain('번역·음역 금지');
  });
});
