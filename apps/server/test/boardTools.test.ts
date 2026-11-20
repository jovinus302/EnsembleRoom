import { describe, expect, it } from 'vitest';
import { settle, type BoardTool, type LadderTool, type SettlementTool, type TripTool } from '@ensemble/shared';
import { dispatch, type Action } from '../src/domain/actions';
import { roomStateOf, type ActorCtx } from '../src/domain/rooms';
import { DomainError } from '../src/errors';
import { SEED, auth, insertVisit, loginAs, makeApp, makeCtx } from './helpers';

const { alice, bob } = SEED.users;
const R = SEED.rooms;
const human = (userId: string): ActorCtx => ({ kind: 'human', userId });
const agent = (agentId: string): ActorCtx => ({ kind: 'agent', agentId });
const roomAgent: ActorCtx = { kind: 'room_agent', roomAgentId: SEED.roomAgents.friends };

function err(fn: () => unknown): { status: number; code: string } | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof DomainError) return { status: e.status, code: e.code };
    throw e;
  }
}

const createLadder = (roomId: string, title = '커피 내기'): Action => ({
  type: 'create_board_tool',
  roomId,
  title,
  init: { kind: 'ladder', participants: ['Alice', 'Bob'], outcomes: ['커피 사기'] },
});
const createSettle = (roomId: string): Action => ({
  type: 'create_board_tool',
  roomId,
  title: '정산',
  init: { kind: 'settlement', participants: [], expenses: [] },
});
const createTrip = (roomId: string, days = 1): Action => ({
  type: 'create_board_tool',
  roomId,
  title: '여행',
  init: { kind: 'trip', days, items: [], checklist: ['장바구니'] },
});
const op = (roomId: string, toolId: string, o: Extract<Action, { type: 'update_board_tool' }>['op']): Action => ({
  type: 'update_board_tool',
  roomId,
  toolId,
  op: o,
});

function make(ctx: ReturnType<typeof makeCtx>, a: Action, who: ActorCtx = human(alice)): string {
  return dispatch(ctx, who, a).data.toolId as string;
}
const toolOf = <T extends BoardTool>(ctx: ReturnType<typeof makeCtx>, roomId: string, id: string) =>
  roomStateOf(ctx, roomId).boardTools[id] as T;

describe('보드 도구: 생성 권한', () => {
  it('My 소유자는 만들 수 있고, 이벤트가 투영된다', () => {
    const ctx = makeCtx();
    const id = make(ctx, createLadder(R.myAlice));
    expect(id).toMatch(/^t_[0-9a-f]{12}$/);
    const t = toolOf<LadderTool>(ctx, R.myAlice, id);
    expect(t.kind).toBe('ladder');
    expect(t.outcomes).toEqual(['커피 사기', '꽝']);
    expect(t.ownerTag).toBe(`user:${alice}`);
    expect(roomStateOf(ctx, R.myAlice).toolOrder).toEqual([id]);
  });

  it('Our 구성원·Room Agent·구성원 Agent·동행 Agent는 가능, ownerTag는 ours', () => {
    const ctx = makeCtx();
    const a = make(ctx, createLadder(R.friends), human(alice));
    const b = make(ctx, createSettle(R.friends), roomAgent);
    const c = make(ctx, createTrip(R.friends), agent(SEED.agents.alice));
    for (const id of [a, b, c]) expect(toolOf(ctx, R.friends, id).ownerTag).toBe('ours');
    expect(err(() => dispatch(ctx, agent(SEED.agents.alice), createTrip(R.myAlice)))).toBeNull();
  });

  it('DM 구성원·비구성원은 403', () => {
    const ctx = makeCtx();
    expect(err(() => dispatch(ctx, human(alice), createLadder(R.dmAliceBob)))).toEqual({ status: 403, code: 'missing_capability' });
    expect(err(() => dispatch(ctx, human(bob), createLadder(R.myAlice)))).toEqual({ status: 403, code: 'not_in_room' });
  });

  it('사람 방문자는 grant에 넣어도 보기만(403)', () => {
    const ctx = makeCtx();
    insertVisit(ctx, {
      hostRoomId: R.myAlice,
      visitorUserId: bob,
      permissions: ['chat', 'comment', 'board_tools'],
      startSeq: 1,
    });
    expect(err(() => dispatch(ctx, human(bob), createLadder(R.myAlice)))).toEqual({ status: 403, code: 'missing_capability' });
    const id = make(ctx, createLadder(R.myAlice));
    expect(err(() => dispatch(ctx, human(bob), op(R.myAlice, id, { op: 'ladder_run' })))?.status).toBe(403);
    expect(err(() => dispatch(ctx, human(bob), { type: 'remove_board_tool', roomId: R.myAlice, toolId: id }))?.status).toBe(403);
  });

  it('방문 Agent는 mandate·grant에 있어도 사용 불가', () => {
    const ctx = makeCtx();
    insertVisit(ctx, {
      hostRoomId: R.myBob,
      visitorUserId: alice,
      visitorKind: 'agent',
      visitorAgentId: SEED.agents.alice,
      permissions: ['chat', 'board_tools'],
      mandate: { text: '도구', allowedActions: ['chat', 'board_tools'] },
      startSeq: 1,
    });
    expect(err(() => dispatch(ctx, agent(SEED.agents.alice), createLadder(R.myBob)))).toEqual({
      status: 403,
      code: 'missing_capability',
    });
  });
});

describe('보드 도구: 오류 코드', () => {
  it('빈 제목 400, 잘못된 init 400, 12개 초과 409', () => {
    const ctx = makeCtx();
    expect(err(() => dispatch(ctx, human(alice), createLadder(R.myAlice, '  ')))).toEqual({ status: 400, code: 'empty_title' });
    expect(
      err(() =>
        dispatch(ctx, human(alice), {
          type: 'create_board_tool',
          roomId: R.myAlice,
          title: 'x',
          init: { kind: 'ladder', participants: ['A'], outcomes: ['a'] },
        }),
      ),
    ).toEqual({ status: 400, code: 'invalid_tool_init' });
    for (let i = 0; i < 12; i++) make(ctx, createTrip(R.myAlice));
    expect(err(() => dispatch(ctx, human(alice), createTrip(R.myAlice)))).toEqual({ status: 409, code: 'too_many_tools' });
  });

  it('없는/내려간 도구 404, 종류 불일치 400', () => {
    const ctx = makeCtx();
    expect(err(() => dispatch(ctx, human(alice), op(R.myAlice, 't_nope', { op: 'ladder_run' })))).toEqual({
      status: 404,
      code: 'tool_not_found',
    });
    const id = make(ctx, createLadder(R.myAlice));
    expect(err(() => dispatch(ctx, human(alice), op(R.myAlice, id, { op: 'check_add', text: 'x' })))).toEqual({
      status: 400,
      code: 'op_kind_mismatch',
    });
    dispatch(ctx, human(alice), { type: 'remove_board_tool', roomId: R.myAlice, toolId: id });
    expect(err(() => dispatch(ctx, human(alice), op(R.myAlice, id, { op: 'title_set', title: 'z' })))?.code).toBe('tool_not_found');
    expect(err(() => dispatch(ctx, human(alice), { type: 'remove_board_tool', roomId: R.myAlice, toolId: id }))?.status).toBe(404);
  });

  it('사다리: 실행·초기화는 사람만, 이중 실행 409, 미실행 reset 409, 실행 후 수정 409', () => {
    const ctx = makeCtx();
    const id = make(ctx, createLadder(R.friends));
    expect(err(() => dispatch(ctx, roomAgent, op(R.friends, id, { op: 'ladder_run' })))).toEqual({ status: 403, code: 'humans_only' });
    expect(err(() => dispatch(ctx, agent(SEED.agents.alice), op(R.friends, id, { op: 'ladder_reset' })))?.code).toBe('humans_only');
    expect(err(() => dispatch(ctx, human(alice), op(R.friends, id, { op: 'ladder_reset' })))).toEqual({ status: 409, code: 'not_ran' });

    const r = dispatch(ctx, human(alice), op(R.friends, id, { op: 'ladder_run' }));
    expect(r.data).toEqual({ toolId: id, op: 'ladder_run' });
    const t = toolOf<LadderTool>(ctx, R.friends, id);
    expect(t.run?.result).toHaveLength(2);
    expect([...t.run!.result].sort()).toEqual([0, 1]);

    // 동시에 눌린 두 번째 실행
    expect(err(() => dispatch(ctx, human(bob), op(R.friends, id, { op: 'ladder_run' })))).toEqual({ status: 409, code: 'already_ran', });
    expect(
      err(() => dispatch(ctx, human(alice), op(R.friends, id, { op: 'ladder_set', participants: ['A', 'B'], outcomes: ['x', 'y'] })))?.code,
    ).toBe('already_ran');
    expect(toolOf<LadderTool>(ctx, R.friends, id).run?.seed).toBe(t.run!.seed);

    dispatch(ctx, human(bob), op(R.friends, id, { op: 'ladder_reset' }));
    expect(toolOf<LadderTool>(ctx, R.friends, id).run).toBeNull();
    expect(err(() => dispatch(ctx, human(bob), op(R.friends, id, { op: 'ladder_run' })))).toBeNull();
  });

  it('사다리 실행 seed는 이벤트에 저장되고 같은 로그는 같은 결과로 재생된다', () => {
    const ctx = makeCtx();
    const id = make(ctx, createLadder(R.friends));
    dispatch(ctx, human(alice), op(R.friends, id, { op: 'ladder_run' }));
    const a = toolOf<LadderTool>(ctx, R.friends, id).run;
    const b = toolOf<LadderTool>(ctx, R.friends, id).run;
    expect(a).toEqual(b);
    expect(Number.isInteger(a!.seed)).toBe(true);
    expect(a!.by).toEqual({ kind: 'human', id: alice });
  });

  it('정산: 지출 추가·삭제, 이름 합집합, 404, 상한', () => {
    const ctx = makeCtx();
    const id = make(ctx, createSettle(R.friends), roomAgent);
    dispatch(ctx, human(alice), op(R.friends, id, { op: 'expense_add', payer: 'Alice', amount: 24000, label: '영화표', splitAmong: ['Alice', 'Bob'] }));
    dispatch(ctx, human(bob), op(R.friends, id, { op: 'expense_add', payer: 'Bob', amount: 12000, splitAmong: ['Alice', 'Bob'] }));
    const t = toolOf<SettlementTool>(ctx, R.friends, id);
    expect(t.expenses).toHaveLength(2);
    expect(settle(t).transfers).toEqual([{ from: 'Bob', to: 'Alice', amount: 6000 }]);

    expect(err(() => dispatch(ctx, human(alice), op(R.friends, id, { op: 'expense_remove', expenseId: 'e_none' })))).toEqual({
      status: 404,
      code: 'item_not_found',
    });
    dispatch(ctx, human(alice), op(R.friends, id, { op: 'expense_remove', expenseId: t.expenses[0]!.expenseId }));
    expect(toolOf<SettlementTool>(ctx, R.friends, id).expenses).toHaveLength(1);

    // 참가자 합집합 8명 초과
    const many = Array.from({ length: 8 }, (_, i) => `P${i}`);
    expect(
      err(() => dispatch(ctx, human(alice), op(R.friends, id, { op: 'expense_add', payer: 'Zed', amount: 10, splitAmong: many }))),
    ).toEqual({ status: 409, code: 'tool_full' });
  });

  it('정산: 지출 40건 상한 409', () => {
    const ctx = makeCtx();
    const id = make(ctx, createSettle(R.myAlice));
    for (let i = 0; i < 40; i++) dispatch(ctx, human(alice), op(R.myAlice, id, { op: 'expense_add', payer: 'Alice', amount: 100 }));
    expect(err(() => dispatch(ctx, human(alice), op(R.myAlice, id, { op: 'expense_add', payer: 'Alice', amount: 100 })))).toEqual({
      status: 409,
      code: 'tool_full',
    });
  });

  it('여행: 일정·준비물 op, invalid_day 400, item_not_found 404, check_set은 값 지정', () => {
    const ctx = makeCtx();
    const id = make(ctx, createTrip(R.friends, 2), agent(SEED.agents.alice));
    expect(err(() => dispatch(ctx, human(alice), op(R.friends, id, { op: 'trip_item_add', day: 3, place: '공원' })))).toEqual({
      status: 400,
      code: 'invalid_day',
    });
    dispatch(ctx, human(alice), op(R.friends, id, { op: 'trip_item_add', day: 2, time: '09:00', place: '공원' }));
    let t = toolOf<TripTool>(ctx, R.friends, id);
    expect(t.items).toHaveLength(1);
    const checkId = t.checklist[0]!.checkId;
    dispatch(ctx, human(alice), op(R.friends, id, { op: 'check_set', checkId, done: true }));
    dispatch(ctx, human(bob), op(R.friends, id, { op: 'check_set', checkId, done: true }));
    expect(toolOf<TripTool>(ctx, R.friends, id).checklist[0]!.done).toBe(true);
    expect(err(() => dispatch(ctx, human(alice), op(R.friends, id, { op: 'check_set', checkId: 'k_none', done: true })))?.code).toBe('item_not_found');
    expect(err(() => dispatch(ctx, human(alice), op(R.friends, id, { op: 'trip_item_remove', itemId: 'i_none' })))?.status).toBe(404);
    dispatch(ctx, human(alice), op(R.friends, id, { op: 'trip_item_remove', itemId: t.items[0]!.itemId }));
    dispatch(ctx, human(alice), op(R.friends, id, { op: 'check_remove', checkId }));
    t = toolOf<TripTool>(ctx, R.friends, id);
    expect(t.items).toHaveLength(0);
    expect(t.checklist).toHaveLength(0);
  });

  it('title_set은 모든 종류에 가능, 도구 삭제는 사람만', () => {
    const ctx = makeCtx();
    const id = make(ctx, createTrip(R.friends));
    dispatch(ctx, roomAgent, op(R.friends, id, { op: 'title_set', title: '새 제목' }));
    expect(toolOf(ctx, R.friends, id).title).toBe('새 제목');
    expect(err(() => dispatch(ctx, roomAgent, { type: 'remove_board_tool', roomId: R.friends, toolId: id }))).toEqual({
      status: 403,
      code: 'humans_only',
    });
    dispatch(ctx, human(bob), { type: 'remove_board_tool', roomId: R.friends, toolId: id });
    expect(toolOf(ctx, R.friends, id).removed).toBe(true);
  });
});

describe('보드 도구: custom(자유형)', () => {
  const createCustom = (roomId: string): Action => ({
    type: 'create_board_tool',
    roomId,
    title: '점심',
    init: {
      kind: 'custom',
      blocks: [
        { type: 'checklist', title: '할 일', items: ['장보기', '예약'] },
        { type: 'vote', question: '뭐 먹지?', options: ['라멘', '국밥'] },
        { type: 'counter', label: '커피', min: 0, max: 2 },
      ],
    },
  });
  type CustomT = Extract<BoardTool, { kind: 'custom' }>;
  const get = (ctx: ReturnType<typeof makeCtx>, roomId: string, id: string) => {
    const t = toolOf<CustomT>(ctx, roomId, id);
    const [c, v, n] = t.blocks as [any, any, any];
    return { t, c, v, n };
  };

  it('생성: id 부여, 투표·카운터 초기 상태. 미지 필드(HTML/스타일)는 400 invalid_tool_init', () => {
    const ctx = makeCtx();
    const id = make(ctx, createCustom(R.friends));
    const { t, c, v, n } = get(ctx, R.friends, id);
    expect(t.blocks).toHaveLength(3);
    expect(c.items.map((x: { text: string }) => x.text)).toEqual(['장보기', '예약']);
    expect(v.votes).toEqual({});
    expect(n.value).toBe(0);
    for (const bad of [
      { type: 'text', text: 'x', html: '<img src=x onerror=alert(1)>' },
      { type: 'text', text: 'x', style: 'color:red' },
      { type: 'iframe', text: 'x' },
    ]) {
      expect(
        err(() =>
          dispatch(ctx, human(alice), { type: 'create_board_tool', roomId: R.friends, title: 'x', init: { kind: 'custom', blocks: [bad] } as never }),
        ),
      ).toEqual({ status: 400, code: 'invalid_tool_init' });
    }
  });

  it('투표: 사람당 1표(userId 기준), 변경 가능, Agent는 403 humans_only', () => {
    const ctx = makeCtx();
    const id = make(ctx, createCustom(R.friends));
    const { v } = get(ctx, R.friends, id);
    const [ramen, guk] = v.options.map((o: { optionId: string }) => o.optionId);
    const cast = (who: ActorCtx, optionId: string) =>
      dispatch(ctx, who, op(R.friends, id, { op: 'vote_cast', blockId: v.blockId, optionId }));
    cast(human(alice), ramen);
    cast(human(bob), ramen);
    expect(get(ctx, R.friends, id).v.votes).toEqual({ [alice]: ramen, [bob]: ramen });
    cast(human(alice), guk);
    expect(get(ctx, R.friends, id).v.votes).toEqual({ [alice]: guk, [bob]: ramen });
    expect(err(() => cast(roomAgent, ramen))).toEqual({ status: 403, code: 'humans_only' });
    expect(err(() => cast(agent(SEED.agents.alice), ramen))?.code).toBe('humans_only');
    expect(err(() => cast(human(alice), 'o_nope'))).toEqual({ status: 404, code: 'item_not_found' });
    expect(Object.keys(get(ctx, R.friends, id).v.votes)).toHaveLength(2);
  });

  it('체크·블록·선택지 op: Agent도 가능, 404/400/409 코드', () => {
    const ctx = makeCtx();
    const id = make(ctx, createCustom(R.friends));
    const { c, v, n } = get(ctx, R.friends, id);
    const k = c.items[0].checkId;
    dispatch(ctx, roomAgent, op(R.friends, id, { op: 'block_check_set', blockId: c.blockId, checkId: k, done: true }));
    expect(get(ctx, R.friends, id).c.items[0].done).toBe(true);
    dispatch(ctx, roomAgent, op(R.friends, id, { op: 'block_check_add', blockId: c.blockId, text: '청소' }));
    expect(get(ctx, R.friends, id).c.items).toHaveLength(3);
    dispatch(ctx, roomAgent, op(R.friends, id, { op: 'vote_option_add', blockId: v.blockId, text: '냉면' }));
    expect(get(ctx, R.friends, id).v.options).toHaveLength(3);

    expect(err(() => dispatch(ctx, human(alice), op(R.friends, id, { op: 'block_check_set', blockId: 'b_nope', checkId: k, done: true })))).toEqual({ status: 404, code: 'item_not_found' });
    expect(err(() => dispatch(ctx, human(alice), op(R.friends, id, { op: 'block_check_set', blockId: c.blockId, checkId: 'k_nope', done: true })))?.code).toBe('item_not_found');
    expect(err(() => dispatch(ctx, human(alice), op(R.friends, id, { op: 'block_check_set', blockId: v.blockId, checkId: k, done: true })))).toEqual({ status: 400, code: 'op_kind_mismatch' });
    // 다른 종류 도구에는 custom op 불가
    const ladder = make(ctx, createLadder(R.friends));
    expect(err(() => dispatch(ctx, human(alice), op(R.friends, ladder, { op: 'vote_cast', blockId: 'b', optionId: 'o' })))).toEqual({ status: 400, code: 'op_kind_mismatch' });
    // 카운터는 사람만, 범위로 클램프
    expect(err(() => dispatch(ctx, roomAgent, op(R.friends, id, { op: 'counter_add', blockId: n.blockId, delta: 1 })))?.code).toBe('humans_only');
    dispatch(ctx, human(alice), op(R.friends, id, { op: 'counter_add', blockId: n.blockId, delta: 10 }));
    expect(get(ctx, R.friends, id).n.value).toBe(2);
    expect(err(() => dispatch(ctx, human(alice), op(R.friends, id, { op: 'counter_add', blockId: c.blockId, delta: 1 })))?.code).toBe('op_kind_mismatch');
  });

  it('상한: 블록 8개, 선택지 6개, 체크 20개는 409 tool_full', () => {
    const ctx = makeCtx();
    const id = make(ctx, createCustom(R.friends));
    const { c, v } = get(ctx, R.friends, id);
    for (let i = 0; i < 5; i++) dispatch(ctx, human(alice), op(R.friends, id, { op: 'block_add', block: { type: 'text', text: `메모 ${i}` } }));
    expect(get(ctx, R.friends, id).t.blocks).toHaveLength(8);
    expect(err(() => dispatch(ctx, human(alice), op(R.friends, id, { op: 'block_add', block: { type: 'text', text: '9번째' } })))).toEqual({ status: 409, code: 'tool_full' });
    for (let i = 0; i < 4; i++) dispatch(ctx, human(alice), op(R.friends, id, { op: 'vote_option_add', blockId: v.blockId, text: `선택 ${i}` }));
    expect(err(() => dispatch(ctx, human(alice), op(R.friends, id, { op: 'vote_option_add', blockId: v.blockId, text: '7번째' })))?.code).toBe('tool_full');
    for (let i = 0; i < 18; i++) dispatch(ctx, human(alice), op(R.friends, id, { op: 'block_check_add', blockId: c.blockId, text: `일 ${i}` }));
    expect(err(() => dispatch(ctx, human(alice), op(R.friends, id, { op: 'block_check_add', blockId: c.blockId, text: '21번째' })))?.code).toBe('tool_full');
    // 블록 삭제 후 다시 추가 가능, 선택지 삭제는 사람만(표도 사라짐)
    dispatch(ctx, human(bob), op(R.friends, id, { op: 'block_remove', blockId: get(ctx, R.friends, id).t.blocks[3]!.blockId }));
    expect(get(ctx, R.friends, id).t.blocks).toHaveLength(7);
    const opt = get(ctx, R.friends, id).v.options[0].optionId;
    dispatch(ctx, human(alice), op(R.friends, id, { op: 'vote_cast', blockId: v.blockId, optionId: opt }));
    expect(err(() => dispatch(ctx, roomAgent, op(R.friends, id, { op: 'vote_option_remove', blockId: v.blockId, optionId: opt })))?.code).toBe('humans_only');
    dispatch(ctx, human(alice), op(R.friends, id, { op: 'vote_option_remove', blockId: v.blockId, optionId: opt }));
    expect(get(ctx, R.friends, id).v.votes).toEqual({});
  });

  it('재생: 같은 이벤트 로그를 다시 리듀싱해도 같은 투표·카운터 상태', () => {
    const ctx = makeCtx();
    const id = make(ctx, createCustom(R.friends));
    const { v, n } = get(ctx, R.friends, id);
    dispatch(ctx, human(alice), op(R.friends, id, { op: 'vote_cast', blockId: v.blockId, optionId: v.options[0].optionId }));
    dispatch(ctx, human(bob), op(R.friends, id, { op: 'counter_add', blockId: n.blockId, delta: 1 }));
    const a = toolOf<CustomT>(ctx, R.friends, id);
    const b = toolOf<CustomT>(ctx, R.friends, id);
    expect(b).toEqual(a);
    expect(a.blocks[1]).toMatchObject({ votes: { [alice]: v.options[0].optionId } });
    expect(a.blocks[2]).toMatchObject({ value: 1 });
  });
});

describe('보드 도구: REST', () => {
  it('생성 → 조작 → 삭제, 응답 형태와 검증 오류', async () => {
    const { app } = await makeApp();
    const token = await loginAs(app, 'Alice');
    const headers = auth(token);

    const bad = await app.inject({ method: 'POST', url: `/api/rooms/${R.friends}/tools`, headers, payload: { title: 'x', init: { kind: 'nope' } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code ?? bad.json().error).toBeTruthy();

    const created = await app.inject({
      method: 'POST',
      url: `/api/rooms/${R.friends}/tools`,
      headers,
      payload: { title: '커피 내기', init: { kind: 'ladder', participants: ['Alice', 'Bob'], outcomes: ['커피 사기'] } },
    });
    expect(created.statusCode).toBe(200);
    const { seq, toolId } = created.json() as { seq: number; toolId: string };
    expect(seq).toBeGreaterThan(0);
    expect(toolId).toMatch(/^t_/);

    const run = await app.inject({ method: 'POST', url: `/api/rooms/${R.friends}/tools/${toolId}/ops`, headers, payload: { op: { op: 'ladder_run' } } });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ toolId, op: 'ladder_run' });

    const again = await app.inject({ method: 'POST', url: `/api/rooms/${R.friends}/tools/${toolId}/ops`, headers, payload: { op: { op: 'ladder_run' } } });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('already_ran');

    const del = await app.inject({ method: 'DELETE', url: `/api/rooms/${R.friends}/tools/${toolId}`, headers });
    expect(del.statusCode).toBe(200);
    expect(del.json().seq).toBeGreaterThan(seq);

    const gone = await app.inject({ method: 'DELETE', url: `/api/rooms/${R.friends}/tools/${toolId}`, headers });
    expect(gone.statusCode).toBe(404);

    // 구성원이 아닌 사용자
    const bobToken = await loginAs(app, 'Bob');
    const denied = await app.inject({
      method: 'POST',
      url: `/api/rooms/${R.myAlice}/tools`,
      headers: auth(bobToken),
      payload: { title: 'x', init: { kind: 'trip' } },
    });
    expect(denied.statusCode).toBe(403);
  });
});
