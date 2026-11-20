import { afterEach, describe, expect, it } from 'vitest';
import type { RoomEvent } from '@ensemble/shared';
import { askableAgents } from '../src/agent/a2a';
import type { AgentProvider, ProviderEvent, ToolCall, TurnInput } from '../src/agent/types';
import type { Config } from '../src/config';
import type { AppContext } from '../src/context';
import { dispatch } from '../src/domain/actions';
import { acceptVisit, sendAgentVisit } from '../src/domain/visits';
import { SEED, auth, loginAs, makeApp, makeCtx } from './helpers';

const { alice, bob } = SEED.users;
const A = SEED.agents;
const R = SEED.rooms;
const RA = SEED.roomAgents;

let ctx: AppContext;
const start = (config: Partial<Config> = {}) => {
  ctx = makeCtx(config);
  ctx.agents.start();
  return ctx;
};
afterEach(() => ctx?.agents.stop());

const say = (userId: string, roomId: string, text: string, to?: string) =>
  dispatch(ctx, { kind: 'human', userId }, { type: 'send_message', roomId, text, to });
const enter = (userId: string, roomId: string) => dispatch(ctx, { kind: 'human', userId }, { type: 'enter_room', roomId });
const all = (roomId: string) => ctx.store.listAll(roomId);
type Msg = Extract<RoomEvent, { type: 'message' }>;
const msgs = (roomId: string): Msg[] => all(roomId).filter((e): e is Msg => e.type === 'message');
const turns = (roomId: string) =>
  all(roomId).flatMap((e) => (e.type === 'agent_turn_started' ? [{ agentId: e.agentId, reason: e.trigger.reason, seq: e.trigger.seq, turnId: e.turnId }] : []));

/** 스크립트형 provider: 호출 입력을 기록하고 fn이 정한 도구를 낸다 */
function scripted(fn: (input: TurnInput) => ToolCall | Error): AgentProvider & { inputs: TurnInput[] } {
  const inputs: TurnInput[] = [];
  return {
    name: 'scripted',
    inputs,
    async *stream(input): AsyncGenerator<ProviderEvent> {
      inputs.push(input);
      const r = fn(input);
      if (r instanceof Error) throw r;
      yield { type: 'tool_call', call: r };
    },
  };
}

const call = (name: ToolCall['name'], input: Record<string, unknown>): ToolCall => ({ name, input });

/** Room Agent가 ask_agents(질문), 답 턴은 say, 정리 턴은 say */
const askScript = (ids: string[]) =>
  scripted((i) => {
    if (i.trigger.reason === 'a2a_ask') return call('say', { text: `${i.agent.name}의 답`, to: 'someone_else' });
    if (i.trigger.reason === 'a2a_collect') return call('say', { text: '정리: 답을 모았어요' });
    if (i.agent.kind === 'room_agent' && i.tools.some((t) => t.name === 'ask_agents')) return call('ask_agents', { agent_ids: ids, question: '일정 괜찮을까요?' });
    return call('pass', { reason: 'nothing_to_add' });
  });

describe('ask_agents: 질문 → 답 → 정리(fan-in)', () => {
  it('수신자는 askable(구성원) 순서, 답 턴은 to=질문자·replyTo=질문 seq, 정리 턴은 정확히 1회', async () => {
    start();
    const p = askScript([A.dana, A.bob]); // 일부러 역순으로 요청
    ctx.agents.setProvider(p);
    say(alice, R.team, '금요일 회고 14시 반으로 당길까?');
    await ctx.agents.drain();

    const ask = msgs(R.team).find((m) => m.recipients)!;
    expect(ask).toMatchObject({ actorKind: 'room_agent', actorId: RA.team, recipients: [A.bob, A.dana] });
    expect(ask.to).toBeUndefined();

    const t = turns(R.team);
    expect(t.map((x) => [x.agentId, x.reason])).toEqual([
      [RA.team, 'room_agent_call'],
      [A.bob, 'a2a_ask'],
      [A.dana, 'a2a_ask'],
      [RA.team, 'a2a_collect'],
    ]);
    expect(t.filter((x) => x.reason === 'a2a_ask').every((x) => x.seq === ask.seq)).toBe(true);
    expect(t.at(-1)!.seq).toBe(ask.seq);

    const answers = msgs(R.team).filter((m) => m.replyTo === ask.seq && m.actorId !== RA.team);
    expect(answers.map((m) => [m.actorId, m.to])).toEqual([
      [A.bob, RA.team],
      [A.dana, RA.team],
    ]);
    const result = msgs(R.team).at(-1)!;
    expect(result).toMatchObject({ actorId: RA.team, replyTo: ask.seq });
    expect(result.to).toBeUndefined();
    expect(p.inputs).toHaveLength(4); // 사람 메시지 1건당 LLM 호출 5회 이하
  });

  it('답 턴은 보수적: say/request_approval/pass만, ask_agents 없음(중첩 금지). 정리 턴은 원래 도구를 쓴다', async () => {
    start();
    const p = askScript([A.bob]);
    ctx.agents.setProvider(p);
    say(alice, R.team, '금요일 회고 14시 반으로 당길까?');
    await ctx.agents.drain();
    const names = (i: TurnInput) => i.tools.map((t) => t.name);
    const answerTurn = p.inputs.find((i) => i.trigger.reason === 'a2a_ask')!;
    expect(names(answerTurn)).toEqual(['say', 'pass']); // 질문자가 Room Agent면 의견만(request_approval 없음)
    expect(answerTurn.a2a).toMatchObject({ role: 'answer', askerId: RA.team });
    const collect = p.inputs.find((i) => i.trigger.reason === 'a2a_collect')!;
    expect(names(collect)).toContain('propose_edit');
    expect(collect.a2a).toMatchObject({ role: 'collect', answers: [{ agentId: A.bob, text: `${answerTurn.agent.name}의 답`, approvalPending: false }] });
  });

  it('시드 인물(엄마)의 답 턴에는 request_approval도 없다', async () => {
    start();
    const p = askScript([A.mom]);
    ctx.agents.setProvider(p);
    say(alice, R.family, '토요일 점심 12시 반 어때?');
    await ctx.agents.drain();
    const answerTurn = p.inputs.find((i) => i.trigger.reason === 'a2a_ask')!;
    expect(answerTurn.tools.map((t) => t.name)).toEqual(['say', 'pass']);
  });

  it('시드 인물(아빠)의 답 턴에도 request_approval이 없다', async () => {
    start();
    const p = askScript([A.dad]);
    ctx.agents.setProvider(p);
    say(alice, R.family, '토요일 점심 12시 반 어때?');
    await ctx.agents.drain();
    const answerTurn = p.inputs.find((i) => i.trigger.reason === 'a2a_ask')!;
    expect(answerTurn.agent.id).toBe(A.dad);
    expect(answerTurn.tools.map((t) => t.name)).toEqual(['say', 'pass']);
  });

  it('답은 아무도 깨우지 않는다: Room Agent의 추가 room_agent_call·auto_reply가 생기지 않는다', async () => {
    start();
    ctx.agents.setProvider(askScript([A.bob, A.dana]));
    say(alice, R.team, '금요일 회고 14시 반으로 당길까?');
    await ctx.agents.drain();
    const t = turns(R.team);
    expect(t.filter((x) => x.reason === 'room_agent_call')).toHaveLength(1);
    expect(t.filter((x) => x.reason === 'auto_reply')).toHaveLength(0);
    expect(t.filter((x) => x.reason === 'agent_chain')).toHaveLength(0);
    expect(ctx.agents.scheduler.chainCount(R.team)).toBe(0); // a2a 턴은 chainCount를 건드리지 않는다
  });

  it('큐의 auto_reply job이 a2a_ask로 제자리 교체된다: Agent마다 턴 1개, 큐 위치 유지', async () => {
    start();
    ctx.agents.setProvider(askScript([A.bob, A.dana]));
    say(alice, R.team, '금요일 회고 14시 반으로 당길까?');
    await ctx.agents.drain();
    const t = turns(R.team);
    expect(t.filter((x) => x.agentId === A.bob)).toHaveLength(1);
    expect(t.filter((x) => x.agentId === A.dana)).toHaveLength(1);
    expect(t.map((x) => x.agentId).indexOf(A.bob)).toBeLessThan(t.map((x) => x.agentId).indexOf(A.dana));
  });
});

describe('라운드·상한', () => {
  it('라운드(1)가 끝난 정리 턴에는 ask_agents가 없고, 강제로 호출해도 두 번째 질문이 생기지 않는다', async () => {
    start({ a2aMaxRounds: 1 });
    const p = scripted((i) => {
      if (i.trigger.reason === 'a2a_ask') return call('say', { text: '답' });
      if (i.trigger.reason === 'a2a_collect') return call('ask_agents', { agent_ids: [A.bob], question: '또 질문' }); // 허용 안 됨
      if (i.agent.kind === 'room_agent' && i.tools.some((t) => t.name === 'ask_agents')) return call('ask_agents', { agent_ids: [A.bob], question: '질문' });
      return call('pass', { reason: 'nothing_to_add' });
    });
    ctx.agents.setProvider(p);
    say(alice, R.team, '금요일 회고 14시 반으로 당길까?');
    await ctx.agents.drain();
    const collect = p.inputs.find((i) => i.trigger.reason === 'a2a_collect')!;
    expect(collect.tools.map((t) => t.name)).not.toContain('ask_agents');
    expect(msgs(R.team).filter((m) => m.recipients)).toHaveLength(1);
    const lastEnded = ctx.agents.outcomes.find((o) => o.turnId === turns(R.team).at(-1)!.turnId)!;
    expect(lastEnded).toMatchObject({ result: 'error', errorCode: 'tool_not_allowed' });
  });

  it('기본 라운드(2)에서는 정리 턴에서 한 번 더 물을 수 있다', async () => {
    start();
    const p = scripted((i) => {
      if (i.trigger.reason === 'a2a_ask') return call('say', { text: '답' });
      if (i.tools.some((t) => t.name === 'ask_agents')) return call('ask_agents', { agent_ids: [A.bob], question: `질문 ${msgs(R.team).filter((m) => m.recipients).length + 1}` });
      return call('say', { text: '정리' });
    });
    ctx.agents.setProvider(p);
    say(alice, R.team, '금요일 회고 14시 반으로 당길까?');
    await ctx.agents.drain();
    expect(msgs(R.team).filter((m) => m.recipients)).toHaveLength(2);
    expect(turns(R.team).filter((x) => x.reason === 'a2a_collect')).toHaveLength(2);
  });

  it('에피소드 하드캡을 넘으면 agent_paused(chain_limit), 사람 발언 뒤에는 리셋된다', async () => {
    start({ a2aMaxTurnsPerEpisode: 2 });
    ctx.agents.setProvider(askScript([A.bob, A.dana]));
    say(alice, R.team, '금요일 회고 14시 반으로 당길까?');
    await ctx.agents.drain();
    // bob·dana 답(2턴)까지 허용, 정리 턴은 상한에 걸려 일시정지
    expect(turns(R.team).filter((x) => x.reason === 'a2a_ask')).toHaveLength(2);
    expect(turns(R.team).filter((x) => x.reason === 'a2a_collect')).toHaveLength(0);
    expect(all(R.team).filter((e) => e.type === 'agent_paused')).toMatchObject([{ agentId: RA.team, reason: 'chain_limit' }]);

    say(alice, R.team, '그럼 15시는 어때?');
    await ctx.agents.drain();
    // 리셋: 두 번째 에피소드에서도 답 턴 2개가 다시 돈다
    expect(turns(R.team).filter((x) => x.reason === 'a2a_ask')).toHaveLength(4);
    expect(all(R.team).filter((e) => e.type === 'agent_paused')).toHaveLength(2);
  });

  it('수신자의 소유자가 그 사이 접속하면 그 job은 버려지고 정산되어 정리 턴이 돈다', async () => {
    start();
    ctx.agents.setProvider(askScript([A.bob, A.dana]));
    // Room Agent의 질문 턴이 끝난 직후(다음 job이 시작되기 전) Bob이 접속한다
    ctx.agents.scheduler.onTurnEnded((o) => {
      if (o.agentId === RA.team && o.tool === 'ask_agents') enter(bob, R.team);
    });
    say(alice, R.team, '금요일 회고 14시 반으로 당길까?');
    await ctx.agents.drain();
    const t = turns(R.team);
    expect(t.filter((x) => x.reason === 'a2a_ask').map((x) => x.agentId)).toEqual([A.dana]);
    expect(t.filter((x) => x.reason === 'a2a_collect')).toHaveLength(1);
  });

  it('수신자가 모두 askable이 아니면 질문은 바로 정리 턴으로 이어진다', async () => {
    start();
    const p = askScript([A.bob]);
    ctx.agents.setProvider(p);
    // askable 계산 시점(도구 실행)에는 있지만, 스케줄러가 질문을 볼 때는 없도록 Bob을 질문 직후 입장시킨다. onAsk는 append 훅에서 동기로 돈다.
    // 여기서는 대신 recipients 전원이 빠진 질문 이벤트를 직접 만든다.
    enter(bob, R.team);
    const before = turns(R.team).length;
    dispatch(ctx, { kind: 'room_agent', roomAgentId: RA.team, turnId: 'turn_manual' }, { type: 'send_message', roomId: R.team, text: '질문', recipients: [A.bob] });
    await ctx.agents.drain();
    const t = turns(R.team).slice(before);
    expect(t.map((x) => x.reason)).toEqual(['a2a_collect']);
  });
});

describe('도구 노출 규칙', () => {
  it('ask_agents는 room_agent_call·addressed(Personal)·a2a_collect 턴에서만, 부재 구성원이 있을 때만 노출된다', async () => {
    start();
    const p = scripted(() => call('pass', { reason: 'nothing_to_add' }));
    ctx.agents.setProvider(p);
    // room_agent_call (가족: 엄마·아빠 부재)
    enter(alice, R.family);
    say(alice, R.family, '토요일 점심 어때?');
    await ctx.agents.drain();
    const hasAsk = (i: TurnInput) => i.tools.some((t) => t.name === 'ask_agents');
    expect(p.inputs.find((i) => i.trigger.reason === 'room_agent_call')).toSatisfy(hasAsk);
    // 같은 에피소드의 auto_reply 턴에는 없다
    expect(p.inputs.filter((i) => i.trigger.reason === 'auto_reply').some(hasAsk)).toBe(false);
    // 물어볼 수 있는 Agent 목록은 프롬프트에 실린다
    const ra = p.inputs.find((i) => i.trigger.reason === 'room_agent_call')!;
    expect(ra.askable.map((a) => a.id)).toEqual([A.mom, A.dad]);
    expect(ra.prompt).toContain(`[물어볼 수 있는 Agent]`);
    expect(ra.prompt).toContain(`=${A.mom}`);
    expect(ra.prompt).toContain(`=${A.dad}`);

    // addressed(Personal Agent): 친구들에서 Alice가 자기 Agent를 지정
    p.inputs.length = 0;
    enter(alice, R.friends);
    say(alice, R.friends, 'Bob Agent랑 7시 맞춰 줘', A.alice);
    await ctx.agents.drain();
    expect(p.inputs.find((i) => i.agent.id === A.alice && i.trigger.reason === 'addressed')).toSatisfy(hasAsk);
  });

  it('Bob이 접속 중이면 askable에서 빠지고, 물을 대상이 없으면 ask_agents가 없다', async () => {
    start();
    enter(alice, R.team);
    expect(askableAgents(ctx, R.friends, A.alice).map((a) => a.id)).toEqual([A.bob]);
    enter(bob, R.friends);
    expect(askableAgents(ctx, R.friends, A.alice)).toEqual([]);
    enter(bob, R.team);
    expect(askableAgents(ctx, R.team, RA.team).map((a) => a.id)).toEqual([A.dana]); // 팀: Alice·Bob 접속 중 → Dana만
    const p = scripted(() => call('pass', { reason: 'nothing_to_add' }));
    ctx.agents.setProvider(p);
    enter(alice, R.friends);
    say(alice, R.friends, 'Bob Agent랑 7시 맞춰 줘', A.alice);
    await ctx.agents.drain();
    expect(p.inputs.find((i) => i.agent.id === A.alice)!.tools.map((t) => t.name)).not.toContain('ask_agents');
  });

  it('위임 없이 명시적으로 Leave한 구성원은 askable이 아니고, 위임 Leave는 askable이다', () => {
    start();
    enter(bob, R.friends);
    dispatch(ctx, { kind: 'human', userId: bob }, { type: 'leave_room', roomId: R.friends });
    expect(askableAgents(ctx, R.friends, A.alice)).toEqual([]);
    dispatch(ctx, { kind: 'human', userId: bob }, { type: 'rejoin_room', roomId: R.friends });
    dispatch(ctx, { kind: 'human', userId: bob }, { type: 'leave_room', roomId: R.friends, mandate: { text: '대신 답해 줘', allowedActions: ['chat'] } });
    expect(askableAgents(ctx, R.friends, A.alice).map((a) => a.id)).toEqual([A.bob]);
  });

  it('My Room과 방문 중에는 ask_agents가 노출되지 않는다', async () => {
    start();
    const p = scripted(() => call('pass', { reason: 'nothing_to_add' }));
    ctx.agents.setProvider(p);
    enter(alice, R.myAlice);
    say(alice, R.myAlice, '안녕', A.alice);
    await ctx.agents.drain();
    const v = sendAgentVisit(ctx, bob, R.myAlice, { text: '인사만', allowedActions: ['chat', 'comment'] });
    acceptVisit(ctx, alice, v.visitId, ['chat', 'comment']);
    await ctx.agents.drain();
    expect(p.inputs.length).toBeGreaterThanOrEqual(2);
    for (const i of p.inputs) expect(i.tools.map((t) => t.name)).not.toContain('ask_agents');
  });

  it('AGENT_A2A=off면 ask_agents가 노출되지 않고, 질문이 와도 아무도 깨우지 않는다', async () => {
    start({ agentA2A: false });
    const p = askScript([A.bob]);
    ctx.agents.setProvider(p);
    say(alice, R.team, '금요일 회고 14시 반으로 당길까?');
    await ctx.agents.drain();
    expect(p.inputs.every((i) => !i.tools.some((t) => t.name === 'ask_agents'))).toBe(true);
    expect(turns(R.team).some((x) => x.reason === 'a2a_ask' || x.reason === 'a2a_collect')).toBe(false);
  });
});

describe('입력 검증', () => {
  it('사람이 recipients·replyTo를 보내면 403 agent_only_field', () => {
    start();
    expect(() =>
      dispatch(ctx, { kind: 'human', userId: alice }, { type: 'send_message', roomId: R.team, text: 'x', recipients: [A.bob] }),
    ).toThrowError(expect.objectContaining({ status: 403, code: 'agent_only_field' }));
    expect(() =>
      dispatch(ctx, { kind: 'human', userId: alice }, { type: 'send_message', roomId: R.team, text: 'x', replyTo: 1 }),
    ).toThrowError(expect.objectContaining({ status: 403, code: 'agent_only_field' }));
  });

  it('REST로도 recipients·replyTo는 403', async () => {
    const { ctx: c, app } = await makeApp();
    ctx = c;
    const token = await loginAs(app, 'Alice');
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${R.team}/messages`,
      headers: auth(token),
      payload: { text: 'x', clientId: 'c1', recipients: [A.bob] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'agent_only_field' });
    await app.close();
  });

  it('askable에 없는 id를 물으면 400 not_askable(턴 error), 질문은 만들어지지 않는다', async () => {
    start();
    const p = scripted((i) =>
      i.agent.kind === 'room_agent' && i.tools.some((t) => t.name === 'ask_agents')
        ? call('ask_agents', { agent_ids: [A.alice], question: '질문' }) // 질문자 방 구성원이지만 접속 중인 Alice의 Agent
        : call('pass', { reason: 'nothing_to_add' }),
    );
    ctx.agents.setProvider(p);
    enter(alice, R.team);
    say(alice, R.team, '금요일 회고 14시 반으로 당길까?');
    await ctx.agents.drain();
    const o = ctx.agents.outcomes.find((x) => x.agentId === RA.team)!;
    expect(o).toMatchObject({ result: 'error', errorCode: 'not_askable' });
    expect(msgs(R.team).filter((m) => m.recipients)).toHaveLength(0);
  });

  it('recipients는 존재하는 Agent 1~3명, 중복 없음 / replyTo는 이 Room의 seq', () => {
    start();
    const ra = { kind: 'room_agent', roomAgentId: RA.team, turnId: 't1' } as const;
    const send = (extra: object) => dispatch(ctx, ra, { type: 'send_message', roomId: R.team, text: 'q', ...extra } as never);
    expect(() => send({ recipients: [] })).toThrowError(expect.objectContaining({ code: 'invalid_recipients' }));
    expect(() => send({ recipients: [A.bob, A.bob] })).toThrowError(expect.objectContaining({ code: 'invalid_recipients' }));
    expect(() => send({ recipients: ['nobody'] })).toThrowError(expect.objectContaining({ code: 'unknown_recipient' }));
    expect(() => send({ replyTo: 99999 })).toThrowError(expect.objectContaining({ code: 'invalid_reply_to' }));
    expect(() => send({ replyTo: 1 })).not.toThrow();
  });
});

describe('A1+: 재조율·전체 턴 상한·확정 에피소드 상한·병렬 답', () => {
  const vote = (userId: string, roomId: string, approvalId: string, option?: string) =>
    dispatch(ctx, { kind: 'human', userId }, { type: 'vote_approval', roomId, approvalId, decision: 'approve', ...(option ? { option } : {}) });
  const approvalsOf = (roomId: string) =>
    all(roomId).filter((e): e is Extract<RoomEvent, { type: 'approval_requested' }> => e.type === 'approval_requested');

  it('역제안 답이 오면 정리 턴이 한 번 더 묻고, 두 번째 정리 턴에는 ask_agents가 없어 propose_edit로 끝난다', async () => {
    start();
    const p = scripted((i) => {
      if (i.trigger.reason === 'a2a_ask') return call('say', { text: '그 시간은 어렵고 15시 반이면 좋아요' });
      if (i.trigger.reason === 'a2a_collect') {
        if (i.tools.some((t) => t.name === 'ask_agents')) return call('ask_agents', { agent_ids: [A.bob, A.dana], question: '15시 반으로 다시 맞춰 보려는데 괜찮을까요?' });
        return call('propose_edit', { title: '회고 15시 반', body: '금요일 15시 반', room_message: '정리했어요.' });
      }
      if (i.agent.kind === 'room_agent' && i.tools.some((t) => t.name === 'ask_agents')) return call('ask_agents', { agent_ids: [A.bob, A.dana], question: '14시 반 괜찮을까요?' });
      return call('pass', { reason: 'nothing_to_add' });
    });
    ctx.agents.setProvider(p);
    enter(alice, R.team);
    say(alice, R.team, '금요일 회고 14시 반으로 당길까?');
    await ctx.agents.drain();
    expect(msgs(R.team).filter((m) => m.recipients)).toHaveLength(2);
    const collects = p.inputs.filter((i) => i.trigger.reason === 'a2a_collect');
    expect(collects).toHaveLength(2);
    expect(collects[0]!.tools.map((t) => t.name)).toContain('ask_agents');
    expect(collects[1]!.tools.map((t) => t.name)).not.toContain('ask_agents');
    expect(approvalsOf(R.team).at(-1)).toMatchObject({ kind: 'edit', actorId: RA.team });
    expect(p.inputs).toHaveLength(7); // Room Agent 1, 답 2, 정리 겸 재질문 1, 답 2, 정리 1
  });

  it('maxTurnsPerHumanEvent: 사람 메시지 1건당 전체 턴이 상한을 넘으면 agent_paused(chain_limit), 다음 사람 발언에서 리셋', async () => {
    start({ a2aMaxTurnsPerHumanEvent: 3 });
    ctx.agents.setProvider(askScript([A.bob, A.dana]));
    say(alice, R.team, '금요일 회고 14시 반으로 당길까?');
    await ctx.agents.drain();
    // Room Agent 1 + 답 2 = 3턴. a2a_collect(정리)는 전체 상한에서 면제라 4번째로 실행된다
    expect(turns(R.team)).toHaveLength(4);
    expect(turns(R.team).filter((x) => x.reason === 'a2a_collect')).toHaveLength(1);
    expect(all(R.team).filter((e) => e.type === 'agent_paused')).toHaveLength(0);
    say(alice, R.team, '그럼 15시는 어때?');
    await ctx.agents.drain();
    expect(turns(R.team)).toHaveLength(8);
    expect(all(R.team).filter((e) => e.type === 'agent_paused')).toHaveLength(0);
  });

  it('maxTurnsPerResolution: 승인 1건당 카운터가 새로 시작되어 대화 없이 4건을 연달아 처리해도 마무리 턴이 pause되지 않는다', async () => {
    start();
    const p = scripted((i) => {
      if (i.trigger.reason === 'approval_resolved' || (i.trigger.reason === 'room_agent_call' && i.agent.kind === 'room_agent')) {
        return call('request_approval', { question: '다음은요?', options: ['가', '나'] });
      }
      return call('pass', { reason: 'nothing_to_add' });
    });
    ctx.agents.setProvider(p);
    enter(alice, R.team);
    say(alice, R.team, '정해 보자');
    await ctx.agents.drain();
    for (let n = 0; n < 4; n++) {
      const open = approvalsOf(R.team).at(-1)!;
      vote(alice, R.team, open.approvalId, '가');
      await ctx.agents.drain();
    }
    expect(turns(R.team).filter((x) => x.reason === 'approval_resolved')).toHaveLength(4);
    expect(all(R.team).filter((e) => e.type === 'agent_paused')).toHaveLength(0);
  });

  it('병렬 답 턴: 첫 수신자가 더 늦게 끝나도 기록 순서는 수신자 순서다', async () => {
    start();
    const base = askScript([A.bob, A.dana]);
    ctx.agents.setProvider({
      name: 'slow-bob',
      async *stream(input, signal) {
        if (input.trigger.reason === 'a2a_ask' && input.agent.id === A.bob) await new Promise((r) => setTimeout(r, 40));
        yield* base.stream(input, signal);
      },
    });
    say(alice, R.team, '금요일 회고 14시 반으로 당길까?');
    await ctx.agents.drain();
    const answers = msgs(R.team).filter((m) => m.replyTo !== undefined && m.actorId !== RA.team);
    expect(answers.map((m) => m.actorId)).toEqual([A.bob, A.dana]);
    expect(turns(R.team).filter((x) => x.reason === 'a2a_ask').map((x) => x.agentId)).toEqual([A.bob, A.dana]);
    expect(turns(R.team).filter((x) => x.reason === 'a2a_collect')).toHaveLength(1);
  });

  it('병렬 답 중 하나가 error여도 정리 턴은 정확히 1회 돈다', async () => {
    start();
    const base = askScript([A.bob, A.dana]);
    ctx.agents.setProvider({
      name: 'bob-fails',
      async *stream(input, signal) {
        if (input.trigger.reason === 'a2a_ask' && input.agent.id === A.bob) throw new Error('boom');
        yield* base.stream(input, signal);
      },
    });
    const orig = console.error;
    console.error = () => {};
    try {
      say(alice, R.team, '금요일 회고 14시 반으로 당길까?');
      await ctx.agents.drain();
    } finally {
      console.error = orig;
    }
    expect(turns(R.team).filter((x) => x.reason === 'a2a_collect')).toHaveLength(1);
    expect(ctx.agents.outcomes.find((o) => o.agentId === A.bob)).toMatchObject({ result: 'error' });
  });
});

describe('A1: 마무리 턴', () => {
  const proposeThenVote = async (closingCall: ToolCall) => {
    start();
    const p = scripted((i) => {
      if (i.trigger.reason === 'approval_resolved') return closingCall;
      if (i.agent.kind === 'room_agent' && i.trigger.reason === 'room_agent_call') return call('propose_edit', { title: '새 카드', body: '본문' });
      return call('pass', { reason: 'nothing_to_add' });
    });
    ctx.agents.setProvider(p);
    enter(alice, R.team);
    say(alice, R.team, '정해 보자');
    await ctx.agents.drain();
    const req = all(R.team).filter((e): e is Extract<RoomEvent, { type: 'approval_requested' }> => e.type === 'approval_requested').at(-1)!;
    dispatch(ctx, { kind: 'human', userId: alice }, { type: 'vote_approval', roomId: R.team, approvalId: req.approvalId, decision: 'approve' });
    await ctx.agents.drain();
    return p;
  };

  it('마무리(closing) 턴은 say/pass만 허용되고, 그 say는 아무도 깨우지 않는다', async () => {
    const p = await proposeThenVote(call('say', { text: '확정됐어요' }));
    const closing = p.inputs.find((i) => i.trigger.reason === 'approval_resolved')!;
    expect(closing.tools.map((t) => t.name)).toEqual(['say', 'pass']);
    expect(closing.prompt).toContain('확정 단계');
    const after = turns(R.team).filter((x) => x.reason !== 'auto_reply').map((x) => x.reason);
    expect(after).toEqual(['room_agent_call', 'approval_resolved']); // 마무리 say는 새 턴을 만들지 않는다
    expect(turns(R.team).at(-1)!.reason).toBe('approval_resolved');
    expect(msgs(R.team).at(-1)).toMatchObject({ actorId: RA.team, text: '확정됐어요' });
  });

  it('마무리 턴에서 request_approval을 강제로 호출하면 tool_not_allowed', async () => {
    await proposeThenVote(call('request_approval', { question: '또?', options: ['가', '나'] }));
    expect(ctx.agents.outcomes.at(-1)).toMatchObject({ result: 'error', errorCode: 'tool_not_allowed' });
  });
});
