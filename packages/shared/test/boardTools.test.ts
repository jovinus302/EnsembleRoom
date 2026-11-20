import { describe, expect, it } from 'vitest';
import {
  AGENT_TOOL_OPS,
  BOARD_TOOL_LIMITS,
  BoardToolInitInputSchema,
  BoardToolOpSchema,
  OP_KIND,
  applyBoardToolOp,
  boardToolSummary,
  buildRoomState,
  createBoardTool,
  ladderRungs,
  ladderResult,
  ladderTrace,
  materializeInit,
  materializeOp,
  mulberry32,
  padOutcomes,
  settle,
  visibleBoardTools,
  voteTally,
  type BoardTool,
  type CustomTool,
  type EventPayload,
  type LadderTool,
  type SettlementTool,
} from '../src';
import { makeLog } from './helpers';

let counter = 0;
const newId = (p: string) => `${p}_${++counter}`;

describe('mulberry32 / 사다리', () => {
  it('같은 seed는 같은 수열, 값은 [0,1)', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    const xs = Array.from({ length: 5 }, () => a());
    expect(xs).toEqual(Array.from({ length: 5 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it('가로줄: 결정적, 같은 row에서 인접 col 연속 없음, 모든 인접 열 쌍에 최소 1개', () => {
    for (const nn of [2, 3, 5, 8]) {
      for (let seed = 0; seed < 200; seed++) {
        const r = ladderRungs(seed, nn, 8);
        expect(ladderRungs(seed, nn, 8)).toEqual(r);
        for (const x of r) expect(r.some((y) => y.row === x.row && y.col === x.col + 1)).toBe(false);
        for (let c = 0; c < nn - 1; c++) expect(r.some((x) => x.col === c)).toBe(true);
      }
    }
  });

  it('결과는 순열이고 trace 끝점과 일치', () => {
    for (let seed = 0; seed < 100; seed++) {
      const nn = 2 + (seed % 7);
      const r = ladderRungs(seed, nn, 8);
      const res = ladderResult(nn, r, 8);
      expect([...res].sort((a, b) => a - b)).toEqual(Array.from({ length: nn }, (_, i) => i));
      for (let i = 0; i < nn; i++) {
        const t = ladderTrace(nn, r, 8, i);
        expect(t[0]).toEqual({ col: i, y: 0 });
        expect(t.at(-1)).toEqual({ col: res[i], y: 8 });
      }
    }
  });

  it('padOutcomes', () => {
    expect(padOutcomes(['a'], 3)).toEqual(['a', '꽝', '꽝']);
    expect(padOutcomes(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });
});

describe('settle', () => {
  const tool = (expenses: SettlementTool['expenses'], participants: string[] = []): SettlementTool =>
    createBoardTool({
      toolId: 't',
      title: 'x',
      ownerTag: 'ours',
      init: { kind: 'settlement', participants, expenses },
      seq: 1,
      actorKind: 'human',
      actorId: 'alice',
    }) as SettlementTool;

  it('예제: Alice 24000 + Bob 12000, 둘이 나눔 → Bob→Alice 6000', () => {
    const r = settle(
      tool(
        [
          { expenseId: 'e1', label: '영화표', payer: 'Alice', amount: 24000, splitAmong: ['Alice', 'Bob'] },
          { expenseId: 'e2', label: '팝콘', payer: 'Bob', amount: 12000, splitAmong: ['Alice', 'Bob'] },
        ],
        ['Alice', 'Bob'],
      ),
    );
    expect(r.total).toBe(36000);
    expect(r.transfers).toEqual([{ from: 'Bob', to: 'Alice', amount: 6000 }]);
    expect(r.perPerson.map((p) => p.net)).toEqual([6000, -6000]);
  });

  it('나머지 원은 앞 사람부터 1원, 합은 보존, 선언 밖 이름은 합집합에 추가', () => {
    const r = settle(tool([{ expenseId: 'e1', label: '', payer: 'Zed', amount: 100, splitAmong: ['A', 'B', 'C'] }], ['A']));
    expect(r.participants).toEqual(['A', 'Zed', 'B', 'C']);
    expect(r.perPerson.find((p) => p.name === 'A')!.owed).toBe(34);
    expect(r.perPerson.find((p) => p.name === 'C')!.owed).toBe(33);
    expect(r.perPerson.reduce((s, p) => s + p.net, 0)).toBe(0);
    expect(r.transfers.reduce((s, t) => s + t.amount, 0)).toBe(100);
  });

  it('빈 정산표', () => {
    expect(settle(tool([]))).toEqual({ participants: [], total: 0, perPerson: [], transfers: [] });
  });
});

describe('스키마 / materialize', () => {
  it('Init/Op 스키마 판별, 잘못된 값 거부', () => {
    expect(BoardToolInitInputSchema.safeParse({ kind: 'ladder', participants: ['a'], outcomes: ['x'] }).success).toBe(false);
    expect(BoardToolInitInputSchema.parse({ kind: 'settlement' })).toEqual({ kind: 'settlement', participants: [], expenses: [] });
    expect(BoardToolInitInputSchema.parse({ kind: 'trip' })).toMatchObject({ days: 1, items: [], checklist: [] });
    expect(BoardToolOpSchema.safeParse({ op: 'ladder_run', seed: -1 }).success).toBe(false);
    expect(BoardToolOpSchema.safeParse({ op: 'ladder_run', seed: 0xffffffff }).success).toBe(true);
    expect(BoardToolOpSchema.safeParse({ op: 'nope' }).success).toBe(false);
  });

  it('OP_KIND는 모든 op를 덮고 AGENT_TOOL_OPS는 run/reset 제외', () => {
    expect(Object.keys(OP_KIND).length).toBe(21);
    expect(AGENT_TOOL_OPS).not.toContain('ladder_run');
    expect(AGENT_TOOL_OPS).not.toContain('ladder_reset');
  });

  it('materializeInit: ladder 패딩, settlement splitAmong 기본, trip id·done', () => {
    counter = 0;
    expect(materializeInit({ kind: 'ladder', participants: ['A', 'B', 'C'], outcomes: ['당첨'] }, newId)).toEqual({
      kind: 'ladder',
      participants: ['A', 'B', 'C'],
      outcomes: ['당첨', '꽝', '꽝'],
    });
    const s = materializeInit(
      { kind: 'settlement', participants: ['A', 'B'], expenses: [{ payer: 'A', amount: 10 }] },
      newId,
    );
    expect(s).toMatchObject({ expenses: [{ label: '', payer: 'A', splitAmong: ['A', 'B'] }] });
    const t = materializeInit(
      { kind: 'trip', days: 2, items: [{ day: 1, place: '마트' }], checklist: ['가방'] },
      newId,
    );
    expect(t).toMatchObject({
      days: 2,
      items: [{ itemId: expect.stringMatching(/^i_/) }],
      checklist: [{ checkId: expect.stringMatching(/^k_/), done: false }],
    });
  });

  it('materializeOp: seed·id 부여, splitAmong 폴백', () => {
    expect(materializeOp({ op: 'ladder_run' }, { newId, seed: () => 7 })).toEqual({ op: 'ladder_run', seed: 7 });
    expect(materializeOp({ op: 'expense_add', payer: 'A', amount: 5 }, { newId, seed: () => 0 })).toMatchObject({
      expense: { splitAmong: ['A'] },
    });
    expect(
      materializeOp({ op: 'expense_add', payer: 'A', amount: 5 }, { newId, seed: () => 0, participants: ['A', 'B'] }),
    ).toMatchObject({ expense: { splitAmong: ['A', 'B'] } });
    expect(materializeOp({ op: 'check_add', text: 'x' }, { newId, seed: () => 0 })).toMatchObject({
      check: { done: false },
    });
  });
});

describe('applyBoardToolOp (관대)', () => {
  const actor = { kind: 'human' as const, id: 'alice' };
  const ladder = (): LadderTool =>
    createBoardTool({
      toolId: 't',
      title: '사다리',
      ownerTag: 'ours',
      init: { kind: 'ladder', participants: ['A', 'B', 'C'], outcomes: ['x', 'y', 'z'] },
      seq: 1,
      actorKind: 'room_agent',
      actorId: 'ra',
    }) as LadderTool;

  it('ladder_run은 결과를 계산하고 두 번째 run·실행 후 set은 무시, reset 후 다시 가능', () => {
    const t0 = ladder();
    const t1 = applyBoardToolOp(t0, { op: 'ladder_run', seed: 5 }, { seq: 2, actor }) as LadderTool;
    expect(t1.run!.result).toHaveLength(3);
    expect(t1.run).toMatchObject({ seed: 5, seq: 2, by: actor });
    expect(t1.rev).toBe(1);
    expect(applyBoardToolOp(t1, { op: 'ladder_run', seed: 6 }, { seq: 3, actor })).toBe(t1);
    expect(
      applyBoardToolOp(t1, { op: 'ladder_set', participants: ['A', 'B'], outcomes: ['x', 'y'] }, { seq: 3, actor }),
    ).toBe(t1);
    const t2 = applyBoardToolOp(t1, { op: 'ladder_reset' }, { seq: 4, actor }) as LadderTool;
    expect(t2.run).toBeNull();
    expect(applyBoardToolOp(t2, { op: 'ladder_reset' }, { seq: 5, actor })).toBe(t2);
  });

  it('종류 불일치·없는 항목·중복 id는 무시, title_set은 모든 종류', () => {
    const t = ladder();
    expect(applyBoardToolOp(t, { op: 'check_set', checkId: 'k', done: true }, { seq: 2, actor })).toBe(t);
    expect(applyBoardToolOp(t, { op: 'title_set', title: '새 제목' }, { seq: 2, actor })).toMatchObject({
      title: '새 제목',
      updatedSeq: 2,
    });
    const trip = createBoardTool({
      toolId: 'tr',
      title: 'T',
      ownerTag: 'ours',
      seq: 1,
      actorKind: 'human',
      actorId: 'a',
      init: { kind: 'trip', days: 1, items: [], checklist: [{ checkId: 'k1', text: 'a', done: false }] },
    });
    expect(applyBoardToolOp(trip, { op: 'check_remove', checkId: 'nope' }, { seq: 2, actor })).toBe(trip);
    expect(
      applyBoardToolOp(trip, { op: 'check_add', check: { checkId: 'k1', text: 'b', done: false } }, { seq: 2, actor }),
    ).toBe(trip);
    const set = applyBoardToolOp(trip, { op: 'check_set', checkId: 'k1', done: true }, { seq: 2, actor });
    expect(set.kind === 'trip' && set.checklist[0]!.done).toBe(true);
  });
});

describe('RoomState 리듀서', () => {
  function log() {
    const l = makeLog('r1');
    l.push(
      {
        type: 'board_tool_created',
        toolId: 't1',
        title: '커피',
        ownerTag: 'ours',
        init: { kind: 'ladder', participants: ['A', 'B', 'C'], outcomes: ['커피 사기', '꽝', '꽝'] },
      },
      { actorKind: 'room_agent', actorId: 'ra' },
    );
    l.push({ type: 'board_tool_updated', toolId: 't1', op: { op: 'ladder_run', seed: 99 } });
    l.push({ type: 'board_tool_updated', toolId: 't1', op: { op: 'ladder_run', seed: 1 } }); // 무시
    l.push({
      type: 'board_tool_created',
      toolId: 't2',
      title: '정산',
      ownerTag: 'ours',
      init: {
        kind: 'settlement',
        participants: ['Alice', 'Bob'],
        expenses: [{ expenseId: 'e1', label: '', payer: 'Alice', amount: 24000, splitAmong: ['Alice', 'Bob'] }],
      },
    });
    l.push({ type: 'board_tool_updated', toolId: 'nope', op: { op: 'title_set', title: 'x' } });
    return l.events;
  }

  it('재생 결정성: 두 번 리듀싱해도 같고 upToSeq로 시점 재생', () => {
    const ev = log();
    const a = buildRoomState('r1', ev);
    expect(buildRoomState('r1', ev)).toEqual(a);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    const t1 = a.boardTools['t1'] as LadderTool;
    expect(t1.run).toMatchObject({ seed: 99, seq: 2 });
    expect(t1.createdBy).toEqual({ kind: 'room_agent', id: 'ra' });
    expect(t1.rev).toBe(1);
    expect(a.toolOrder).toEqual(['t1', 't2']);
    expect((buildRoomState('r1', ev, 1).boardTools['t1'] as LadderTool).run).toBeNull();
    expect(boardToolSummary(a.boardTools['t2'] as BoardTool)).toBe('1건 · 총 24,000원');
  });

  it('중복 생성 무시, removed 이후 op 무시, visibleBoardTools 제외', () => {
    const l = makeLog('r1');
    const created: EventPayload = {
      type: 'board_tool_created',
      toolId: 't1',
      title: 'a',
      ownerTag: 'ours',
      init: { kind: 'trip', days: 1, items: [], checklist: [] },
    };
    l.push(created);
    l.push({ ...created, title: 'b' });
    l.push({ type: 'board_tool_removed', toolId: 't1' });
    l.push({ type: 'board_tool_updated', toolId: 't1', op: { op: 'title_set', title: 'c' } });
    const s = buildRoomState('r1', l.events);
    expect(s.boardTools['t1']).toMatchObject({ title: 'a', removed: true });
    expect(s.toolOrder).toEqual(['t1']);
    expect(visibleBoardTools(s)).toEqual([]);
  });
});

describe('custom(자유형) 도구', () => {
  const alice = { kind: 'human' as const, id: 'alice' };
  const bob = { kind: 'human' as const, id: 'bob' };
  const agent = { kind: 'agent' as const, id: 'ag' };
  const make = (): CustomTool => {
    counter = 0;
    const init = materializeInit(
      {
        kind: 'custom',
        blocks: [
          { type: 'text', text: '점심 정하기' },
          { type: 'checklist', title: '할 일', items: ['장보기', '예약'] },
          { type: 'vote', question: '뭐 먹지?', options: ['라멘', '국밥'] },
          { type: 'counter', label: '커피 잔 수', min: 0, max: 3 },
        ],
      },
      newId,
    );
    return createBoardTool({ toolId: 'tc', title: '점심', ownerTag: 'ours', init, seq: 1, actorKind: 'room_agent', actorId: 'ra' }) as CustomTool;
  };
  const ids = (t: CustomTool) => {
    const [, c, v, n] = t.blocks as [unknown, any, any, any];
    return { c, v, n };
  };

  it('입력 스키마: 기본값, strict(HTML/URL/스타일 같은 미지 필드 거부), 상한', () => {
    expect(BoardToolInitInputSchema.parse({ kind: 'custom', blocks: [{ type: 'vote', question: 'q' }] })).toEqual({
      kind: 'custom',
      blocks: [{ type: 'vote', question: 'q', options: [] }],
    });
    for (const bad of [
      { type: 'text', text: 'x', html: '<b>x</b>' },
      { type: 'text', text: 'x', style: 'color:red' },
      { type: 'text', text: 'x', url: 'https://x.dev' },
      { type: 'script', text: 'x' },
      { type: 'text', text: 'x'.repeat(BOARD_TOOL_LIMITS.customTextChars + 1) },
      { type: 'vote', question: 'q', options: ['1', '2', '3', '4', '5', '6', '7'] },
    ]) {
      expect(BoardToolInitInputSchema.safeParse({ kind: 'custom', blocks: [bad] }).success).toBe(false);
    }
    expect(BoardToolInitInputSchema.safeParse({ kind: 'custom', blocks: [] }).success).toBe(false);
    expect(BoardToolInitInputSchema.safeParse({ kind: 'custom', extra: 1, blocks: [{ type: 'text', text: 'x' }] }).success).toBe(false);
    const nine = Array.from({ length: 9 }, () => ({ type: 'text', text: 'x' }));
    expect(BoardToolInitInputSchema.safeParse({ kind: 'custom', blocks: nine }).success).toBe(false);
    expect(BoardToolOpSchema.safeParse({ op: 'counter_add', blockId: 'b', delta: 11 }).success).toBe(false);
    expect(BoardToolOpSchema.safeParse({ op: 'vote_cast', blockId: 'b', optionId: 'o', voter: 'x' }).success).toBe(false);
  });

  it('materialize: id 접두사(b/o/k), counter min>max면 max 버림, 에이전트 허용 op', () => {
    const t = make();
    expect(t.blocks[0]!.blockId).toMatch(/^b_/);
    const { c, v, n } = ids(t);
    expect(c.items[0].checkId).toMatch(/^k_/);
    expect(v.options[0].optionId).toMatch(/^o_/);
    expect(v.votes).toEqual({});
    expect(n).toMatchObject({ value: 0, min: 0, max: 3 });
    const swapped = materializeInit({ kind: 'custom', blocks: [{ type: 'counter', label: 'x', min: 5, max: 1 }] }, newId);
    expect(swapped.kind === 'custom' && 'max' in swapped.blocks[0]!).toBe(false);
    expect(AGENT_TOOL_OPS).toEqual(expect.arrayContaining(['block_add', 'block_check_set', 'vote_option_add']));
    for (const o of ['vote_cast', 'counter_add', 'vote_option_remove'] as const) expect(AGENT_TOOL_OPS).not.toContain(o);
  });

  it('체크: 값 지정으로 수렴, 없는 항목·종류 불일치는 무시', () => {
    const t = make();
    const { c, v } = ids(t);
    const k = c.items[0].checkId;
    const t1 = applyBoardToolOp(t, { op: 'block_check_set', blockId: c.blockId, checkId: k, done: true }, { seq: 2, actor: alice }) as CustomTool;
    expect(ids(t1).c.items[0].done).toBe(true);
    const t2 = applyBoardToolOp(t1, { op: 'block_check_set', blockId: c.blockId, checkId: k, done: true }, { seq: 3, actor: bob });
    expect(ids(t2 as CustomTool).c.items[0].done).toBe(true);
    expect(applyBoardToolOp(t, { op: 'block_check_set', blockId: v.blockId, checkId: k, done: true }, { seq: 2, actor: alice })).toBe(t);
    expect(applyBoardToolOp(t, { op: 'block_check_set', blockId: 'nope', checkId: k, done: true }, { seq: 2, actor: alice })).toBe(t);
    const t3 = applyBoardToolOp(t1, { op: 'block_check_add', blockId: c.blockId, check: { checkId: 'kx', text: '청소', done: false } }, { seq: 4, actor: agent }) as CustomTool;
    expect(ids(t3).c.items).toHaveLength(3);
    expect(boardToolSummary(t3)).toBe('블록 4 · 체크 1/3');
  });

  it('투표: 사람당 1표, 변경 가능, 비사람 무시, 선택지 삭제 시 표 제거, 집계', () => {
    const t = make();
    const { v } = ids(t);
    const [ramen, guk] = v.options.map((o: { optionId: string }) => o.optionId);
    const cast = (tool: CustomTool, who: typeof alice, optionId: string, seq: number) =>
      applyBoardToolOp(tool, { op: 'vote_cast', blockId: v.blockId, optionId }, { seq, actor: who }) as CustomTool;
    let x = cast(t, alice, ramen, 2);
    x = cast(x, bob, ramen, 3);
    expect(voteTally(ids(x).v)).toEqual({ [ramen]: 2, [guk]: 0 });
    x = cast(x, alice, guk, 4);
    expect(voteTally(ids(x).v)).toEqual({ [ramen]: 1, [guk]: 1 });
    expect(cast(x, alice, guk, 5)).toBe(x);
    expect(cast(x, agent as never, ramen, 5)).toBe(x);
    expect(cast(x, alice, 'o_nope', 5)).toBe(x);
    expect(boardToolSummary(x)).toBe('블록 4 · 체크 0/2 · 투표 2표');
    const y = applyBoardToolOp(x, { op: 'vote_option_remove', blockId: v.blockId, optionId: ramen }, { seq: 6, actor: alice }) as CustomTool;
    expect(ids(y).v.options).toHaveLength(1);
    expect(ids(y).v.votes).toEqual({ alice: guk });
    const z = applyBoardToolOp(y, { op: 'vote_option_add', blockId: v.blockId, option: { optionId: 'o_new', text: '냉면' } }, { seq: 7, actor: agent }) as CustomTool;
    expect(ids(z).v.options.map((o: { text: string }) => o.text)).toEqual(['국밥', '냉면']);
  });

  it('카운터: min/max로 클램프, 변화 없으면 무시', () => {
    const t = make();
    const { n } = ids(t);
    const add = (tool: CustomTool, delta: number) =>
      applyBoardToolOp(tool, { op: 'counter_add', blockId: n.blockId, delta }, { seq: 2, actor: alice }) as CustomTool;
    expect(add(t, -1)).toBe(t);
    const a = add(add(t, 2), 5);
    expect(ids(a).n.value).toBe(3);
    expect(add(a, 1)).toBe(a);
    expect(ids(add(a, -3)).n.value).toBe(0);
  });

  it('블록 추가·삭제, 이벤트 재생 결정성(투표자 = 이벤트 actor)', () => {
    const l = makeLog('r1');
    l.push(
      {
        type: 'board_tool_created',
        toolId: 't1',
        title: '투표',
        ownerTag: 'ours',
        init: { kind: 'custom', blocks: [{ type: 'vote', blockId: 'b1', question: '뭐 먹지?', options: [{ optionId: 'o1', text: '라멘' }] }] },
      },
      { actorKind: 'room_agent', actorId: 'ra' },
    );
    l.push({ type: 'board_tool_updated', toolId: 't1', op: { op: 'vote_cast', blockId: 'b1', optionId: 'o1' } }, { actorKind: 'human', actorId: 'alice' });
    l.push({ type: 'board_tool_updated', toolId: 't1', op: { op: 'vote_cast', blockId: 'b1', optionId: 'o1' } }, { actorKind: 'agent', actorId: 'ag' });
    l.push({ type: 'board_tool_updated', toolId: 't1', op: { op: 'block_add', block: { type: 'text', blockId: 'b2', text: '메모' } } });
    l.push({ type: 'board_tool_updated', toolId: 't1', op: { op: 'block_add', block: { type: 'text', blockId: 'b2', text: '중복' } } });
    const a = buildRoomState('r1', l.events);
    expect(buildRoomState('r1', l.events)).toEqual(a);
    const t = a.boardTools['t1'] as CustomTool;
    expect(t.blocks.map((b) => b.blockId)).toEqual(['b1', 'b2']);
    expect(t.blocks[0]).toMatchObject({ votes: { alice: 'o1' } });
    expect(t.rev).toBe(2);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    const rm = applyBoardToolOp(t, { op: 'block_remove', blockId: 'b1' }, { seq: 9, actor: alice }) as CustomTool;
    expect(rm.blocks.map((b) => b.blockId)).toEqual(['b2']);
  });
});

describe('cover_set (커버 이미지 상태)', () => {
  const sys = { kind: 'system' as const, id: null };
  const mk = (kind: 'trip' | 'ladder') =>
    createBoardTool({
      toolId: 'c1',
      title: 'T',
      ownerTag: 'ours',
      seq: 1,
      actorKind: 'human',
      actorId: 'a',
      init:
        kind === 'trip'
          ? { kind: 'trip', days: 1, items: [], checklist: [] }
          : { kind: 'ladder', participants: ['a', 'b'], outcomes: ['x', 'y'] },
    });

  it('pending → ready → 내용 필드(rev·updatedSeq)는 그대로, 같은 값 반복은 무시', () => {
    const t = mk('trip');
    expect(t.cover).toBeNull();
    const p = applyBoardToolOp(t, { op: 'cover_set', status: 'pending' }, { seq: 2, actor: sys });
    expect(p.cover).toEqual({ status: 'pending', assetId: null });
    const r = applyBoardToolOp(p, { op: 'cover_set', status: 'ready', assetId: 'm_0123456789abcdef' }, { seq: 3, actor: sys });
    expect(r.cover).toEqual({ status: 'ready', assetId: 'm_0123456789abcdef' });
    expect([r.rev, r.updatedSeq]).toEqual([0, 1]);
    expect(applyBoardToolOp(r, { op: 'cover_set', status: 'ready', assetId: 'm_0123456789abcdef' }, { seq: 4, actor: sys })).toBe(r);
  });

  it('ladder에는 붙지 않고, ready에 assetId가 없으면 무시, 스키마는 형식 밖 assetId(URL)를 거부', () => {
    const l = mk('ladder');
    expect(applyBoardToolOp(l, { op: 'cover_set', status: 'pending' }, { seq: 2, actor: sys })).toBe(l);
    const t = mk('trip');
    expect(applyBoardToolOp(t, { op: 'cover_set', status: 'ready' }, { seq: 2, actor: sys })).toBe(t);
    expect(BoardToolOpSchema.safeParse({ op: 'cover_set', status: 'ready', assetId: 'https://x.test/a.png' }).success).toBe(false);
    expect(BoardToolOpSchema.safeParse({ op: 'cover_set', status: 'ready', assetId: 'm_0123456789abcdef' }).success).toBe(true);
  });
});
