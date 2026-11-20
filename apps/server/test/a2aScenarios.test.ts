import { afterEach, describe, expect, it } from 'vitest';
import { indexInteractions, type RoomEvent } from '@ensemble/shared';
import { decide } from '../src/agent/mock';
import { COORD_RE, SLOT_RE } from '../src/agent/mockA2A';
import { LADDER_RE, SETTLE_RE, TRIP_RE } from '../src/agent/mockBoardTools';
import type { AgentProvider, TurnInput } from '../src/agent/types';
import { MockProvider } from '../src/agent/mock';
import type { AppContext } from '../src/context';
import { dispatch } from '../src/domain/actions';
import { SEED, makeCtx } from './helpers';

const { alice, bob } = SEED.users;
const A = SEED.agents;
const R = SEED.rooms;
const RA = SEED.roomAgents;

let ctx: AppContext;
let llmCalls: TurnInput[] = [];
const start = () => {
  ctx = makeCtx();
  ctx.agents.start();
  llmCalls = [];
  const mock = new MockProvider();
  const counting: AgentProvider = { name: 'counting', stream: (input, signal) => (llmCalls.push(input), mock.stream(input, signal)) };
  ctx.agents.setProvider(counting);
  return ctx;
};
afterEach(() => ctx?.agents.stop());

const say = (userId: string, roomId: string, text: string, to?: string) =>
  dispatch(ctx, { kind: 'human', userId }, { type: 'send_message', roomId, text, to });
const enter = (userId: string, roomId: string) => dispatch(ctx, { kind: 'human', userId }, { type: 'enter_room', roomId });
const vote = (userId: string, roomId: string, approvalId: string, option?: string) =>
  dispatch(ctx, { kind: 'human', userId }, { type: 'vote_approval', roomId, approvalId, decision: 'approve', ...(option ? { option } : {}) });
const all = (roomId: string) => ctx.store.listAll(roomId);
type Msg = Extract<RoomEvent, { type: 'message' }>;
type Req = Extract<RoomEvent, { type: 'approval_requested' }>;

/** 데모 대본용 이벤트 순서: [종류, 행위자, 세부] */
function flow(roomId: string, afterSeq = 0): string[] {
  const out: string[] = [];
  for (const e of all(roomId).filter((x) => x.seq > afterSeq)) {
    if (e.type === 'message') {
      const tag = e.recipients ? `ask→${e.recipients.join(',')}` : e.replyTo ? `reply#${e.replyTo}${e.to ? `→${e.to}` : ''}` : e.to ? `say→${e.to}` : 'say';
      out.push(`message ${e.actorId} ${tag}`);
    } else if (e.type === 'agent_turn_started') out.push(`turn ${e.agentId} ${e.trigger.reason}`);
    else if (e.type === 'approval_requested') out.push(`approval ${e.actorId} ${e.kind} →${e.approvers.join(',')}`);
    else if (e.type === 'approval_resolved') out.push(`resolved ${e.outcome}`);
    else if (e.type === 'card_updated') out.push(`card_updated ${e.cardId}`);
  }
  return out;
}

const lastSeq = (roomId: string) => ctx.store.lastSeq(roomId);
const approvals = (roomId: string) => all(roomId).filter((e): e is Req => e.type === 'approval_requested');
const card = (roomId: string, cardId: string) => ctx.repo.getCard(roomId, cardId)!;

describe('시나리오 1: 우리 가족 (Room Agent가 엄마·아빠 Agent 둘에게 묻고 Alice가 승인)', () => {
  const TRIGGER = '토요일 점심 12시 반 어때? 메뉴도 정하자';

  it('질문 → 답 → 점심 카드 propose_edit → Alice 승인 → 카드 반영, LLM 4회', async () => {
    start();
    enter(alice, R.family);
    const base = lastSeq(R.family);
    say(alice, R.family, TRIGGER);
    await ctx.agents.drain();

    expect(flow(R.family, base)).toEqual([
      `message ${alice} say`,
      `turn ${RA.family} room_agent_call`,
      `message ${RA.family} ask→${A.mom},${A.dad}`,
      `turn ${A.mom} a2a_ask`,
      expect.stringMatching(new RegExp(`^message ${A.mom} reply#\\d+→${RA.family}$`)),
      `turn ${A.dad} a2a_ask`,
      expect.stringMatching(new RegExp(`^message ${A.dad} reply#\\d+→${RA.family}$`)),
      `turn ${RA.family} a2a_collect`,
      `approval ${RA.family} edit →${alice}`,
    ]);
    expect(llmCalls).toHaveLength(4);

    const msgs = all(R.family).filter((e): e is Msg => e.type === 'message' && e.seq > base);
    const ask = msgs.find((m) => m.recipients)!;
    expect(ask.text).toContain('엄마의 Agent님');
    expect(ask.text).toContain('아빠의 Agent님');
    expect(ask.text).toContain('토요일 12시 반');
    const answer = msgs.find((m) => m.replyTo === ask.seq)!;
    expect(answer).toMatchObject({ actorId: A.mom, to: RA.family, text: '토요일 12시 반이면 좋다. 장은 오전에 내가 보고, 백숙 해 줄게.', memoryRefs: ['mem_seed_mom_for_family'] });
    const dadAnswer = msgs.filter((m) => m.replyTo === ask.seq).find((m) => m.actorId === A.dad)!;
    expect(dadAnswer).toMatchObject({ to: RA.family, text: '12시 반이면 좋아요. 등산 다녀와서 고기는 내가 구울게요.', memoryRefs: ['mem_seed_dad_for_family'] });

    const req = approvals(R.family).at(-1)!;
    expect(req.proposal).toMatchObject({ cardId: 'c_seed_family_lunch', body: '토요일 12시 반, 집에서 점심. 메뉴는 백숙(엄마가 준비)과 구이(아빠가 담당).' });
    expect(req.publicRationale).toContain('엄마의 Agent');

    vote(alice, R.family, req.approvalId);
    expect(card(R.family, 'c_seed_family_lunch').body).toBe('토요일 12시 반, 집에서 점심. 메뉴는 백숙(엄마가 준비)과 구이(아빠가 담당).');

    // 분류가 서버의 이벤트와 맞는다 (shared indexInteractions)
    const ix = indexInteractions(all(R.family), { isAgentId: (id) => id === RA.family || (Object.values(A) as string[]).includes(id) });
    expect(ix.list.map((i) => i.kind)).toEqual(['a2a_ask', 'a2a_answer', 'a2a_answer', 'a2h_approval']);
    expect(ix.threads.get(ask.seq)).toMatchObject({ open: false });
    expect(ix.list[3]).toMatchObject({ threadSeq: ask.seq, toIds: [alice] });
  });

  it('가족 질문은 fan-out 2(엄마·아빠), 사람 메시지당 LLM 호출은 5회 이하', async () => {
    start();
    enter(alice, R.family);
    const base = lastSeq(R.family);
    say(alice, R.family, TRIGGER);
    await ctx.agents.drain();
    const ask = all(R.family).find((e): e is Msg => e.type === 'message' && e.seq > base && !!e.recipients)!;
    expect(ask.recipients).toEqual([A.mom, A.dad]);
    expect(llmCalls.length).toBeLessThanOrEqual(5);
    const dad = llmCalls.find((i) => i.agent.id === A.dad && i.trigger.reason === 'a2a_ask')!;
    expect(dad.tools.map((t) => t.name)).not.toContain('request_approval');
  });

  it('엄마 Agent의 auto_reply는 질문 턴으로 대체되어 사람에게 따로 답하지 않는다', async () => {
    start();
    enter(alice, R.family);
    say(alice, R.family, TRIGGER);
    await ctx.agents.drain();
    const turns = all(R.family).filter((e) => e.type === 'agent_turn_started' && e.agentId === A.mom);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ trigger: { reason: 'a2a_ask' } });
  });
});

describe('시드 소유자(엄마·Dana) Agent의 답 턴', () => {
  it('a2a_ask 턴 도구에 request_approval이 없고, 엄마 승인 없이 propose_edit까지 도달한다', async () => {
    start();
    enter(alice, R.family);
    say(alice, R.family, '토요일 점심 12시 반 어때? 메뉴도 정하자');
    await ctx.agents.drain();
    const mom = llmCalls.find((i) => i.agent.id === A.mom && i.trigger.reason === 'a2a_ask')!;
    expect(mom.tools.map((t) => t.name)).not.toContain('request_approval');
    expect(approvals(R.family).every((r) => r.actorId !== A.mom)).toBe(true);
    expect(approvals(R.family).at(-1)).toMatchObject({ actorId: RA.family });

    start();
    enter(alice, R.team);
    say(alice, R.team, '금요일 회고 30분 당겨서 14시 반에 할 수 있을까?');
    await ctx.agents.drain();
    const dana = llmCalls.find((i) => i.agent.id === A.dana && i.trigger.reason === 'a2a_ask')!;
    expect(dana.tools.map((t) => t.name)).not.toContain('request_approval');
  });
});

describe('시나리오 2: 팀 (Room Agent가 Bob·Dana Agent에게 묻고 Alice·Bob이 승인)', () => {
  const TRIGGER = '금요일 회고 30분 당겨서 14시 반에 할 수 있을까?';

  it('질문 ×2 → 답 ×2 → 회고 카드 propose_edit(승인자 Alice·Bob) → 투표 → 카드 반영, LLM 4회', async () => {
    start();
    enter(alice, R.team);
    const base = lastSeq(R.team);
    say(alice, R.team, TRIGGER);
    await ctx.agents.drain();

    expect(flow(R.team, base)).toEqual([
      `message ${alice} say`,
      `turn ${RA.team} room_agent_call`,
      `message ${RA.team} ask→${A.bob},${A.dana}`,
      `turn ${A.bob} a2a_ask`,
      expect.stringMatching(new RegExp(`^message ${A.bob} reply#\\d+→${RA.team}$`)),
      `turn ${A.dana} a2a_ask`,
      expect.stringMatching(new RegExp(`^message ${A.dana} reply#\\d+→${RA.team}$`)),
      `turn ${RA.team} a2a_collect`,
      `approval ${RA.team} edit →${alice},${bob}`,
    ]);
    expect(llmCalls).toHaveLength(4);

    const msgs = all(R.team).filter((e): e is Msg => e.type === 'message' && e.seq > base);
    const ask = msgs.find((m) => m.recipients)!;
    expect(ask.text).toBe('Bob의 Agent님, Dana의 Agent님, 회고를 금요일 14시 반으로 30분 당기려 해요. 일정 괜찮을까요?');
    expect(msgs.find((m) => m.actorId === A.bob && m.replyTo)).toMatchObject({
      text: '오히려 좋아요 ㅋㅋ 16시에 고객 미팅이 있어서 14시 반 시작이면 여유 있어요.',
      memoryRefs: ['mem_seed_bob_for_team'],
    });
    expect(msgs.find((m) => m.actorId === A.dana && m.replyTo)).toMatchObject({ text: '14시 반이면 괜찮아요. 대신 30분 안에 끝내요.' });

    const req = approvals(R.team).at(-1)!;
    expect(req.proposal).toMatchObject({ cardId: 'c_seed_team_retro', body: '금요일 14시 반, 30분. 잘한 점 / 아쉬운 점 / 다음 액션.' });
    expect(req.publicRationale).toContain('Bob의 Agent');
    expect(req.publicRationale).toContain('Dana의 Agent');

    vote(alice, R.team, req.approvalId);
    expect(card(R.team, 'c_seed_team_retro').body).toBe('금요일 15시, 30분. 잘한 점 / 아쉬운 점 / 다음 액션.'); // 한 명 승인만으로는 반영되지 않는다
    vote(bob, R.team, req.approvalId);
    expect(card(R.team, 'c_seed_team_retro').body).toBe('금요일 14시 반, 30분. 잘한 점 / 아쉬운 점 / 다음 액션.');
  });

  it('Bob이 방 안에 있으면 Bob의 Agent는 빠지고 Dana에게만 묻는다 (LLM 3회)', async () => {
    start();
    enter(alice, R.team);
    enter(bob, R.team);
    const base = lastSeq(R.team);
    say(alice, R.team, TRIGGER);
    await ctx.agents.drain();
    const ask = all(R.team).find((e): e is Msg => e.type === 'message' && e.seq > base && !!e.recipients)!;
    expect(ask.recipients).toEqual([A.dana]);
    expect(all(R.team).filter((e) => e.type === 'agent_turn_started' && e.seq > base && e.agentId === A.bob)).toHaveLength(0);
    expect(llmCalls).toHaveLength(3);
    expect(approvals(R.team).at(-1)!.proposal!.body).toBe('금요일 14시 반, 30분. 잘한 점 / 아쉬운 점 / 다음 액션.');
  });
});

describe('시나리오 3: 친구들 (Alice Agent ↔ Bob Agent, Bob·Alice가 각자 승인)', () => {
  const TRIGGER = 'Bob Agent랑 토요일 저녁 7시 영화 괜찮은지 맞춰 줘';

  it('질문 → Bob Agent가 Bob에게 승인 요청 → Alice에게 보고 → Bob 승인 → 영화 카드 propose_edit → Alice 승인, LLM 4회', async () => {
    start();
    enter(alice, R.friends);
    const base = lastSeq(R.friends);
    say(alice, R.friends, TRIGGER, A.alice);
    await ctx.agents.drain();

    expect(flow(R.friends, base)).toEqual([
      `message ${alice} say→${A.alice}`,
      `turn ${A.alice} addressed`,
      `message ${A.alice} ask→${A.bob}`,
      `turn ${A.bob} a2a_ask`,
      `approval ${A.bob} decision →${bob}`,
      expect.stringMatching(new RegExp(`^message ${A.bob} reply#\\d+→${A.alice}$`)),
      `turn ${A.alice} a2a_collect`,
      expect.stringMatching(new RegExp(`^message ${A.alice} reply#\\d+→${alice}$`)),
    ]);
    expect(llmCalls).toHaveLength(3); // 승인 전까지

    const msgs = all(R.friends).filter((e): e is Msg => e.type === 'message' && e.seq > base);
    const ask = msgs.find((m) => m.recipients)!;
    expect(ask.text).toBe('Bob의 Agent님, Alice가 토요일 저녁 7시 영화를 제안해요. Bob도 괜찮을까요?');
    const report = msgs.at(-1)!;
    expect(report.text).toContain('Alice님');
    expect(report.text).toContain('시간은 Bob이 직접 확인 중이에요');

    const dec = approvals(R.friends).at(-1)!;
    expect(dec).toMatchObject({ kind: 'decision', approvers: [bob], options: ['토요일 저녁 7시 좋아요', '다른 시간으로'] });
    expect(dec.summary).toBe('Alice의 Agent가 토요일 저녁 7시 영화를 제안했어요. 이대로 할까요?');

    vote(bob, R.friends, dec.approvalId, '토요일 저녁 7시 좋아요');
    await ctx.agents.drain();
    expect(llmCalls).toHaveLength(4);
    const edit = approvals(R.friends).at(-1)!;
    expect(edit).toMatchObject({ kind: 'edit', approvers: [alice], actorId: A.bob });
    expect(edit.proposal).toMatchObject({ cardId: 'c_seed_friends_movie', body: '토요일 저녁 7시, 영화 + 저녁 식사. 장소는 아직 미정.' });
    expect(edit.publicRationale).toBe('Bob 승인: 토요일 저녁 7시 좋아요');

    vote(alice, R.friends, edit.approvalId);
    expect(card(R.friends, 'c_seed_friends_movie').body).toBe('토요일 저녁 7시, 영화 + 저녁 식사. 장소는 아직 미정.');

    const ix = indexInteractions(all(R.friends), { isAgentId: (id) => (Object.values(A) as string[]).includes(id) || id === RA.friends });
    const kinds = ix.list.filter((i) => i.seq > base).map((i) => i.kind);
    expect(kinds).toEqual(['h2a_direct', 'a2a_ask', 'a2h_approval', 'a2a_answer', 'a2h_report', 'a2h_approval']);
    expect(ix.list.find((i) => i.kind === 'a2h_approval')).toMatchObject({ threadSeq: ask.seq, toIds: [bob] });
  });

  it('Bob이 방 안에 있으면 Alice의 Agent는 질문하지 않고 Bob에게 직접 말한다(규칙 대체)', async () => {
    start();
    enter(alice, R.friends);
    enter(bob, R.friends);
    const base = lastSeq(R.friends);
    say(alice, R.friends, TRIGGER, A.alice);
    await ctx.agents.drain();
    expect(all(R.friends).filter((e) => e.type === 'message' && e.seq > base && 'recipients' in e && e.recipients)).toHaveLength(0);
    expect(all(R.friends).filter((e) => e.type === 'agent_turn_started' && e.agentId === A.bob)).toHaveLength(0);
    expect(llmCalls.some((i) => i.tools.some((t) => t.name === 'ask_agents'))).toBe(false);
  });
});

describe('mock 정규식: 보드 도구와의 겹침·분기 순서', () => {
  it('SLOT_RE·COORD_RE는 시나리오 문장을 읽고, 기존 Our Room 테스트 문장에는 맞지 않는다', () => {
    for (const t of ['토요일 점심 12시 반 어때? 메뉴도 정하자', '금요일 회고 30분 당겨서 14시 반에 할 수 있을까?', 'Bob Agent랑 토요일 저녁 7시 영화 괜찮은지 맞춰 줘']) {
      expect(SLOT_RE.test(t) && COORD_RE.test(t)).toBe(true);
      expect(LADDER_RE.test(t) || SETTLE_RE.test(t) || TRIP_RE.test(t)).toBe(false);
    }
    expect(SLOT_RE.exec('토요일 점심 12시 반 어때?')![0].trim()).toBe('토요일 점심 12시 반');
    expect(SLOT_RE.exec('금요일 회고 30분 당겨서 14시 반에 할 수 있을까?')![0]).toBe('14시 반');
    for (const t of ['안녕하세요', '토요일 점심 어때?', '엄마에게', '주말에 영화 보고 저녁도 같이 먹을까?', '정리해 줘']) expect(SLOT_RE.test(t)).toBe(false);
  });

  /** 팀 방에서 Alice가 말한다 (Bob·Dana는 부재) */
  function roomAgentInput(text: string, roomId = R.team): void {
    start();
    enter(alice, roomId);
    say(alice, roomId, text);
  }

  it('시각·조율 표현과 보드 도구 표현이 함께 있으면 Room Agent는 ask_agents가 아니라 보드 도구를 쓴다', async () => {
    roomAgentInput('금요일 회고 14시 반에 누가 커피 쏠지 사다리 타자, 괜찮지?');
    await ctx.agents.drain();
    const first = llmCalls.find((i) => i.agent.id === RA.team)!;
    expect(first.tools.some((t) => t.name === 'ask_agents')).toBe(true); // 질문 도구는 주어졌지만
    expect(decide(first).name).not.toBe('ask_agents'); // 보드 도구 표현이면 질문은 양보(보드 도구는 이미 있으면 기존 흐름이 처리)
    expect(all(R.team).some((e) => e.type === 'message' && !!e.recipients)).toBe(false);
  });

  it('조율 표현이 없거나 시각이 없으면 ask_agents를 호출하지 않는다', async () => {
    roomAgentInput('금요일 회고 14시 반으로 하자');
    await ctx.agents.drain();
    expect(all(R.team).some((e) => e.type === 'message' && !!e.recipients)).toBe(false);
  });

  it('사람이 직접 말하는 방 안 구성원(auto_reply)은 시각이 있어도 ask_agents를 받지 않는다', async () => {
    roomAgentInput('금요일 14시 반 어때?');
    await ctx.agents.drain();
    const autoTurns = llmCalls.filter((i) => i.trigger.reason === 'auto_reply');
    for (const i of autoTurns) expect(i.tools.some((t) => t.name === 'ask_agents')).toBe(false);
  });
});

describe('사람 메시지 1건당 LLM 호출 수', () => {
  it('세 시나리오 모두 5회 이하', async () => {
    const cases: [string, string, string?][] = [
      [R.family, '토요일 점심 12시 반 어때? 메뉴도 정하자'],
      [R.team, '금요일 회고 30분 당겨서 14시 반에 할 수 있을까?'],
      [R.friends, 'Bob Agent랑 토요일 저녁 7시 영화 괜찮은지 맞춰 줘', A.alice],
    ];
    for (const [room, text, to] of cases) {
      start();
      enter(alice, room);
      say(alice, room, text, to);
      await ctx.agents.drain();
      expect(llmCalls.length).toBeLessThanOrEqual(5);
      ctx.agents.stop();
    }
  });
});
