import { z } from 'zod';
import {
  AGENT_TOOL_OPS,
  BOARD_TOOL_KINDS,
  BOARD_TOOL_LABEL,
  BOARD_TOOL_LIMITS,
  boardToolSummary,
  formatWon,
  settle,
  type BoardTool,
  type BoardToolInitInput,
  type BoardToolOpInput,
  type CustomBlockInput,
  type RoomEvent,
  voteTally,
} from '@ensemble/shared';
import type { Action } from '../domain/actions';
import { badRequest } from '../errors';
import type { ToolSpec } from './types';

/**
 * 보드 도구(사다리·정산표·여행 계획)를 Agent가 만들고 고치는 도구.
 * tools.ts와의 순환 import를 피하려고 공통 필드 정의를 이 파일에 따로 둔다(tools.ts를 import하지 않는다).
 * 실제 쓰기는 dispatch(create_board_tool / update_board_tool)가 하고, 권한·상한 검사도 거기서 한다.
 * 사다리 실행(ladder_run)·다시하기·도구 내리기는 Agent에 노출하지 않는다(사람만).
 */

const L = BOARD_TOOL_LIMITS;

const common = {
  public_rationale: z.string().max(500).optional(),
  owner_note: z.string().max(500).optional(),
  used_memory_ids: z.array(z.string()).max(20).optional(),
};
const COMMON_PROPS = {
  public_rationale: { type: 'string', description: '이 행동의 공개 근거(선택).' },
  owner_note: { type: 'string', description: '소유자에게만 남기는 메모(선택).' },
  used_memory_ids: { type: 'array', items: { type: 'string' }, description: '이번 턴에 제공된 기억 중 사용한 항목 id. 제공되지 않은 id는 거부된다.' },
};
const obj = <S extends z.ZodRawShape>(shape: S) => z.object({ ...shape, ...common }).strict();
const schema = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties: { ...properties, ...COMMON_PROPS },
  required,
  additionalProperties: false,
});

const str = z.string().min(1).max(40);

/** custom 블록(Agent 입력). 고정 4종·strict — HTML/URL/스타일 같은 필드는 받지 않는다 */
const BlockArg = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(L.customTextChars) }),
  z.strictObject({
    type: z.literal('checklist'),
    title: z.string().min(1).max(L.customLabelChars),
    items: z.array(z.string().min(1).max(60)).max(L.customChecklist).optional(),
  }),
  z.strictObject({
    type: z.literal('vote'),
    question: z.string().min(1).max(L.customLabelChars),
    options: z.array(z.string().min(1).max(L.customOptionChars)).max(L.customVoteOptions).optional(),
  }),
  z.strictObject({
    type: z.literal('counter'),
    label: z.string().min(1).max(L.customLabelChars),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
  }),
]);
type BlockArgT = z.infer<typeof BlockArg>;

const BLOCK_JSON = {
  type: 'object',
  description:
    '고정 블록 4종 중 하나. text{text} / checklist{title, items?: string[]} / vote{question, options?: string[]} / counter{label, min?, max?}. 이 필드 외의 것(HTML·URL·스타일)은 넣을 수 없다.',
  properties: {
    type: { type: 'string', enum: ['text', 'checklist', 'vote', 'counter'] },
    text: { type: 'string' },
    title: { type: 'string' },
    items: { type: 'array', items: { type: 'string' } },
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
    label: { type: 'string' },
    min: { type: 'integer' },
    max: { type: 'integer' },
  },
  required: ['type'],
  additionalProperties: false,
} as const;

export const BOARD_TOOL_INPUT_SCHEMAS = {
  create_board_tool: obj({
    kind: z.enum(BOARD_TOOL_KINDS),
    title: z.string().min(1).max(80),
    participants: z.array(str).max(L.participants).optional(),
    outcomes: z.array(str).max(L.outcomes).optional(),
    expenses: z
      .array(
        z
          .object({
            payer: str,
            amount: z.number().int().min(1).max(L.amountMax),
            label: z.string().max(60).optional(),
            split_among: z.array(str).max(L.participants).optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    days: z.number().int().min(1).max(L.tripDays).optional(),
    start_date: z.string().optional(),
    items: z
      .array(
        z
          .object({
            day: z.number().int().min(1).max(L.tripDays),
            time: z.string().optional(),
            place: z.string().min(1).max(60),
            memo: z.string().max(120).optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    checklist: z.array(z.string().min(1).max(60)).max(20).optional(),
    blocks: z.array(BlockArg).max(L.customBlocks).optional(),
    room_message: z.string().min(1).max(300).optional(),
  }),
  update_board_tool: obj({
    tool_id: z.string().min(1),
    op: z.enum(AGENT_TOOL_OPS),
    title: z.string().min(1).max(80).optional(),
    participants: z.array(str).max(L.participants).optional(),
    outcomes: z.array(str).max(L.outcomes).optional(),
    payer: str.optional(),
    amount: z.number().int().min(1).max(L.amountMax).optional(),
    label: z.string().max(60).optional(),
    split_among: z.array(str).max(L.participants).optional(),
    expense_id: z.string().min(1).optional(),
    day: z.number().int().min(1).max(L.tripDays).optional(),
    time: z.string().optional(),
    place: z.string().min(1).max(60).optional(),
    memo: z.string().max(120).optional(),
    item_id: z.string().min(1).optional(),
    text: z.string().min(1).max(60).optional(),
    check_id: z.string().min(1).optional(),
    done: z.boolean().optional(),
    block_id: z.string().min(1).optional(),
    block: BlockArg.optional(),
    room_message: z.string().min(1).max(300).optional(),
  }),
} as const;

export type BoardToolToolName = keyof typeof BOARD_TOOL_INPUT_SCHEMAS;
export const isBoardToolTool = (n: string): n is BoardToolToolName => n in BOARD_TOOL_INPUT_SCHEMAS;

const strArr = (description?: string) => ({ type: 'array', items: { type: 'string' }, ...(description ? { description } : {}) });

export const BOARD_TOOL_DEFS: Record<BoardToolToolName, ToolSpec> = {
  create_board_tool: {
    name: 'create_board_tool',
    description:
      "보드(탁자)에 함께 쓰는 도구를 올려놓는다. ladder=누가 할지/살지 정하는 사다리타기(participants=참가자 이름, outcomes=결과 항목, 모자라면 '꽝'으로 채움, 실행은 사람이 한다), settlement=돈 정산표(expenses: 누가 얼마 냈고 누구 몫인지), trip=여행·일정 계획(days, items: 일차·시간·장소, checklist: 준비물), custom=위 셋에 맞지 않는 요청(투표, 할 일 나누기, 간단한 체크 등)을 위한 메모판(blocks: text/checklist/vote/counter 블록 조합, 대화에 나온 내용만 담고 지어내지 않는다). 같은 종류 도구가 [보드 도구]에 있으면 새로 만들지 말고 update_board_tool을 쓴다. room_message에는 방에 남길 안내 한 문장.",
    inputSchema: schema(
      {
        kind: { type: 'string', enum: [...BOARD_TOOL_KINDS] },
        title: { type: 'string' },
        participants: strArr('ladder/settlement 참가자 이름. 대화 상대의 사람 이름만.'),
        outcomes: strArr('ladder 결과 항목'),
        expenses: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              payer: { type: 'string' },
              amount: { type: 'integer', description: '원 단위. 대화에 나온 금액만.' },
              label: { type: 'string' },
              split_among: strArr('나눠 낼 사람(생략하면 참가자 전원)'),
            },
            required: ['payer', 'amount'],
            additionalProperties: false,
          },
        },
        days: { type: 'integer', description: 'trip 일수(기본 1)' },
        start_date: { type: 'string', description: 'trip 시작일 YYYY-MM-DD(선택)' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { day: { type: 'integer' }, time: { type: 'string', description: 'HH:MM' }, place: { type: 'string' }, memo: { type: 'string' } },
            required: ['day', 'place'],
            additionalProperties: false,
          },
        },
        checklist: strArr('trip 준비물'),
        blocks: { type: 'array', items: BLOCK_JSON, description: 'custom 블록 목록(1~8개). 투표 선택지는 대화에 나온 것만, 없으면 options를 비워 사람이 추가하게 한다.' },
        room_message: { type: 'string', description: '방에 함께 남길 짧은 안내 한 문장(선택, 권장).' },
      },
      ['kind', 'title'],
    ),
  },
  update_board_tool: {
    name: 'update_board_tool',
    description:
      '[보드 도구]의 도구 항목을 추가·삭제·체크한다. tool_id와 항목·블록 id는 [보드 도구]의 대괄호·괄호 안 id만 쓴다. 사다리 실행·투표·카운터는 사람만 할 수 있다.',
    inputSchema: schema(
      {
        tool_id: { type: 'string' },
        op: { type: 'string', enum: [...AGENT_TOOL_OPS], description: 'title_set(title) / ladder_set(participants, outcomes) / expense_add(payer, amount, label?, split_among?) / expense_remove(expense_id) / trip_item_add(day, place, time?, memo?) / trip_item_remove(item_id) / check_add(text) / check_set(check_id, done) / check_remove(check_id) / [custom] block_add(block) / block_remove(block_id) / block_check_add(block_id, text) / block_check_set(block_id, check_id, done) / block_check_remove(block_id, check_id) / vote_option_add(block_id, text). 투표·카운터는 사람만 한다.' },
        title: { type: 'string' },
        participants: strArr(),
        outcomes: strArr(),
        payer: { type: 'string' },
        amount: { type: 'integer' },
        label: { type: 'string' },
        split_among: strArr(),
        expense_id: { type: 'string' },
        day: { type: 'integer' },
        time: { type: 'string', description: 'HH:MM' },
        place: { type: 'string' },
        memo: { type: 'string' },
        item_id: { type: 'string' },
        text: { type: 'string' },
        check_id: { type: 'string' },
        done: { type: 'boolean' },
        block_id: { type: 'string', description: 'custom 블록 id([보드 도구]의 b_...)' },
        block: BLOCK_JSON,
        room_message: { type: 'string', description: '방에 함께 남길 짧은 안내 한 문장(선택).' },
      },
      ['tool_id', 'op'],
    ),
  },
};

/* ------------------------------ 실행 ------------------------------ */

/** LLM 관용: "9:30" → "09:30", 형식이 다르면 버린다 */
export function normalizeTime(t: string | undefined): string | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec((t ?? '').trim());
  return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : undefined;
}
const normalizeDate = (d: string | undefined) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d.trim()) ? d.trim() : undefined);

function need<T>(v: T | undefined, field: string, op: string): T {
  if (v === undefined) throw badRequest('invalid_tool_input', `${op}에는 ${field}가 필요합니다`);
  return v;
}

function toBlock(b: BlockArgT): CustomBlockInput {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'checklist':
      return { type: 'checklist', title: b.title, items: b.items ?? [] };
    case 'vote':
      return { type: 'vote', question: b.question, options: b.options ?? [] };
    case 'counter':
      return { type: 'counter', label: b.label, ...(b.min !== undefined ? { min: b.min } : {}), ...(b.max !== undefined ? { max: b.max } : {}) };
  }
}

type CreateInput = z.infer<(typeof BOARD_TOOL_INPUT_SCHEMAS)['create_board_tool']>;
type UpdateInput = z.infer<(typeof BOARD_TOOL_INPUT_SCHEMAS)['update_board_tool']>;

export function toInit(i: CreateInput): BoardToolInitInput {
  switch (i.kind) {
    case 'ladder':
      if (!i.participants || i.participants.length < 2) throw badRequest('invalid_tool_input', 'ladder에는 participants가 2명 이상 필요합니다');
      return { kind: 'ladder', participants: i.participants, outcomes: i.outcomes?.length ? i.outcomes : ['당첨'] };
    case 'settlement':
      return {
        kind: 'settlement',
        participants: i.participants ?? [],
        expenses: (i.expenses ?? []).map((e) => ({
          payer: e.payer,
          amount: e.amount,
          ...(e.label ? { label: e.label } : {}),
          ...(e.split_among?.length ? { splitAmong: e.split_among } : {}),
        })),
      };
    case 'trip':
      return {
        kind: 'trip',
        days: i.days ?? 1,
        ...(normalizeDate(i.start_date) ? { startDate: normalizeDate(i.start_date) } : {}),
        items: (i.items ?? []).map((x) => ({
          day: x.day,
          place: x.place,
          ...(normalizeTime(x.time) ? { time: normalizeTime(x.time) } : {}),
          ...(x.memo ? { memo: x.memo } : {}),
        })),
        checklist: i.checklist ?? [],
      };
    case 'custom':
      if (!i.blocks || i.blocks.length === 0) throw badRequest('invalid_tool_input', 'custom에는 blocks가 1개 이상 필요합니다');
      return { kind: 'custom', blocks: i.blocks.map(toBlock) };
  }
}

export function toOp(i: UpdateInput): BoardToolOpInput {
  switch (i.op) {
    case 'title_set':
      return { op: 'title_set', title: need(i.title, 'title', i.op) };
    case 'ladder_set':
      return { op: 'ladder_set', participants: need(i.participants, 'participants', i.op), outcomes: need(i.outcomes, 'outcomes', i.op) };
    case 'expense_add':
      return {
        op: 'expense_add',
        payer: need(i.payer, 'payer', i.op),
        amount: need(i.amount, 'amount', i.op),
        ...(i.label ? { label: i.label } : {}),
        ...(i.split_among?.length ? { splitAmong: i.split_among } : {}),
      };
    case 'expense_remove':
      return { op: 'expense_remove', expenseId: need(i.expense_id, 'expense_id', i.op) };
    case 'trip_item_add':
      return {
        op: 'trip_item_add',
        day: need(i.day, 'day', i.op),
        place: need(i.place, 'place', i.op),
        ...(normalizeTime(i.time) ? { time: normalizeTime(i.time) } : {}),
        ...(i.memo ? { memo: i.memo } : {}),
      };
    case 'trip_item_remove':
      return { op: 'trip_item_remove', itemId: need(i.item_id, 'item_id', i.op) };
    case 'check_add':
      return { op: 'check_add', text: need(i.text, 'text', i.op) };
    case 'check_set':
      return { op: 'check_set', checkId: need(i.check_id, 'check_id', i.op), done: need(i.done, 'done', i.op) };
    case 'check_remove':
      return { op: 'check_remove', checkId: need(i.check_id, 'check_id', i.op) };
    case 'block_add':
      return { op: 'block_add', block: toBlock(need(i.block, 'block', i.op)) };
    case 'block_remove':
      return { op: 'block_remove', blockId: need(i.block_id, 'block_id', i.op) };
    case 'block_check_add':
      return { op: 'block_check_add', blockId: need(i.block_id, 'block_id', i.op), text: need(i.text, 'text', i.op) };
    case 'block_check_set':
      return {
        op: 'block_check_set',
        blockId: need(i.block_id, 'block_id', i.op),
        checkId: need(i.check_id, 'check_id', i.op),
        done: need(i.done, 'done', i.op),
      };
    case 'block_check_remove':
      return { op: 'block_check_remove', blockId: need(i.block_id, 'block_id', i.op), checkId: need(i.check_id, 'check_id', i.op) };
    case 'vote_option_add':
      return { op: 'vote_option_add', blockId: need(i.block_id, 'block_id', i.op), text: need(i.text, 'text', i.op) };
  }
}

type Run = (action: Action) => { data?: Record<string, unknown> };

/**
 * create_board_tool / update_board_tool 실행. 입력(이미 zod 검증됨)을 Action으로 바꿔 run(dispatch)한다.
 * room_message가 있으면 도구가 만들어진 뒤에만 남기고, 실패해도 도구는 유지한다(request_approval과 같은 패턴).
 */
export function executeBoardToolCall(
  roomId: string,
  name: BoardToolToolName,
  input: CreateInput | UpdateInput,
  run: Run,
): { result: 'acted'; tool: BoardToolToolName; data?: Record<string, unknown> } {
  let data: Record<string, unknown> | undefined;
  if (name === 'create_board_tool') {
    const i = input as CreateInput;
    data = run({ type: 'create_board_tool', roomId, title: i.title, init: toInit(i) }).data;
  } else {
    const i = input as UpdateInput;
    data = run({ type: 'update_board_tool', roomId, toolId: i.tool_id, op: toOp(i) }).data;
  }
  const msg = (input as { room_message?: string }).room_message?.trim();
  if (msg) {
    try {
      run({ type: 'send_message', roomId, text: msg });
    } catch (err) {
      console.error('[agent] room_message failed', err);
    }
  }
  return { result: 'acted', tool: name, data };
}

/* ------------------------------ 프롬프트 렌더 ------------------------------ */

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** [보드 도구] 섹션 줄. 예산 자르기는 호출자(prompts.ts)가 한다. */
export function renderBoardTools(tools: readonly BoardTool[]): string[] {
  return tools.map((t) => {
    const head = `[${t.toolId}] ${BOARD_TOOL_LABEL[t.kind]} "${clip(t.title, 60)}"`;
    switch (t.kind) {
      case 'ladder':
        return `${head} 참가: ${t.participants.join(', ')} / 결과: ${t.outcomes.join(', ')} / ${t.run ? `실행됨(${boardToolSummary(t)})` : '실행 전'}`;
      case 'settlement': {
        const ex = t.expenses.map((e) => `(${e.expenseId}) ${e.payer} ${formatWon(e.amount)} ${e.label ? `${clip(e.label, 20)} ` : ''}[${e.splitAmong.join(',')}]`);
        const transfers = settle(t).transfers.map((x) => `${x.from}→${x.to} ${formatWon(x.amount)}`);
        return `${head} 지출: ${ex.length ? ex.join('; ') : '(없음)'}${transfers.length ? ` / 정산: ${transfers.join(', ')}` : ''}`;
      }
      case 'trip': {
        const byDay = new Map<number, string[]>();
        for (const it of t.items) {
          const a = byDay.get(it.day) ?? [];
          a.push(`(${it.itemId}) ${it.time ? `${it.time} ` : ''}${clip(it.place, 30)}`);
          byDay.set(it.day, a);
        }
        const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([d, xs]) => `${d}일차: ${xs.join(', ')}`);
        const checks = t.checklist.map((c) => `(${c.checkId})[${c.done ? 'x' : ' '}] ${clip(c.text, 30)}`);
        return `${head} ${days.length ? days.join(' / ') : '일정 없음'}${checks.length ? ` / 준비물: ${checks.join(', ')}` : ''}`;
      }
      case 'custom': {
        // 투표는 집계만 싣는다(누가 무엇에 투표했는지는 프롬프트에 넣지 않는다)
        const blocks = t.blocks.map((b) => {
          switch (b.type) {
            case 'text':
              return `[${b.blockId}] 글: ${clip(b.text, 60)}`;
            case 'checklist':
              return `[${b.blockId}] 체크 "${clip(b.title, 30)}": ${b.items.map((c) => `(${c.checkId})[${c.done ? 'x' : ' '}] ${clip(c.text, 30)}`).join(', ') || '(항목 없음)'}`;
            case 'vote': {
              const tally = voteTally(b);
              return `[${b.blockId}] 투표 "${clip(b.question, 40)}": ${b.options.map((o) => `(${o.optionId}) ${clip(o.text, 20)} ${tally[o.optionId] ?? 0}표`).join(', ') || '(선택지 없음)'}`;
            }
            case 'counter':
              return `[${b.blockId}] 카운터 "${clip(b.label, 30)}": ${b.value}`;
          }
        });
        return `${head} ${blocks.join(' / ')}`;
      }
    }
  });
}

export function renderBoardToolEvent(e: RoomEvent, who: string): string | null {
  switch (e.type) {
    case 'board_tool_created':
      return `#${e.seq} ${who}가 보드에 ${BOARD_TOOL_LABEL[e.init.kind]} 올림 [${e.toolId}] "${clip(e.title, 60)}"`;
    case 'board_tool_updated':
      if (e.op.op === 'cover_set') return null; // 커버 이미지 상태는 대화 맥락이 아니다
      return `#${e.seq} ${who}가 보드 도구 [${e.toolId}] 수정: ${e.op.op === 'ladder_run' ? '사다리 실행됨' : e.op.op === 'ladder_reset' ? '사다리 다시 하기' : e.op.op}`;
    case 'board_tool_removed':
      return `#${e.seq} ${who}가 보드 도구 [${e.toolId}]를 내림`;
    default:
      return null;
  }
}

/** system [도구 선택 기준]에 덧붙이는 규칙. 도구 목록에 create_board_tool이 있을 때만 쓴다. */
export const BOARD_TOOL_RULES: readonly string[] = [
  '- "누가 살지·할지 정하자", 내기, 제비뽑기 같은 말: create_board_tool(kind=ladder). participants는 [대화 상대 id]의 사람 이름만 쓴다. 결과를 말로 정하지 않는다(사다리 실행은 사람이 한다).',
  '- "얼마씩 내?", 정산, n빵, 더치페이: create_board_tool(kind=settlement). 대화에 나온 금액·지불자만 expenses에 넣고 지어내지 않는다(없으면 빈 정산표).',
  '- "여행 가자", 일정 짜자, 나들이: create_board_tool(kind=trip). 대화에 나온 장소·시간만 items에, 준비물은 checklist에 넣는다. 날짜·장소를 지어내지 않는다.',
  '- 위 3종에 맞지 않는 요청(투표, 할 일 나누기, 간단한 체크, 횟수 세기 등)은 create_board_tool(kind=custom, blocks=[text|checklist|vote|counter]). 대화에 나온 선택지·할 일만 넣고 지어내지 않는다(투표 선택지가 없으면 options를 비워 사람이 추가한다). 투표와 카운터는 사람만 조작한다.',
  '- [보드 도구]에 같은 종류가 이미 있으면 새로 만들지 말고 update_board_tool을 쓴다. 만들거나 고칠 때 room_message로 방에 안내 한 문장을 함께 남긴다(별도 say 없음).',
  '- 도구는 결정을 대신하지 않는다: 날짜·장소·금액을 확정하는 일은 여전히 request_approval.',
];
