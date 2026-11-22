import { afterEach, describe, expect, it } from 'vitest';
import { AnswerBlockSchema, type AnswerBlock, type RoomEvent, type SourceChip } from '@ensemble/shared';
import { memoryChipResolver, normalizeBlocks } from '../src/agent/answerBlocks';
import { MockProvider } from '../src/agent/mock';
import { buildOwnerDigest } from '../src/agent/ownerDigest';
import { executeTool } from '../src/agent/tools';
import type { AgentProvider, ProviderEvent, ToolCall, TurnInput } from '../src/agent/types';
import type { AppContext } from '../src/context';
import { dispatch } from '../src/domain/actions';
import { DomainError } from '../src/errors';
import { acceptVisit, requestHumanVisit } from '../src/domain/visits';
import { SEED, makeCtx } from './helpers';

const { alice, bob } = SEED.users;
const A = SEED.agents;
const R = SEED.rooms;

let ctx: AppContext;
afterEach(() => ctx?.agents.stop());

const start = () => {
  ctx = makeCtx();
  ctx.agents.start();
  return ctx;
};
const enter = (userId: string, roomId: string) => dispatch(ctx, { kind: 'human', userId }, { type: 'enter_room', roomId });
const say = (userId: string, roomId: string, text: string, to?: string) =>
  dispatch(ctx, { kind: 'human', userId }, { type: 'send_message', roomId, text, to });
const messages = (roomId: string) => ctx.store.listAll(roomId).filter((e): e is Extract<RoomEvent, { type: 'message' }> => e.type === 'message');
const lastAgentMsg = (roomId: string) => messages(roomId).filter((e) => e.actorKind === 'agent').at(-1)!;

function spy(base: AgentProvider = new MockProvider()): AgentProvider & { inputs: TurnInput[] } {
  const inputs: TurnInput[] = [];
  return { name: 'spy', inputs, stream: (input, signal) => (inputs.push(input), base.stream(input, signal)) };
}

/** Alice의 My Room에서 질문하고 Agent의 답 메시지를 돌려준다 */
async function ask(text: string) {
  enter(alice, R.myAlice);
  say(alice, R.myAlice, text, A.alice);
  await ctx.agents.drain();
  return lastAgentMsg(R.myAlice);
}

describe('normalizeBlocks', () => {
  const chip = (label: string): SourceChip => ({ kind: 'memory', label });
  const opts = (over: Partial<Parameters<typeof normalizeBlocks>[1]> = {}) => ({
    providedIds: ['mem_a'],
    digestRefs: new Map<string, SourceChip>([['d1', { kind: 'room', label: '팀 · 카드', roomId: 'r' }]]),
    eventSeqs: [7],
    memoryChip: (id: string) => (id === 'mem_a' ? chip('내 기억') : null),
    ...over,
  });
  const sched = (items: object[]) => ({ type: 'schedule', days: [{ label: '토', items }] });

  it('src를 칩으로 바꾸고 결과는 shared 스키마를 통과한다', () => {
    const out = normalizeBlocks([sched([{ title: '운동', status: 'fixed', src: ['mem_a', 'd1', '#7', 'mem_a'] }])], opts());
    expect(out).toHaveLength(1);
    expect(AnswerBlockSchema.safeParse(out[0]).success).toBe(true);
    const item = (out[0] as Extract<AnswerBlock, { type: 'schedule' }>).days[0]!.items[0]!;
    expect(item.sources).toEqual([chip('내 기억'), { kind: 'room', label: '팀 · 카드', roomId: 'r' }, { kind: 'event', label: '대화' }]);
    expect(JSON.stringify(out)).not.toContain('"src"');
  });

  it('제공되지 않은 mem·d·#seq 근거는 칩에서 빠지고, 근거 없는 schedule 항목은 지워진다', () => {
    const out = normalizeBlocks(
      [
        sched([
          { title: '근거 있음', status: 'fixed', src: ['mem_a', 'mem_other', 'd9', '#99'] },
          { title: '근거 없음', status: 'fixed', src: ['mem_other', 'd9', '#99'] },
          { title: '근거 필드 없음', status: 'fixed' },
        ]),
      ],
      opts(),
    );
    const items = (out[0] as Extract<AnswerBlock, { type: 'schedule' }>).days[0]!.items;
    expect(items.map((i) => i.title)).toEqual(['근거 있음']);
    expect(items[0]!.sources).toEqual([chip('내 기억')]);
  });

  it('항목이 모두 지워진 블록은 버리고, 잘못된 블록만 버리고 나머지는 살린다', () => {
    const out = normalizeBlocks(
      [sched([{ title: 'x', status: 'fixed', src: ['mem_zzz'] }]), { type: 'nope' }, 'text', { type: 'checklist', title: '할 일', items: [{ text: '회고 정리' }] }],
      opts(),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('checklist');
  });

  it('잘못된 값(상태·시각)이 있는 블록은 평문으로 폴백한다 (빈 배열)', () => {
    expect(normalizeBlocks([sched([{ title: 'x', status: 'whatever', src: ['mem_a'] }])], opts())).toEqual([]);
    expect(normalizeBlocks([sched([{ title: 'x', status: 'fixed', start: '25:99', src: ['mem_a'] }])], opts())).toEqual([]);
    expect(normalizeBlocks('nope', opts())).toEqual([]);
  });

  it('문자열·배열 상한 초과는 잘라서 통과시킨다', () => {
    const long = '가'.repeat(100);
    const items = Array.from({ length: 12 }, (_, i) => ({ title: `${i}${long}`, status: 'fixed', src: ['mem_a'] }));
    const out = normalizeBlocks([{ type: 'schedule', title: long, days: [{ label: '토', items }], verdict: long }], opts());
    const b = out[0] as Extract<AnswerBlock, { type: 'schedule' }>;
    expect(b.days[0]!.items).toHaveLength(8);
    expect(b.days[0]!.items[0]!.title).toHaveLength(60);
    expect(b.title).toHaveLength(60);
    expect(b.verdict).toHaveLength(80);
  });

  it('블록은 최대 2개', () => {
    const c = { type: 'checklist', title: 't', items: [{ text: 'a' }] };
    expect(normalizeBlocks([c, c, c], opts())).toHaveLength(2);
  });

  it('memoryChipResolver: ns로 라벨을 정하고 기억 원문은 넣지 않는다', () => {
    start();
    const f = memoryChipResolver(ctx);
    expect(f('mem_seed_alice_private')).toEqual({ kind: 'memory', label: '내 기억' });
    expect(f('mem_seed_alice_for_family')).toMatchObject({ kind: 'memory', label: '내 기억 · 우리 가족', roomId: R.family });
    expect(f('mem_seed_team_1')).toMatchObject({ label: '팀 기억' });
    expect(f('mem_nope')).toBeNull();
    expect(JSON.stringify(f('mem_seed_alice_private'))).not.toContain('매운');
  });
});

describe('My Room 구조화 답변 (mock)', () => {
  it('"이번 주 일정 알려줘" → schedule 블록 + 출처 칩 (shared 스키마 통과)', async () => {
    start();
    const m = await ask('이번 주 일정 알려줘');
    expect(m.blocks).toHaveLength(1);
    const b = AnswerBlockSchema.parse(m.blocks![0]);
    expect(b.type).toBe('schedule');
    if (b.type !== 'schedule') return;
    const items = b.days.flatMap((d) => d.items);
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.every((i) => (i.sources?.length ?? 0) > 0)).toBe(true);
    expect(items.some((i) => i.sources!.some((s) => s.label === '내 기억'))).toBe(true);
    expect(m.text).not.toMatch(/mem_|\bd\d+\b/);
  });

  it('"내 취향 정리해 줘" → profile 블록', async () => {
    start();
    const m = await ask('내 취향 정리해 줘');
    const b = AnswerBlockSchema.parse(m.blocks![0]);
    expect(b.type).toBe('profile');
    if (b.type !== 'profile') return;
    const chips = b.groups.flatMap((g) => g.chips);
    expect(chips.map((c) => c.text)).toEqual(expect.arrayContaining(['국밥']));
    expect(b.groups.find((g) => g.label.startsWith('못'))!.chips.map((c) => c.text)).toEqual(expect.arrayContaining(['고수', '매운 음식']));
  });

  it('"방들 어떻게 돼 가?" → status 블록 (카드·보드 도구 현황, 근거 칩)', async () => {
    start();
    const m = await ask('방들 어떻게 돼 가?');
    const b = AnswerBlockSchema.parse(m.blocks![0]);
    expect(b.type).toBe('status');
    if (b.type !== 'status') return;
    expect(b.rooms.length).toBeGreaterThanOrEqual(2);
    expect(b.rooms.flatMap((r) => r.items).every((i) => (i.sources?.length ?? 0) > 0)).toBe(true);
  });

  it('"이번 주 할 일" → checklist 블록', async () => {
    start();
    const m = await ask('이번 주 할 일 알려줘');
    expect(AnswerBlockSchema.parse(m.blocks![0]).type).toBe('checklist');
  });

  it('질문이 아닌 말 ("안녕")은 평문이고 blocks가 없다', async () => {
    start();
    const m = await ask('안녕');
    expect(m.type).toBe('message');
    expect(m.blocks).toBeUndefined();
  });

  it('질문이어도 해당 정보가 없으면 평문 (blocks 없음)', async () => {
    start();
    const m = await ask('오늘 기분 어때?');
    expect(m.blocks).toBeUndefined();
  });

  it('"토요일 저녁 비어?" → 미정으로 잡힌 영화 모임을 언급하고 "비어 있어요"로만 답하지 않는다', async () => {
    start();
    const m = await ask('토요일 저녁 비어?');
    expect(m.text).toContain('영화 모임');
    expect(m.text).toContain('미정');
    expect(m.text).not.toMatch(/^토요일 저녁은 비어 있어요\.?$/);
  });

  it('"일요일 오전 비어?"처럼 잡힌 카드가 없는 시간은 기억대로 답한다 (회귀 없음)', async () => {
    start();
    const m = await ask('일요일 저녁 비어?');
    expect(m.text).not.toContain('영화 모임');
  });

  it('owner_message 턴: 시스템 규칙과 현황 줄에 "잡혀 있음·세부 미정" 표기와 빈 시간 규칙이 들어간다', async () => {
    start();
    const p = spy();
    ctx.agents.setProvider(p);
    enter(alice, R.myAlice);
    say(alice, R.myAlice, '토요일 저녁 비어?');
    await ctx.agents.drain();
    const input = p.inputs.at(-1)!;
    expect(input.trigger.reason).toBe('owner_message');
    expect(input.system).toContain('세부가 미정이어도 그 시간에 잡힌 모임이 있으면');
    expect(input.system).not.toContain("'토요일 저녁 비어 있어요'");
    expect(input.prompt).toContain('[잡혀 있음·세부 미정]');
    expect(input.prompt).toContain('주말 저녁 영화 모임');
    expect(input.prompt).toContain('잡힌 모임이 있으면');
  });

  it('allowBlocks 턴의 입력: say 스키마에 blocks, 시스템에 [답변 카드], 프롬프트에 [내 Room 현황]', async () => {
    start();
    const p = spy();
    ctx.agents.setProvider(p);
    await ask('이번 주 일정 알려줘');
    const input = p.inputs.at(-1)!;
    expect(input.allowBlocks).toBe(true);
    expect(input.system).toContain('[답변 카드]');
    expect(input.prompt).toContain('[내 Room 현황]');
    expect(JSON.stringify(input.tools.find((t) => t.name === 'say')!.inputSchema)).toContain('"blocks"');
  });
});

describe('answerBlocks 권한·격리', () => {
  it('사람이 blocks를 보내면 403 agent_only_field', () => {
    start();
    const block = { type: 'checklist', title: 't', items: [{ text: 'a' }] } as AnswerBlock;
    try {
      dispatch(ctx, { kind: 'human', userId: alice }, { type: 'send_message', roomId: R.myAlice, text: 'hi', blocks: [block] });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect(e).toMatchObject({ status: 403, code: 'agent_only_field' });
    }
  });

  it('Our Room 턴(allowBlocks 꺼짐)에서는 say.blocks가 버려진다', () => {
    start();
    const ex = { roomId: R.family, agentId: A.alice, agentKind: 'personal' as const, turnId: 't_x', forcedTool: null, providedMemoryIds: [] };
    executeTool(ctx, ex, 'say', { text: '안녕', blocks: [{ type: 'checklist', title: 't', items: [{ text: 'a' }] }] });
    const m = messages(R.family).filter((e) => e.actorId === A.alice).at(-1)!;
    expect(m.text).toBe('안녕');
    expect(m.blocks).toBeUndefined();
  });

  it('allowBlocks 턴에서 say.blocks는 정규화되어 저장된다 (제공되지 않은 근거는 제거)', () => {
    start();
    enter(alice, R.myAlice);
    const ex = {
      roomId: R.myAlice,
      agentId: A.alice,
      agentKind: 'personal' as const,
      turnId: 't_y',
      forcedTool: null,
      providedMemoryIds: ['mem_seed_alice_sat'],
      blocks: { digestRefs: new Map<string, SourceChip>(), eventSeqs: [] },
    };
    const sch = (title: string, src: string[]) => ({ type: 'schedule', days: [{ label: '토', items: [{ title, status: 'fixed', src }] }] });
    executeTool(ctx, ex, 'say', { text: '정리', blocks: [sch('운동', ['mem_seed_alice_sat', 'mem_seed_bob_for_team']), sch('지어낸 일정', ['mem_seed_bob_for_team'])] });
    const m = messages(R.myAlice).filter((e) => e.actorId === A.alice).at(-1)!;
    expect(m.blocks).toHaveLength(1);
    const b = m.blocks![0] as Extract<AnswerBlock, { type: 'schedule' }>;
    expect(b.days[0]!.items[0]!.sources).toEqual([{ kind: 'memory', label: '내 기억' }]);
  });

  it('say.blocks가 3개 이상이어도 거부되지 않고 유효한 2개까지만 저장된다', () => {
    start();
    enter(alice, R.myAlice);
    const ex = {
      roomId: R.myAlice,
      agentId: A.alice,
      agentKind: 'personal' as const,
      turnId: 't_z',
      forcedTool: null,
      providedMemoryIds: ['mem_seed_alice_sat'],
      blocks: { digestRefs: new Map<string, SourceChip>(), eventSeqs: [] },
    };
    const sch = (title: string) => ({ type: 'schedule', days: [{ label: '토', items: [{ title, status: 'fixed', src: ['mem_seed_alice_sat'] }] }] });
    executeTool(ctx, ex, 'say', { text: '정리', blocks: [sch('a'), sch('b'), sch('c'), sch('d')] });
    const m = messages(R.myAlice).filter((e) => e.actorId === A.alice).at(-1)!;
    expect(m.blocks!.length).toBeLessThanOrEqual(2);
    expect(m.blocks!.length).toBeGreaterThan(0);
  });

  it('실행 시점에 방문자가 My Room에 있으면 say.blocks는 버려진다', () => {
    start();
    enter(alice, R.myAlice);
    const { visitId } = requestHumanVisit(ctx, bob, R.myAlice);
    acceptVisit(ctx, alice, visitId, ['chat']); // 방문자 입장
    const ex = {
      roomId: R.myAlice,
      agentId: A.alice,
      agentKind: 'personal' as const,
      turnId: 't_v',
      forcedTool: null,
      providedMemoryIds: ['mem_seed_alice_sat'],
      blocks: { digestRefs: new Map<string, SourceChip>(), eventSeqs: [] },
    };
    const sch = { type: 'schedule', days: [{ label: '토', items: [{ title: '운동', status: 'fixed', src: ['mem_seed_alice_sat'] }] }] };
    try {
      executeTool(ctx, ex, 'say', { text: '정리', blocks: [sch] });
    } catch {
      // 방문자 상황에서 도구 자체가 막혀도 blocks는 기록되지 않아야 한다
    }
    const m = messages(R.myAlice).filter((e) => e.actorId === A.alice).at(-1);
    expect(m?.blocks).toBeUndefined();
  });

  it('closing 턴의 say는 to로 다른 Agent를 지목해도 무시된다', () => {
    start();
    const ex = { roomId: R.family, agentId: A.alice, agentKind: 'personal' as const, turnId: 't_c', forcedTool: null, providedMemoryIds: [], closingOnly: true };
    executeTool(ctx, ex, 'say', { text: '확정됐어요', to: A.bob });
    const m = messages(R.family).filter((e) => e.actorId === A.alice).at(-1)!;
    expect(m.text).toBe('확정됐어요');
    expect(m.to).toBeUndefined();
  });

  it('현황(digest)에는 다른 사람의 기억 문장과 메시지 원문이 없다', () => {
    start();
    const d = buildOwnerDigest(ctx, alice);
    const text = d.lines.join('\n');
    for (const secret of ['16시에 고객 미팅', '장을 본다', '등산', '채식', '라멘파', 'SF 영화']) expect(text).not.toContain(secret);
    expect(text).not.toContain('토요일 저녁 괜찮아'); // 친구 방 Bob의 메시지 원문
    expect(d.lines.length).toBeLessThanOrEqual(24);
    // 소유자 본인의 for 기억과 방 카드는 들어 있다
    expect(text).toContain('주말 가족 점심');
    expect(text).toContain('내가 이 방에 공유한 기억');
    expect([...d.refs.keys()].sort()).toEqual(d.items.map((i) => i.id).sort());
  });

  it('Bob의 현황에는 Alice의 for·private 기억이 없다', () => {
    start();
    const text = buildOwnerDigest(ctx, bob).lines.join('\n');
    expect(text).not.toContain('매운 음식은 잘 못');
    expect(text).not.toContain('고수는 못 먹는다');
  });
});
