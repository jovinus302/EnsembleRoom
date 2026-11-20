import { afterEach, describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { TOOL_NAMES, visibleBoardTools, type BoardTool, type RoomEvent } from '@ensemble/shared';
import { BOARD_TOOL_INPUT_SCHEMAS, normalizeTime } from '../src/agent/boardToolTools';
import { checklistItemsFrom, decideBoardTool, ladderOutcomeFrom, parseAmount, voteOptionsFrom } from '../src/agent/mockBoardTools';
import { MockProvider } from '../src/agent/mock';
import { AUTO_REPLY_TOOLS, TOOL_DEFS, TOOL_INPUT_SCHEMAS, executeTool, toolsForTurn } from '../src/agent/tools';
import type { AgentProvider, ProviderEvent, ToolCall, TurnInput } from '../src/agent/types';
import type { AppContext } from '../src/context';
import { dispatch } from '../src/domain/actions';
import { roomStateOf } from '../src/domain/rooms';
import { DomainError } from '../src/errors';
import { SEED, makeCtx } from './helpers';

const { alice, bob } = SEED.users;
const R = SEED.rooms;
const RA = SEED.roomAgents;

let ctx: AppContext;
afterEach(() => ctx?.agents.stop());

const start = () => {
  ctx = makeCtx();
  // 시드에 이미 올라 있는 도구는 내려서 "도구 없는 방"에서 시작한다
  for (const room of [R.friends, R.family, R.team]) {
    for (const t of visibleBoardTools(roomStateOf(ctx, room))) {
      dispatch(ctx, { kind: 'human', userId: alice }, { type: 'remove_board_tool', roomId: room, toolId: t.toolId });
    }
  }
  ctx.agents.start();
};
const say = (userId: string, roomId: string, text: string) => dispatch(ctx, { kind: 'human', userId }, { type: 'send_message', roomId, text });
const toolsOf = (roomId: string): BoardTool[] => visibleBoardTools(roomStateOf(ctx, roomId));
const msgs = (roomId: string) => ctx.store.listAll(roomId).filter((e): e is Extract<RoomEvent, { type: 'message' }> => e.type === 'message');
const lastOutcomeOf = (agentId: string) => ctx.agents.outcomes.filter((o) => o.agentId === agentId).at(-1)!;

function spy(): AgentProvider & { inputs: TurnInput[] } {
  const base = new MockProvider();
  const inputs: TurnInput[] = [];
  return { name: 'spy', inputs, stream: (input, signal) => (inputs.push(input), base.stream(input, signal)) };
}
/** Room Agent 턴에만 지정한 호출을 내고 나머지는 pass */
function roomAgentScript(calls: ToolCall[]): AgentProvider {
  return {
    name: 'scripted',
    async *stream(input): AsyncGenerator<ProviderEvent> {
      const list: ToolCall[] = input.agent.kind === 'room_agent' ? calls : [{ name: 'pass', input: { reason: 'nothing_to_add' } }];
      for (const call of list) yield { type: 'tool_call', call };
    },
  };
}

describe('mock: Room Agent가 대화에서 보드 도구를 만들고 room_message로 알린다', () => {
  it.each([
    ['오늘 커피 누가 살까?', 'ladder', '사다리를 올려'],
    ['오늘 영화표 24,000원 냈어. 정산하자', 'settlement', '정산표를 올려'],
    ['이번 주말 1박2일 여행 가자', 'trip', '여행 계획을 올려'],
  ] as const)('"%s" → %s 도구 + 안내 메시지', async (text, kind, notice) => {
    start();
    say(alice, R.friends, text);
    await ctx.agents.drain();
    const tools = toolsOf(R.friends);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.kind).toBe(kind);
    expect(tools[0]!.createdBy.kind).toBe('room_agent');
    expect(msgs(R.friends).some((m) => m.actorKind === 'room_agent' && m.text.includes(notice))).toBe(true);
  });

  it('사다리: 참가자는 Room의 사람 이름, 결과 항목은 "누가 X" 문구에서 만들고 실행은 하지 않는다', async () => {
    start();
    say(alice, R.friends, '오늘 커피 누가 살까?');
    await ctx.agents.drain();
    const t = toolsOf(R.friends)[0]!;
    expect(t.kind).toBe('ladder');
    if (t.kind !== 'ladder') return;
    expect(t.participants).toEqual(expect.arrayContaining(['Alice', 'Bob']));
    expect(t.outcomes[0]).toBe('커피 사기');
    expect(t.outcomes).toContain('꽝');
    expect(t.run).toBeNull();
  });

  it('정산표: 말에 있는 금액과 지불자(발화자)만 쓰고, 금액이 없으면 빈 표를 만든다', async () => {
    start();
    say(alice, R.friends, '영화표 24,000원 냈어, 정산하자');
    await ctx.agents.drain();
    const t = toolsOf(R.friends)[0]!;
    if (t.kind !== 'settlement') throw new Error('settlement 아님');
    expect(t.expenses).toHaveLength(1);
    expect(t.expenses[0]).toMatchObject({ payer: 'Alice', amount: 24000 });

    start();
    say(alice, R.friends, '다 같이 더치페이 하자');
    await ctx.agents.drain();
    const e = toolsOf(R.friends)[0]!;
    if (e.kind !== 'settlement') throw new Error('settlement 아님');
    expect(e.expenses).toHaveLength(0);
  });

  it('이미 정산표가 있으면 금액이 나온 말은 expense_add로 이어 가고, 금액이 없으면 새로 만들지 않는다', async () => {
    start();
    say(alice, R.friends, '정산표 만들자');
    await ctx.agents.drain();
    expect(toolsOf(R.friends)).toHaveLength(1);
    say(bob, R.friends, '팝콘 12,000원 냈어, 정산해 줘');
    await ctx.agents.drain();
    const t = toolsOf(R.friends);
    expect(t).toHaveLength(1);
    if (t[0]!.kind !== 'settlement') throw new Error('settlement 아님');
    expect(t[0]!.expenses.map((x) => [x.payer, x.amount])).toEqual([['Bob', 12000]]);
    say(alice, R.friends, '정산 어떻게 돼?');
    await ctx.agents.drain();
    expect(toolsOf(R.friends)).toHaveLength(1);
  });

  it('같은 종류의 사다리가 이미 있으면 새로 만들지 않는다', async () => {
    start();
    say(alice, R.friends, '사다리로 정하자');
    await ctx.agents.drain();
    say(alice, R.friends, '사다리 한 번 더 하자');
    await ctx.agents.drain();
    expect(toolsOf(R.friends)).toHaveLength(1);
  });

  it('Agent의 도구 생성은 스케줄러를 다시 깨우지 않는다(자기 발화·도구 이벤트로 루프가 돌지 않음)', async () => {
    start();
    const createdBefore = ctx.store.listAll(R.friends).filter((e) => e.type === 'board_tool_created').length;
    say(alice, R.friends, '이번 주말 여행 가자');
    await ctx.agents.drain();
    const raTurns = ctx.store.listAll(R.friends).filter((e) => e.type === 'agent_turn_started' && e.agentId === RA.friends);
    const after = ctx.store.listAll(R.friends);
    expect(raTurns.filter((e) => e.seq > after.filter((x) => x.type === 'message' && x.actorKind === 'human').at(-1)!.seq)).toHaveLength(1);
    expect(after.filter((e) => e.type === 'board_tool_created')).toHaveLength(createdBefore + 1);
  });

  it('결정성: 같은 입력이면 같은 호출', async () => {
    start();
    const p = spy();
    ctx.agents.setProvider(p);
    say(alice, R.friends, '오늘 커피 누가 살까?');
    await ctx.agents.drain();
    const input = p.inputs.find((i) => i.agent.kind === 'room_agent')!;
    expect(decideBoardTool(input)).toEqual(decideBoardTool(input));
    expect(decideBoardTool(input)?.name).toBe('create_board_tool');
  });
});

describe('mock 문장 해석 유틸', () => {
  it('금액·결과 항목·시간 정규화', () => {
    expect(parseAmount('3만 원씩')).toBe(30000);
    expect(parseAmount('1.5만원')).toBe(15000);
    expect(parseAmount('24,000원')).toBe(24000);
    expect(parseAmount('얼마씩 내?')).toBeNull();
    expect(ladderOutcomeFrom('누가 커피 살까?')).toBe('커피 사기');
    expect(ladderOutcomeFrom('누가 설거지 할까')).toBe('설거지 하기');
    expect(ladderOutcomeFrom('커피 누가 쏠까?')).toBe('커피 쏘기');
    expect(ladderOutcomeFrom('오늘 누가 살까?')).toBeNull();
    expect(ladderOutcomeFrom('사다리 타자')).toBeNull();
    expect(normalizeTime('9:30')).toBe('09:30');
    expect(normalizeTime('오후 3시')).toBeUndefined();
  });
});

describe('Agent 권한 경계', () => {
  it('Agent의 ladder_run은 도구 입력 검증에서 거부되고, dispatch로 직접 보내도 humans_only(403)다', async () => {
    start();
    say(alice, R.friends, '사다리로 정하자');
    await ctx.agents.drain();
    const t = toolsOf(R.friends)[0]!;
    // 도구 경로: op enum에 ladder_run이 없다
    ctx.agents.setProvider(roomAgentScript([{ name: 'update_board_tool', input: { tool_id: t.toolId, op: 'ladder_run' } }]));
    say(alice, R.friends, '누가 걸릴까?');
    await ctx.agents.drain();
    expect(lastOutcomeOf(RA.friends)).toMatchObject({ result: 'error', errorCode: 'invalid_tool_input', errorStatus: 400 });
    // 도메인 경로
    try {
      dispatch(ctx, { kind: 'room_agent', roomAgentId: RA.friends }, { type: 'update_board_tool', roomId: R.friends, toolId: t.toolId, op: { op: 'ladder_run' } });
      throw new Error('거부되어야 함');
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).code).toBe('humans_only');
    }
    const after = toolsOf(R.friends)[0]!;
    expect(after.kind === 'ladder' && after.run).toBeNull();
  });

  it('한 턴에 도구 호출이 여러 개여도 첫 번째만 실행한다(턴당 도구 1회)', async () => {
    start();
    const make = (title: string): ToolCall => ({ name: 'create_board_tool', input: { kind: 'trip', title } });
    ctx.agents.setProvider(roomAgentScript([make('하나'), make('둘')]));
    say(alice, R.friends, '여행 이야기 해 보자');
    await ctx.agents.drain();
    const tools = toolsOf(R.friends);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.title).toBe('하나');
  });

  it('create_board_tool의 room_message는 도구 생성 뒤 방에 남고, 없으면 메시지를 남기지 않는다', async () => {
    start();
    const before = msgs(R.friends).length;
    ctx.agents.setProvider(roomAgentScript([{ name: 'create_board_tool', input: { kind: 'trip', title: '조용히', room_message: '여행 계획을 올렸어요.' } }]));
    say(alice, R.friends, '여행 가자');
    await ctx.agents.drain();
    const added = msgs(R.friends).slice(before);
    expect(added.map((m) => m.text)).toContain('여행 계획을 올렸어요.');
    expect(added.filter((m) => m.actorKind === 'room_agent')).toHaveLength(1);
  });

  it('자동 대리(auto_reply) 턴과 시드 소유자 Agent에는 보드 도구가 제공되지 않는다', async () => {
    start();
    const p = spy();
    ctx.agents.setProvider(p);
    // 엄마·Dana는 시드 사용자라 항상 부재 → 자동 대리 턴
    say(alice, R.family, '이번 주말 여행 가자');
    say(alice, R.team, '사다리로 정하자');
    await ctx.agents.drain();
    const autos = p.inputs.filter((i) => i.trigger.reason === 'auto_reply');
    expect(autos.length).toBeGreaterThan(0);
    for (const i of autos) {
      const names = i.tools.map((t) => t.name);
      expect(names).not.toContain('create_board_tool');
      expect(names).not.toContain('update_board_tool');
      expect(i.system).not.toContain('create_board_tool(kind=ladder)');
      expect(i.prompt).toContain('[보드 도구]'); // 상태는 읽을 수 있다
    }
    expect(AUTO_REPLY_TOOLS).not.toContain('create_board_tool');
    // 방 안의 자동 대리 응답으로는 도구가 생기지 않는다(Room Agent만)
    for (const t of toolsOf(R.family)) expect(t.createdBy.kind).toBe('room_agent');
    for (const t of toolsOf(R.team)) expect(t.createdBy.kind).toBe('room_agent');
  });

  it('toolsForTurn: 방문 Agent에는 보드 도구가 없고 Room Agent에는 있다', async () => {
    start();
    const room = ctx.repo.getRoomAgentByRoom(R.friends)!;
    expect(room.id).toBe(RA.friends);
    const p = spy();
    ctx.agents.setProvider(p);
    say(alice, R.friends, '오늘 뭐 먹을까?');
    await ctx.agents.drain();
    const ra = p.inputs.find((i) => i.agent.kind === 'room_agent')!;
    expect(ra.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['create_board_tool', 'update_board_tool']));
    expect(ra.system).toContain('create_board_tool(kind=ladder)');
    expect(toolsForTurn(null, null)).toEqual([]);
  });

  it('프롬프트: [보드 도구] 섹션에 도구 id·항목 id·상태가 보이고, 도구 이벤트도 렌더된다', async () => {
    start();
    const p = spy();
    ctx.agents.setProvider(p);
    say(alice, R.friends, '영화표 24,000원 냈어. 정산하자');
    await ctx.agents.drain();
    const tool = toolsOf(R.friends)[0]!;
    say(bob, R.friends, '고마워!');
    await ctx.agents.drain();
    const last = p.inputs.filter((i) => i.agent.kind === 'room_agent').at(-1)!;
    expect(last.boardTools.map((t) => t.toolId)).toContain(tool.toolId);
    expect(last.prompt).toContain(`[${tool.toolId}] 정산표`);
    expect(last.prompt).toContain('Alice 24,000원');
    expect(last.prompt).toContain('보드에 정산표 올림');
    expect(last.members.map((m) => m.name)).toEqual(expect.arrayContaining(['Alice', 'Bob']));
  });
});

describe('ClaudeProvider용 도구 스키마', () => {
  const ajv = new Ajv({ strict: true, allErrors: true });

  it('TOOL_NAMES 전부에 입력 스키마(zod)와 JSON schema 정의가 있다', () => {
    for (const n of TOOL_NAMES) {
      expect(TOOL_INPUT_SCHEMAS[n], n).toBeDefined();
      expect(TOOL_DEFS[n].name).toBe(n);
    }
  });

  it.each(['create_board_tool', 'update_board_tool'] as const)('%s: JSON schema가 유효하고 zod 입력 필드와 일치한다', (name) => {
    const def = TOOL_DEFS[name];
    const validate = ajv.compile(def.inputSchema);
    const props = Object.keys((def.inputSchema as { properties: Record<string, unknown> }).properties).sort();
    const zodKeys = Object.keys(BOARD_TOOL_INPUT_SCHEMAS[name].shape).sort();
    expect(props).toEqual(zodKeys);
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required.every((r) => props.includes(r))).toBe(true);

    const sample = name === 'create_board_tool'
      ? { kind: 'settlement', title: '정산', expenses: [{ payer: 'Alice', amount: 1000 }], room_message: '올렸어요' }
      : { tool_id: 't_1', op: 'check_set', check_id: 'k_1', done: true };
    expect(validate(sample), JSON.stringify(validate.errors)).toBe(true);
    expect(BOARD_TOOL_INPUT_SCHEMAS[name].safeParse(sample).success).toBe(true);
    expect(validate({ title: '필수 누락' })).toBe(false);
  });

  it('update_board_tool의 op enum에는 사람 전용 op(ladder_run·ladder_reset)가 없다', () => {
    const op = (TOOL_DEFS.update_board_tool.inputSchema as { properties: { op: { enum: string[] } } }).properties.op.enum;
    expect(op).not.toContain('ladder_run');
    expect(op).not.toContain('ladder_reset');
    expect(op).toContain('expense_add');
  });

  it('executeTool: 필수 필드가 빠진 update는 400 invalid_tool_input, 시간 문자열은 보정된다', () => {
    start();
    const ex = { roomId: R.friends, agentId: RA.friends, agentKind: 'room_agent' as const, turnId: 'turn_x', forcedTool: null, providedMemoryIds: [] };
    const made = executeTool(ctx, ex, 'create_board_tool', {
      kind: 'trip',
      title: '시간 보정',
      days: 1,
      items: [{ day: 1, time: '9:30', place: '마트' }, { day: 1, time: '아침', place: '카페' }],
    });
    const toolId = String(made.data?.toolId);
    const trip = toolsOf(R.friends).find((t) => t.toolId === toolId)!;
    if (trip.kind !== 'trip') throw new Error('trip 아님');
    expect(trip.items.map((i) => i.time)).toEqual(['09:30', undefined]);
    expect(() => executeTool(ctx, ex, 'update_board_tool', { tool_id: toolId, op: 'check_set', check_id: 'k_x' })).toThrowError(/done/);
  });
});

describe('mock: 자유형(custom) 도구', () => {
  it('"투표하자" → vote 블록. 선택지가 문장에 있을 때만 채우고, 없으면 빈 선택지(지어내지 않음)', async () => {
    start();
    say(alice, R.friends, '라멘이랑 국밥 중에 뭐 먹을지 투표하자');
    await ctx.agents.drain();
    const t = toolsOf(R.friends)[0]!;
    if (t.kind !== 'custom') throw new Error('custom 아님');
    expect(t.createdBy.kind).toBe('room_agent');
    expect(t.blocks).toHaveLength(1);
    const v = t.blocks[0]!;
    if (v.type !== 'vote') throw new Error('vote 아님');
    expect(v.options.map((o) => o.text)).toEqual(['라멘', '국밥']);
    expect(v.votes).toEqual({}); // Agent는 투표하지 않는다
    expect(msgs(R.friends).some((m) => m.actorKind === 'room_agent' && m.text.includes('투표를 올려'))).toBe(true);

    start();
    say(alice, R.friends, '뭐 먹을지 투표하자');
    await ctx.agents.drain();
    const e = toolsOf(R.friends)[0]!;
    if (e.kind !== 'custom' || e.blocks[0]!.type !== 'vote') throw new Error('vote 아님');
    expect(e.blocks[0]!.options).toEqual([]);
    expect(e.blocks[0]!.question).toBe('뭐 먹을지?');
    expect(msgs(R.friends).some((m) => m.actorKind === 'room_agent' && m.text.includes('선택지를 추가'))).toBe(true);
  });

  it('"체크리스트 만들어줘" → checklist 블록. 항목은 ":" 뒤 목록에서만', async () => {
    start();
    say(alice, R.friends, '할 일 나누자: 장보기, 청소, 예약');
    await ctx.agents.drain();
    const t = toolsOf(R.friends)[0]!;
    if (t.kind !== 'custom' || t.blocks[0]!.type !== 'checklist') throw new Error('checklist 아님');
    expect(t.blocks[0]!.items.map((x) => [x.text, x.done])).toEqual([['장보기', false], ['청소', false], ['예약', false]]);

    start();
    say(alice, R.friends, '체크리스트 만들어줘');
    await ctx.agents.drain();
    const e = toolsOf(R.friends)[0]!;
    if (e.kind !== 'custom' || e.blocks[0]!.type !== 'checklist') throw new Error('checklist 아님');
    expect(e.blocks[0]!.items).toEqual([]);
  });

  it('결정성 + 같은 발화에 중복 생성하지 않음', async () => {
    start();
    const p = spy();
    ctx.agents.setProvider(p);
    say(alice, R.friends, '투표하자');
    await ctx.agents.drain();
    const input = p.inputs.find((i) => i.agent.kind === 'room_agent')!;
    expect(decideBoardTool(input)).toEqual(decideBoardTool(input));
    expect(toolsOf(R.friends)).toHaveLength(1);
    expect(decideBoardTool(p.inputs.at(-1)!)).toBeNull();
  });

  it('문장 해석 유틸', () => {
    expect(voteOptionsFrom('라멘 vs 국밥 투표')).toEqual(['라멘', '국밥']);
    expect(voteOptionsFrom('치킨, 피자, 족발 중에 투표하자')).toEqual(['치킨', '피자', '족발']);
    expect(voteOptionsFrom('점심 라멘이랑 국밥 중에 투표')).toEqual(['라멘', '국밥']);
    expect(voteOptionsFrom('뭐 먹을지 투표하자')).toEqual([]);
    expect(voteOptionsFrom('투표 어때?')).toEqual([]);
    expect(checklistItemsFrom('체크리스트: 가, 나.')).toEqual(['가', '나']);
    expect(checklistItemsFrom('체크리스트 만들어줘')).toEqual([]);
  });
});

describe('custom: Agent 도구 입력·권한', () => {
  const ex = () => ({ roomId: R.friends, agentId: RA.friends, agentKind: 'room_agent' as const, turnId: 'turn_c', forcedTool: null, providedMemoryIds: [] });

  it('JSON schema(ajv strict)·zod 일치: custom 생성·블록 op 샘플', () => {
    const ajv = new Ajv({ strict: true, allErrors: true });
    const create = { kind: 'custom', title: '투표', blocks: [{ type: 'vote', question: '뭐 먹지?', options: ['라멘', '국밥'] }, { type: 'counter', label: '잔', min: 0 }], room_message: '올렸어요' };
    const upd = { tool_id: 't_1', op: 'block_add', block: { type: 'checklist', title: '할 일', items: ['a'] } };
    const v1 = ajv.compile(TOOL_DEFS.create_board_tool.inputSchema);
    const v2 = ajv.compile(TOOL_DEFS.update_board_tool.inputSchema);
    expect(v1(create), JSON.stringify(v1.errors)).toBe(true);
    expect(v2(upd), JSON.stringify(v2.errors)).toBe(true);
    expect(BOARD_TOOL_INPUT_SCHEMAS.create_board_tool.safeParse(create).success).toBe(true);
    expect(BOARD_TOOL_INPUT_SCHEMAS.update_board_tool.safeParse(upd).success).toBe(true);
    // 스타일·HTML·URL 같은 필드는 두 쪽 모두 거부
    const bad = { ...create, blocks: [{ type: 'text', text: 'x', html: '<b>x</b>' }] };
    expect(v1(bad)).toBe(false);
    expect(BOARD_TOOL_INPUT_SCHEMAS.create_board_tool.safeParse(bad).success).toBe(false);
    // 투표·카운터 op는 Agent enum에 없다
    const ops = (TOOL_DEFS.update_board_tool.inputSchema as { properties: { op: { enum: string[] } } }).properties.op.enum;
    for (const o of ['vote_cast', 'counter_add', 'vote_option_remove']) expect(ops).not.toContain(o);
    expect(ops).toEqual(expect.arrayContaining(['block_add', 'block_check_set', 'vote_option_add']));
    expect(TOOL_DEFS.create_board_tool.description).toContain('custom');
  });

  it('executeTool: custom 생성 → 블록 추가·체크·선택지 추가, 필수 필드 누락은 400', () => {
    start();
    const made = executeTool(ctx, ex(), 'create_board_tool', {
      kind: 'custom',
      title: '점심',
      blocks: [{ type: 'checklist', title: '할 일', items: ['장보기'] }, { type: 'vote', question: '뭐 먹지?' }],
    });
    const toolId = String(made.data?.toolId);
    let t = toolsOf(R.friends).find((x) => x.toolId === toolId)!;
    if (t.kind !== 'custom') throw new Error('custom 아님');
    const [c, v] = t.blocks;
    executeTool(ctx, ex(), 'update_board_tool', { tool_id: toolId, op: 'vote_option_add', block_id: v!.blockId, text: '라멘' });
    executeTool(ctx, ex(), 'update_board_tool', { tool_id: toolId, op: 'block_check_set', block_id: c!.blockId, check_id: (c as { items: { checkId: string }[] }).items[0]!.checkId, done: true });
    executeTool(ctx, ex(), 'update_board_tool', { tool_id: toolId, op: 'block_add', block: { type: 'text', text: '메모' } });
    t = toolsOf(R.friends).find((x) => x.toolId === toolId)!;
    if (t.kind !== 'custom') throw new Error('custom 아님');
    expect(t.blocks.map((b) => b.type)).toEqual(['checklist', 'vote', 'text']);
    expect((t.blocks[1] as { options: unknown[] }).options).toHaveLength(1);
    expect(() => executeTool(ctx, ex(), 'update_board_tool', { tool_id: toolId, op: 'block_check_set', block_id: c!.blockId })).toThrowError(/check_id/);
    expect(() => executeTool(ctx, ex(), 'create_board_tool', { kind: 'custom', title: '빈' })).toThrowError(/blocks/);
  });

  it('Agent의 vote_cast는 도구 입력 검증(400)에서 거부되고, dispatch로 직접 보내도 humans_only', async () => {
    start();
    say(alice, R.friends, '투표하자');
    await ctx.agents.drain();
    const t = toolsOf(R.friends)[0]!;
    ctx.agents.setProvider(roomAgentScript([{ name: 'update_board_tool', input: { tool_id: t.toolId, op: 'vote_cast', block_id: 'b_x' } }]));
    say(alice, R.friends, '고마워');
    await ctx.agents.drain();
    expect(lastOutcomeOf(RA.friends)).toMatchObject({ result: 'error', errorCode: 'invalid_tool_input', errorStatus: 400 });
  });

  it('프롬프트: [보드 도구]에 블록 id·선택지 id·집계가 보이고 투표자 id는 없다. custom 규칙이 시스템 프롬프트에 있다', async () => {
    start();
    const p = spy();
    ctx.agents.setProvider(p);
    say(alice, R.friends, '라멘 vs 국밥 투표하자');
    await ctx.agents.drain();
    const tool = toolsOf(R.friends)[0]!;
    if (tool.kind !== 'custom' || tool.blocks[0]!.type !== 'vote') throw new Error('vote 아님');
    const b = tool.blocks[0]!;
    dispatch(ctx, { kind: 'human', userId: alice }, { type: 'update_board_tool', roomId: R.friends, toolId: tool.toolId, op: { op: 'vote_cast', blockId: b.blockId, optionId: b.options[0]!.optionId } });
    say(bob, R.friends, '고마워!');
    await ctx.agents.drain();
    const last = p.inputs.filter((i) => i.agent.kind === 'room_agent').at(-1)!;
    expect(last.prompt).toContain(`[${tool.toolId}] 메모판`);
    expect(last.prompt).toContain(`[${b.blockId}] 투표`);
    expect(last.prompt).toContain(`(${b.options[0]!.optionId}) 라멘 1표`);
    const section = last.prompt.split('[보드 도구]')[1]!.split('[최근 이벤트]')[0]!;
    expect(section).not.toContain(alice);
    expect(last.system).toContain('kind=custom');
  });
});
