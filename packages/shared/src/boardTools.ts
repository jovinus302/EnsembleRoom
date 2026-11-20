import { z } from 'zod';
// 순환 방지: events.ts가 이 파일을 값으로 import 하므로 여기서는 type만 가져온다.
import type { ActorKind, OwnerTag } from './events';

/**
 * 보드 도구(사다리타기·정산표·여행 계획·자유형 custom). 순수 모듈: 스키마, 결정적 사다리, 정산 계산, 리듀서용 op 적용.
 * 주의: z.discriminatedUnion 멤버에는 .refine을 쓰지 않는다(zod v4에서 판별 실패). 상호 제약은 서버 authorize에서.
 */

/* ------------------------------------------------------------------ */
/* 상수                                                                 */
/* ------------------------------------------------------------------ */

export const BOARD_TOOL_KINDS = ['ladder', 'settlement', 'trip', 'custom'] as const;
export const BoardToolKindSchema = z.enum(BOARD_TOOL_KINDS);
export type BoardToolKind = z.infer<typeof BoardToolKindSchema>;

export const BOARD_TOOL_LIMITS = {
  toolsPerRoom: 12,
  participants: 8,
  outcomes: 8,
  ladderRows: 8,
  expenses: 40,
  tripItems: 40,
  checklist: 30,
  tripDays: 14,
  amountMax: 100_000_000,
  /** custom(자유형): 블록 수·문자 길이 상한 */
  customBlocks: 8,
  customChecklist: 20,
  customVoteOptions: 6,
  customTextChars: 300,
  customLabelChars: 80,
  customOptionChars: 40,
  counterRange: 1_000_000,
  counterStep: 10,
} as const;

export const BOARD_TOOL_LABEL: Readonly<Record<BoardToolKind, string>> = {
  ladder: '사다리타기',
  settlement: '정산표',
  trip: '여행 계획',
  custom: '메모판',
};

const L = BOARD_TOOL_LIMITS;

/* ------------------------------------------------------------------ */
/* 저장 형태 (이벤트에 실린다: id 채워짐·정규화)                            */
/* ------------------------------------------------------------------ */

const Name = z.string().min(1).max(40);
const TimeStr = z.string().regex(/^\d{2}:\d{2}$/);
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Amount = z.number().int().min(1).max(L.amountMax);
const Id = z.string().min(1).max(40);

export const COVER_STATUSES = ['pending', 'ready', 'failed'] as const;
export type CoverStatus = (typeof COVER_STATUSES)[number];
/** 로컬 캐시 이미지 id. 서버가 만든 값만 통과한다 */
export const COVER_ASSET_ID = /^m_[0-9a-f]{16}$/;

export const ExpenseSchema = z.object({
  expenseId: Id,
  label: z.string().max(60),
  payer: Name,
  amount: Amount,
  splitAmong: z.array(Name).min(1).max(L.participants),
});
export type Expense = z.infer<typeof ExpenseSchema>;

export const TripItemSchema = z.object({
  itemId: Id,
  day: z.number().int().min(1).max(L.tripDays),
  time: TimeStr.optional(),
  place: z.string().min(1).max(60),
  memo: z.string().max(120).optional(),
});
export type TripItem = z.infer<typeof TripItemSchema>;

export const CheckItemSchema = z.object({
  checkId: Id,
  text: z.string().min(1).max(60),
  done: z.boolean(),
});
export type CheckItem = z.infer<typeof CheckItemSchema>;

/* ---- custom(자유형) 블록: 고정 4종, 모든 객체 .strict(). HTML/URL/스타일 필드는 스키마에 없다 ---- */

const CustomLabel = z.string().min(1).max(L.customLabelChars);
const CounterBound = z.number().int().min(-L.counterRange).max(L.counterRange);

export const CustomCheckSchema = z.strictObject({
  checkId: Id,
  text: z.string().min(1).max(60),
  done: z.boolean(),
});
export const VoteOptionSchema = z.strictObject({
  optionId: Id,
  text: z.string().min(1).max(L.customOptionChars),
});
export type VoteOption = z.infer<typeof VoteOptionSchema>;

/** 이벤트에 저장되는 블록(초기 상태). 투표 내역·카운터 값은 리듀서 상태에만 있다 */
export const CustomBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), blockId: Id, text: z.string().min(1).max(L.customTextChars) }),
  z.strictObject({
    type: z.literal('checklist'),
    blockId: Id,
    title: CustomLabel,
    items: z.array(CustomCheckSchema).max(L.customChecklist),
  }),
  z.strictObject({
    type: z.literal('vote'),
    blockId: Id,
    question: CustomLabel,
    options: z.array(VoteOptionSchema).max(L.customVoteOptions),
  }),
  z.strictObject({
    type: z.literal('counter'),
    blockId: Id,
    label: CustomLabel,
    min: CounterBound.optional(),
    max: CounterBound.optional(),
  }),
]);
export type CustomBlockInit = z.infer<typeof CustomBlockSchema>;

export const BoardToolInitSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ladder'),
    participants: z.array(Name).min(2).max(L.participants),
    outcomes: z.array(Name).min(2).max(L.outcomes),
  }),
  z.object({
    kind: z.literal('settlement'),
    participants: z.array(Name).max(L.participants),
    expenses: z.array(ExpenseSchema).max(L.expenses),
  }),
  z.object({
    kind: z.literal('trip'),
    days: z.number().int().min(1).max(L.tripDays),
    startDate: DateStr.optional(),
    items: z.array(TripItemSchema).max(L.tripItems),
    checklist: z.array(CheckItemSchema).max(L.checklist),
  }),
  z.strictObject({
    kind: z.literal('custom'),
    blocks: z.array(CustomBlockSchema).min(1).max(L.customBlocks),
  }),
]);
export type BoardToolInit = z.infer<typeof BoardToolInitSchema>;

export const BoardToolOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('title_set'), title: z.string().min(1).max(80) }),
  z.object({
    op: z.literal('ladder_set'),
    participants: z.array(Name).min(2).max(L.participants),
    outcomes: z.array(Name).min(2).max(L.outcomes),
  }),
  z.object({ op: z.literal('ladder_run'), seed: z.number().int().min(0).max(0xffffffff) }),
  z.object({ op: z.literal('ladder_reset') }),
  z.object({ op: z.literal('expense_add'), expense: ExpenseSchema }),
  z.object({ op: z.literal('expense_remove'), expenseId: Id }),
  z.object({ op: z.literal('trip_item_add'), item: TripItemSchema }),
  z.object({ op: z.literal('trip_item_remove'), itemId: Id }),
  z.object({ op: z.literal('check_add'), check: CheckItemSchema }),
  z.object({ op: z.literal('check_set'), checkId: Id, done: z.boolean() }),
  z.object({ op: z.literal('check_remove'), checkId: Id }),
  z.strictObject({ op: z.literal('block_add'), block: CustomBlockSchema }),
  z.strictObject({ op: z.literal('block_remove'), blockId: Id }),
  z.strictObject({ op: z.literal('block_check_add'), blockId: Id, check: CustomCheckSchema }),
  z.strictObject({ op: z.literal('block_check_set'), blockId: Id, checkId: Id, done: z.boolean() }),
  z.strictObject({ op: z.literal('block_check_remove'), blockId: Id, checkId: Id }),
  z.strictObject({ op: z.literal('vote_option_add'), blockId: Id, option: VoteOptionSchema }),
  z.strictObject({ op: z.literal('vote_option_remove'), blockId: Id, optionId: Id }),
  /** 투표자는 이벤트 actor(사람 userId). 사람당 1표, 다시 던지면 변경 */
  z.strictObject({ op: z.literal('vote_cast'), blockId: Id, optionId: Id }),
  z.strictObject({
    op: z.literal('counter_add'),
    blockId: Id,
    delta: z.number().int().min(-L.counterStep).max(L.counterStep),
  }),
  /** 커버 이미지 상태. 서버 시스템만 남긴다(REST·Agent 입력 스키마에는 없다). 외부 URL은 담지 않는다 */
  z.strictObject({
    op: z.literal('cover_set'),
    status: z.enum(COVER_STATUSES),
    assetId: z.string().regex(COVER_ASSET_ID).optional(),
  }),
]);
export type BoardToolOp = z.infer<typeof BoardToolOpSchema>;
export type BoardToolOpName = BoardToolOp['op'];

/** op → 대상 도구 종류(들) (title_set은 모든 종류) */
export const OP_KIND: Readonly<Record<BoardToolOpName, BoardToolKind | readonly BoardToolKind[] | null>> = {
  title_set: null,
  ladder_set: 'ladder',
  ladder_run: 'ladder',
  ladder_reset: 'ladder',
  expense_add: 'settlement',
  expense_remove: 'settlement',
  trip_item_add: 'trip',
  trip_item_remove: 'trip',
  check_add: 'trip',
  check_set: 'trip',
  check_remove: 'trip',
  block_add: 'custom',
  block_remove: 'custom',
  block_check_add: 'custom',
  block_check_set: 'custom',
  block_check_remove: 'custom',
  vote_option_add: 'custom',
  vote_option_remove: 'custom',
  vote_cast: 'custom',
  counter_add: 'custom',
  cover_set: ['trip', 'custom'],
};

/** 커버 이미지를 붙일 수 있는 도구 종류 */
export const COVER_KINDS: readonly BoardToolKind[] = ['trip', 'custom'];

/** Agent가 쓸 수 있는 op: 사다리 실행·다시하기는 사람만 */
export const AGENT_TOOL_OPS = [
  'title_set',
  'ladder_set',
  'expense_add',
  'expense_remove',
  'trip_item_add',
  'trip_item_remove',
  'check_add',
  'check_set',
  'check_remove',
  'block_add',
  'block_remove',
  'block_check_add',
  'block_check_set',
  'block_check_remove',
  'vote_option_add',
] as const satisfies readonly BoardToolOpName[];

/* ------------------------------------------------------------------ */
/* 입력 형태 (REST·Agent → 서버. id·seed 없음)                            */
/* ------------------------------------------------------------------ */

const ExpenseInputShape = {
  label: z.string().max(60).optional(),
  payer: Name,
  amount: Amount,
  splitAmong: z.array(Name).min(1).max(L.participants).optional(),
};
const TripItemInputShape = {
  day: z.number().int().min(1).max(L.tripDays),
  time: TimeStr.optional(),
  place: z.string().min(1).max(60),
  memo: z.string().max(120).optional(),
};

const CustomBlockInputSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(L.customTextChars) }),
  z.strictObject({
    type: z.literal('checklist'),
    title: CustomLabel,
    items: z.array(z.string().min(1).max(60)).max(L.customChecklist).default([]),
  }),
  z.strictObject({
    type: z.literal('vote'),
    question: CustomLabel,
    /** 비어 있으면 사람이 추가한다 */
    options: z.array(z.string().min(1).max(L.customOptionChars)).max(L.customVoteOptions).default([]),
  }),
  z.strictObject({ type: z.literal('counter'), label: CustomLabel, min: CounterBound.optional(), max: CounterBound.optional() }),
]);
export type CustomBlockInput = z.output<typeof CustomBlockInputSchema>;

export const BoardToolInitInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ladder'),
    participants: z.array(Name).min(2).max(L.participants),
    /** 모자라면 '꽝'으로 채운다 */
    outcomes: z.array(Name).min(1).max(L.outcomes),
  }),
  z.object({
    kind: z.literal('settlement'),
    participants: z.array(Name).max(L.participants).default([]),
    expenses: z.array(z.object(ExpenseInputShape)).max(L.expenses).default([]),
  }),
  z.object({
    kind: z.literal('trip'),
    days: z.number().int().min(1).max(L.tripDays).default(1),
    startDate: DateStr.optional(),
    items: z.array(z.object(TripItemInputShape)).max(L.tripItems).default([]),
    checklist: z.array(z.string().min(1).max(60)).max(L.checklist).default([]),
  }),
  z.strictObject({
    kind: z.literal('custom'),
    blocks: z.array(CustomBlockInputSchema).min(1).max(L.customBlocks),
  }),
]);
export type BoardToolInitInput = z.output<typeof BoardToolInitInputSchema>;

export const BoardToolOpInputSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('title_set'), title: z.string().min(1).max(80) }),
  z.object({
    op: z.literal('ladder_set'),
    participants: z.array(Name).min(2).max(L.participants),
    outcomes: z.array(Name).min(1).max(L.outcomes),
  }),
  z.object({ op: z.literal('ladder_run') }),
  z.object({ op: z.literal('ladder_reset') }),
  z.object({ op: z.literal('expense_add'), ...ExpenseInputShape }),
  z.object({ op: z.literal('expense_remove'), expenseId: Id }),
  z.object({ op: z.literal('trip_item_add'), ...TripItemInputShape }),
  z.object({ op: z.literal('trip_item_remove'), itemId: Id }),
  z.object({ op: z.literal('check_add'), text: z.string().min(1).max(60) }),
  z.object({ op: z.literal('check_set'), checkId: Id, done: z.boolean() }),
  z.object({ op: z.literal('check_remove'), checkId: Id }),
  z.strictObject({ op: z.literal('block_add'), block: CustomBlockInputSchema }),
  z.strictObject({ op: z.literal('block_remove'), blockId: Id }),
  z.strictObject({ op: z.literal('block_check_add'), blockId: Id, text: z.string().min(1).max(60) }),
  z.strictObject({ op: z.literal('block_check_set'), blockId: Id, checkId: Id, done: z.boolean() }),
  z.strictObject({ op: z.literal('block_check_remove'), blockId: Id, checkId: Id }),
  z.strictObject({ op: z.literal('vote_option_add'), blockId: Id, text: z.string().min(1).max(L.customOptionChars) }),
  z.strictObject({ op: z.literal('vote_option_remove'), blockId: Id, optionId: Id }),
  z.strictObject({ op: z.literal('vote_cast'), blockId: Id, optionId: Id }),
  z.strictObject({
    op: z.literal('counter_add'),
    blockId: Id,
    delta: z.number().int().min(-L.counterStep).max(L.counterStep),
  }),
]);
export type BoardToolOpInput = z.output<typeof BoardToolOpInputSchema>;

export const CreateBoardToolRequestSchema = z.object({
  title: z.string().min(1).max(80),
  init: BoardToolInitInputSchema,
});
export type CreateBoardToolRequest = z.input<typeof CreateBoardToolRequestSchema>;

export const BoardToolOpRequestSchema = z.object({ op: BoardToolOpInputSchema });
export type BoardToolOpRequest = z.input<typeof BoardToolOpRequestSchema>;

/* ------------------------------------------------------------------ */
/* 상태 타입                                                             */
/* ------------------------------------------------------------------ */

export interface ToolActor {
  kind: ActorKind;
  id: string | null;
}

export interface ToolCover {
  status: CoverStatus;
  /** ready일 때만. 로컬 캐시 파일 id(/api/media/:assetId) */
  assetId: string | null;
}

export interface ToolBase {
  toolId: string;
  title: string;
  ownerTag: OwnerTag;
  createdBy: ToolActor;
  createdSeq: number;
  updatedSeq: number;
  removed: boolean;
  /** 적용된 op 수 */
  rev: number;
  /** 커버 이미지(trip·custom, 선택 기능). null = 시도 전(기능이 꺼져 있으면 계속 null) */
  cover: ToolCover | null;
}

/** col 열과 col+1 열을 잇는 가로줄 */
export interface LadderRung {
  row: number;
  col: number;
}

export interface LadderRun {
  seed: number;
  seq: number;
  by: ToolActor;
  rungs: LadderRung[];
  /** 참가자 i → outcome index */
  result: number[];
}

export interface LadderTool extends ToolBase {
  kind: 'ladder';
  participants: string[];
  outcomes: string[];
  run: LadderRun | null;
}
export interface SettlementTool extends ToolBase {
  kind: 'settlement';
  participants: string[];
  expenses: Expense[];
}
export interface TripTool extends ToolBase {
  kind: 'trip';
  days: number;
  startDate: string | null;
  items: TripItem[];
  checklist: CheckItem[];
}
export interface TextBlock {
  type: 'text';
  blockId: string;
  text: string;
}
export interface ChecklistBlock {
  type: 'checklist';
  blockId: string;
  title: string;
  items: CheckItem[];
}
export interface VoteBlock {
  type: 'vote';
  blockId: string;
  question: string;
  options: VoteOption[];
  /** 투표자 userId → optionId (사람당 1표) */
  votes: Record<string, string>;
}
export interface CounterBlock {
  type: 'counter';
  blockId: string;
  label: string;
  min: number | null;
  max: number | null;
  value: number;
}
export type CustomBlock = TextBlock | ChecklistBlock | VoteBlock | CounterBlock;
export type CustomBlockType = CustomBlock['type'];

export interface CustomTool extends ToolBase {
  kind: 'custom';
  blocks: CustomBlock[];
}
export type BoardTool = LadderTool | SettlementTool | TripTool | CustomTool;

/** 투표 집계: optionId → 표 수 */
export function voteTally(block: VoteBlock): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(block.options.map((o) => [o.optionId, 0]));
  for (const optionId of Object.values(block.votes)) if (optionId in out) out[optionId] = (out[optionId] ?? 0) + 1;
  return out;
}

const clampCounter = (v: number, min: number | null, max: number | null) =>
  Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));

/* ------------------------------------------------------------------ */
/* 사다리 (결정적)                                                        */
/* ------------------------------------------------------------------ */

/** 엔진 간 동일한 PRNG. Math.random 사용 금지 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * seed → 가로줄. row×col 순회, rnd()<0.5이고 같은 row의 col-1에 없을 때 배치.
 * 인접 열 쌍에 가로줄이 하나도 없으면 결정적으로 하나 보정한다.
 */
export function ladderRungs(seed: number, n: number, rows: number = L.ladderRows): LadderRung[] {
  const rnd = mulberry32(seed);
  const has = new Set<string>();
  const key = (row: number, col: number) => `${row}:${col}`;
  const rungs: LadderRung[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < n - 1; col++) {
      if (rnd() < 0.5 && !has.has(key(row, col - 1))) {
        has.add(key(row, col));
        rungs.push({ row, col });
      }
    }
  }
  for (let col = 0; col < n - 1; col++) {
    if (rungs.some((r) => r.col === col)) continue;
    let row = -1;
    for (let r = 0; r < rows; r++) {
      if (!has.has(key(r, col - 1)) && !has.has(key(r, col + 1))) {
        row = r;
        break;
      }
    }
    if (row === -1) {
      // 모든 row가 이웃 열 가로줄로 막힘: row 0의 이웃 가로줄을 지우고 둔다
      row = 0;
      for (const c of [col - 1, col + 1]) {
        if (has.delete(key(0, c))) {
          const i = rungs.findIndex((r) => r.row === 0 && r.col === c);
          if (i >= 0) rungs.splice(i, 1);
        }
      }
    }
    has.add(key(row, col));
    rungs.push({ row, col });
  }
  return rungs.sort((a, b) => a.row - b.row || a.col - b.col);
}

export interface LadderPoint {
  col: number;
  /** 0..rows (가로 이동은 row+0.5) */
  y: number;
}

/** start 열에서 내려가는 경로 점들 (UI 하이라이트용) */
export function ladderTrace(n: number, rungs: readonly LadderRung[], rows: number, start: number): LadderPoint[] {
  let col = start;
  const pts: LadderPoint[] = [{ col, y: 0 }];
  for (let row = 0; row < rows; row++) {
    let next = col;
    if (col < n - 1 && rungs.some((r) => r.row === row && r.col === col)) next = col + 1;
    else if (col > 0 && rungs.some((r) => r.row === row && r.col === col - 1)) next = col - 1;
    if (next !== col) {
      pts.push({ col, y: row + 0.5 }, { col: next, y: row + 0.5 });
      col = next;
    }
  }
  pts.push({ col, y: rows });
  return pts;
}

/** 시작 열 i → 도착 열 (순열) */
export function ladderResult(n: number, rungs: readonly LadderRung[], rows: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = ladderTrace(n, rungs, rows, i);
    out.push(t[t.length - 1]!.col);
  }
  return out;
}

export function padOutcomes(outcomes: readonly string[], n: number): string[] {
  const out = outcomes.slice(0, n);
  while (out.length < n) out.push('꽝');
  return out;
}

/* ------------------------------------------------------------------ */
/* 정산                                                                  */
/* ------------------------------------------------------------------ */

export interface SettleResult {
  participants: string[];
  total: number;
  perPerson: { name: string; paid: number; owed: number; net: number }[];
  transfers: { from: string; to: string; amount: number }[];
}

/** 선언 순 + 지출에 새로 나온 이름(첫 등장 순). LLM 이름 흔들림에도 400 없이 계산한다 */
export function settleParticipants(tool: Pick<SettlementTool, 'participants' | 'expenses'>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (n: string) => {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };
  tool.participants.forEach(push);
  for (const e of tool.expenses) {
    push(e.payer);
    e.splitAmong.forEach(push);
  }
  return out;
}

/** 정수 원 정산. 나머지 r원은 splitAmong 앞 r명에 1원씩. 송금은 금액 내림차순·동률은 participants 순 탐욕 매칭 */
export function settle(tool: Pick<SettlementTool, 'participants' | 'expenses'>): SettleResult {
  const participants = settleParticipants(tool);
  const paid = new Map<string, number>(participants.map((p) => [p, 0]));
  const owed = new Map<string, number>(participants.map((p) => [p, 0]));
  let total = 0;
  for (const e of tool.expenses) {
    total += e.amount;
    paid.set(e.payer, (paid.get(e.payer) ?? 0) + e.amount);
    const split = [...new Set(e.splitAmong)];
    const k = split.length;
    if (k === 0) continue;
    const share = Math.floor(e.amount / k);
    const r = e.amount % k;
    split.forEach((name, i) => owed.set(name, (owed.get(name) ?? 0) + share + (i < r ? 1 : 0)));
  }
  const perPerson = participants.map((name) => {
    const p = paid.get(name) ?? 0;
    const o = owed.get(name) ?? 0;
    return { name, paid: p, owed: o, net: p - o };
  });

  const order = new Map(participants.map((p, i) => [p, i]));
  const cmp = (a: { name: string; amt: number }, b: { name: string; amt: number }) =>
    b.amt - a.amt || (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0);
  const creditors = perPerson.filter((p) => p.net > 0).map((p) => ({ name: p.name, amt: p.net }));
  const debtors = perPerson.filter((p) => p.net < 0).map((p) => ({ name: p.name, amt: -p.net }));
  const transfers: SettleResult['transfers'] = [];
  while (creditors.length > 0 && debtors.length > 0) {
    creditors.sort(cmp);
    debtors.sort(cmp);
    const c = creditors[0]!;
    const d = debtors[0]!;
    const amount = Math.min(c.amt, d.amt);
    transfers.push({ from: d.name, to: c.name, amount });
    c.amt -= amount;
    d.amt -= amount;
    if (c.amt === 0) creditors.shift();
    if (d.amt === 0) debtors.shift();
  }
  return { participants, total, perPerson, transfers };
}
/** UI가 쓰는 이름 (계획 6절) */
export const settleTransfers = settle;

/* ------------------------------------------------------------------ */
/* materialize (입력 → 이벤트에 실을 정규화 형태)                          */
/* ------------------------------------------------------------------ */

/** prefix: 'e' | 'i' | 'k' | 'b' | 'o'. 반환값은 접두사를 포함한 완성 id (예: `e_ab12`) */
/** b = 블록, o = 투표 선택지 */
export type NewId = (prefix: 'e' | 'i' | 'k' | 'b' | 'o') => string;

export function materializeInit(input: BoardToolInitInput, newId: NewId): BoardToolInit {
  switch (input.kind) {
    case 'ladder':
      return {
        kind: 'ladder',
        participants: [...input.participants],
        outcomes: padOutcomes(input.outcomes, input.participants.length),
      };
    case 'settlement': {
      const base = { participants: [...input.participants] };
      const expenses = input.expenses.map((e) => materializeExpense(e, base.participants, newId));
      return { kind: 'settlement', ...base, expenses };
    }
    case 'trip':
      return {
        kind: 'trip',
        days: input.days,
        ...(input.startDate ? { startDate: input.startDate } : {}),
        items: input.items.map((it) => ({ itemId: newId('i'), ...it })),
        checklist: input.checklist.map((text) => ({ checkId: newId('k'), text, done: false })),
      };
    case 'custom':
      return { kind: 'custom', blocks: input.blocks.map((b) => materializeBlock(b, newId)) };
  }
}

export function materializeBlock(b: CustomBlockInput, newId: NewId): CustomBlockInit {
  const blockId = newId('b');
  switch (b.type) {
    case 'text':
      return { type: 'text', blockId, text: b.text };
    case 'checklist':
      return { type: 'checklist', blockId, title: b.title, items: b.items.map((text) => ({ checkId: newId('k'), text, done: false })) };
    case 'vote':
      return { type: 'vote', blockId, question: b.question, options: b.options.map((text) => ({ optionId: newId('o'), text })) };
    case 'counter': {
      // min > max면 max를 버린다(상호 제약은 discriminatedUnion에 .refine을 못 쓰므로 여기서 정규화)
      const max = b.max !== undefined && b.min !== undefined && b.min > b.max ? undefined : b.max;
      return { type: 'counter', blockId, label: b.label, ...(b.min !== undefined ? { min: b.min } : {}), ...(max !== undefined ? { max } : {}) };
    }
  }
}

function materializeExpense(
  e: { label?: string | undefined; payer: string; amount: number; splitAmong?: string[] | undefined },
  participants: readonly string[],
  newId: NewId,
): Expense {
  const splitAmong = e.splitAmong && e.splitAmong.length > 0 ? [...e.splitAmong] : participants.length > 0 ? [...participants] : [e.payer];
  return { expenseId: newId('e'), label: e.label ?? '', payer: e.payer, amount: e.amount, splitAmong };
}

export interface MaterializeOpOptions {
  newId: NewId;
  /** ladder_run일 때 한 번 호출된다 (서버: crypto.randomInt) */
  seed: () => number;
  /**
   * expense_add에서 splitAmong 생략 시 쓸 전원 목록. 서버는 settleParticipants(tool)를 넘긴다.
   * 비어 있으면 [payer]. (계획 시그니처 대비 추가된 선택 필드)
   */
  participants?: readonly string[];
}

export function materializeOp(input: BoardToolOpInput, opts: MaterializeOpOptions): BoardToolOp {
  switch (input.op) {
    case 'title_set':
      return { op: 'title_set', title: input.title };
    case 'ladder_set':
      return {
        op: 'ladder_set',
        participants: [...input.participants],
        outcomes: padOutcomes(input.outcomes, input.participants.length),
      };
    case 'ladder_run':
      return { op: 'ladder_run', seed: opts.seed() >>> 0 };
    case 'ladder_reset':
      return { op: 'ladder_reset' };
    case 'expense_add': {
      const { op: _op, ...e } = input;
      return { op: 'expense_add', expense: materializeExpense(e, opts.participants ?? [], opts.newId) };
    }
    case 'expense_remove':
      return { op: 'expense_remove', expenseId: input.expenseId };
    case 'trip_item_add': {
      const { op: _op, ...it } = input;
      return { op: 'trip_item_add', item: { itemId: opts.newId('i'), ...it } };
    }
    case 'trip_item_remove':
      return { op: 'trip_item_remove', itemId: input.itemId };
    case 'check_add':
      return { op: 'check_add', check: { checkId: opts.newId('k'), text: input.text, done: false } };
    case 'check_set':
      return { op: 'check_set', checkId: input.checkId, done: input.done };
    case 'check_remove':
      return { op: 'check_remove', checkId: input.checkId };
    case 'block_add':
      return { op: 'block_add', block: materializeBlock(input.block, opts.newId) };
    case 'block_remove':
      return { op: 'block_remove', blockId: input.blockId };
    case 'block_check_add':
      return { op: 'block_check_add', blockId: input.blockId, check: { checkId: opts.newId('k'), text: input.text, done: false } };
    case 'block_check_set':
      return { op: 'block_check_set', blockId: input.blockId, checkId: input.checkId, done: input.done };
    case 'block_check_remove':
      return { op: 'block_check_remove', blockId: input.blockId, checkId: input.checkId };
    case 'vote_option_add':
      return { op: 'vote_option_add', blockId: input.blockId, option: { optionId: opts.newId('o'), text: input.text } };
    case 'vote_option_remove':
      return { op: 'vote_option_remove', blockId: input.blockId, optionId: input.optionId };
    case 'vote_cast':
      return { op: 'vote_cast', blockId: input.blockId, optionId: input.optionId };
    case 'counter_add':
      return { op: 'counter_add', blockId: input.blockId, delta: input.delta };
  }
}

/* ------------------------------------------------------------------ */
/* 리듀서용 적용 (관대: 잘못된 op는 무시 → 어떤 로그도 재생 안전)            */
/* ------------------------------------------------------------------ */

export interface BoardToolCreatedInfo {
  toolId: string;
  title: string;
  ownerTag: OwnerTag;
  init: BoardToolInit;
  seq: number;
  actorKind: ActorKind;
  actorId: string | null;
}

export function createBoardTool(e: BoardToolCreatedInfo): BoardTool {
  const base: ToolBase = {
    toolId: e.toolId,
    title: e.title,
    ownerTag: e.ownerTag,
    createdBy: { kind: e.actorKind, id: e.actorId },
    createdSeq: e.seq,
    updatedSeq: e.seq,
    removed: false,
    rev: 0,
    cover: null,
  };
  const init = e.init;
  switch (init.kind) {
    case 'ladder':
      return { ...base, kind: 'ladder', participants: [...init.participants], outcomes: [...init.outcomes], run: null };
    case 'settlement':
      return {
        ...base,
        kind: 'settlement',
        participants: [...init.participants],
        expenses: init.expenses.map((x) => ({ ...x, splitAmong: [...x.splitAmong] })),
      };
    case 'trip':
      return {
        ...base,
        kind: 'trip',
        days: init.days,
        startDate: init.startDate ?? null,
        items: init.items.map((x) => ({ ...x })),
        checklist: init.checklist.map((x) => ({ ...x })),
      };
    case 'custom':
      return { ...base, kind: 'custom', blocks: init.blocks.map(blockFromInit) };
  }
}

function blockFromInit(b: CustomBlockInit): CustomBlock {
  switch (b.type) {
    case 'text':
      return { ...b };
    case 'checklist':
      return { ...b, items: b.items.map((x) => ({ ...x })) };
    case 'vote':
      return { ...b, options: b.options.map((x) => ({ ...x })), votes: {} };
    case 'counter': {
      const min = b.min ?? null;
      const max = b.max ?? null;
      return { type: 'counter', blockId: b.blockId, label: b.label, min, max, value: clampCounter(0, min, max) };
    }
  }
}

/** op를 적용한 새 도구. 무시되는 op면 같은 객체(prev)를 그대로 돌려준다 */
export function applyBoardToolOp(
  tool: BoardTool,
  op: BoardToolOp,
  ctx: { seq: number; actor: ToolActor },
): BoardTool {
  const done = <T extends BoardTool>(next: T): T => ({ ...next, rev: tool.rev + 1, updatedSeq: ctx.seq });

  if (op.op === 'title_set') return done({ ...tool, title: op.title });
  if (op.op === 'cover_set') {
    // 시스템 전용·비내용 필드: rev·updatedSeq는 올리지 않는다(내용 변화가 아니다)
    if (!COVER_KINDS.includes(tool.kind)) return tool;
    if (op.status === 'ready' && !op.assetId) return tool;
    const cover: ToolCover = { status: op.status, assetId: op.status === 'ready' ? (op.assetId ?? null) : null };
    if (tool.cover?.status === cover.status && tool.cover.assetId === cover.assetId) return tool;
    return { ...tool, cover };
  }

  switch (tool.kind) {
    case 'ladder': {
      switch (op.op) {
        case 'ladder_set':
          if (tool.run) return tool;
          return done({
            ...tool,
            participants: [...op.participants],
            outcomes: padOutcomes(op.outcomes, op.participants.length),
          });
        case 'ladder_run': {
          if (tool.run) return tool;
          const n = tool.participants.length;
          const rungs = ladderRungs(op.seed, n, L.ladderRows);
          const result = ladderResult(n, rungs, L.ladderRows);
          return done({ ...tool, run: { seed: op.seed, seq: ctx.seq, by: { ...ctx.actor }, rungs, result } });
        }
        case 'ladder_reset':
          if (!tool.run) return tool;
          return done({ ...tool, run: null });
        default:
          return tool;
      }
    }
    case 'settlement': {
      switch (op.op) {
        case 'expense_add':
          if (tool.expenses.some((x) => x.expenseId === op.expense.expenseId)) return tool;
          return done({
            ...tool,
            expenses: [...tool.expenses, { ...op.expense, splitAmong: [...op.expense.splitAmong] }],
          });
        case 'expense_remove':
          if (!tool.expenses.some((x) => x.expenseId === op.expenseId)) return tool;
          return done({ ...tool, expenses: tool.expenses.filter((x) => x.expenseId !== op.expenseId) });
        default:
          return tool;
      }
    }
    case 'trip': {
      switch (op.op) {
        case 'trip_item_add':
          if (tool.items.some((x) => x.itemId === op.item.itemId)) return tool;
          return done({ ...tool, items: [...tool.items, { ...op.item }] });
        case 'trip_item_remove':
          if (!tool.items.some((x) => x.itemId === op.itemId)) return tool;
          return done({ ...tool, items: tool.items.filter((x) => x.itemId !== op.itemId) });
        case 'check_add':
          if (tool.checklist.some((x) => x.checkId === op.check.checkId)) return tool;
          return done({ ...tool, checklist: [...tool.checklist, { ...op.check }] });
        case 'check_set': {
          const cur = tool.checklist.find((x) => x.checkId === op.checkId);
          if (!cur) return tool;
          return done({
            ...tool,
            checklist: tool.checklist.map((x) => (x.checkId === op.checkId ? { ...x, done: op.done } : x)),
          });
        }
        case 'check_remove':
          if (!tool.checklist.some((x) => x.checkId === op.checkId)) return tool;
          return done({ ...tool, checklist: tool.checklist.filter((x) => x.checkId !== op.checkId) });
        default:
          return tool;
      }
    }
    case 'custom': {
      const edit = (blockId: string, fn: (b: CustomBlock) => CustomBlock | null): BoardTool => {
        const cur = tool.blocks.find((b) => b.blockId === blockId);
        if (!cur) return tool;
        const next = fn(cur);
        if (!next) return tool;
        return done({ ...tool, blocks: tool.blocks.map((b) => (b === cur ? next : b)) });
      };
      switch (op.op) {
        case 'block_add':
          if (tool.blocks.some((b) => b.blockId === op.block.blockId)) return tool;
          return done({ ...tool, blocks: [...tool.blocks, blockFromInit(op.block)] });
        case 'block_remove':
          if (!tool.blocks.some((b) => b.blockId === op.blockId)) return tool;
          return done({ ...tool, blocks: tool.blocks.filter((b) => b.blockId !== op.blockId) });
        case 'block_check_add':
          return edit(op.blockId, (b) =>
            b.type === 'checklist' && !b.items.some((x) => x.checkId === op.check.checkId)
              ? { ...b, items: [...b.items, { ...op.check }] }
              : null,
          );
        case 'block_check_set':
          return edit(op.blockId, (b) =>
            b.type === 'checklist' && b.items.some((x) => x.checkId === op.checkId)
              ? { ...b, items: b.items.map((x) => (x.checkId === op.checkId ? { ...x, done: op.done } : x)) }
              : null,
          );
        case 'block_check_remove':
          return edit(op.blockId, (b) =>
            b.type === 'checklist' && b.items.some((x) => x.checkId === op.checkId)
              ? { ...b, items: b.items.filter((x) => x.checkId !== op.checkId) }
              : null,
          );
        case 'vote_option_add':
          return edit(op.blockId, (b) =>
            b.type === 'vote' && !b.options.some((x) => x.optionId === op.option.optionId)
              ? { ...b, options: [...b.options, { ...op.option }] }
              : null,
          );
        case 'vote_option_remove':
          return edit(op.blockId, (b) => {
            if (b.type !== 'vote' || !b.options.some((x) => x.optionId === op.optionId)) return null;
            const votes = Object.fromEntries(Object.entries(b.votes).filter(([, o]) => o !== op.optionId));
            return { ...b, options: b.options.filter((x) => x.optionId !== op.optionId), votes };
          });
        case 'vote_cast': {
          // 투표자는 사람 actor만(Agent·방문 Agent는 표를 던지지 않는다)
          const voter = ctx.actor.kind === 'human' ? ctx.actor.id : null;
          if (!voter) return tool;
          return edit(op.blockId, (b) =>
            b.type === 'vote' && b.options.some((x) => x.optionId === op.optionId) && b.votes[voter] !== op.optionId
              ? { ...b, votes: { ...b.votes, [voter]: op.optionId } }
              : null,
          );
        }
        case 'counter_add':
          return edit(op.blockId, (b) => {
            if (b.type !== 'counter' || op.delta === 0) return null;
            const value = clampCounter(b.value + op.delta, b.min, b.max);
            return value === b.value ? null : { ...b, value };
          });
        default:
          return tool;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 표시용 요약                                                            */
/* ------------------------------------------------------------------ */

export function formatWon(n: number): string {
  return `${String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}원`;
}

export function boardToolSummary(tool: BoardTool): string {
  switch (tool.kind) {
    case 'ladder': {
      if (!tool.run) return `실행 전 · ${tool.participants.length}명`;
      const { result } = tool.run;
      let i = tool.participants.findIndex((_, idx) => tool.outcomes[result[idx] ?? 0] !== '꽝');
      if (i < 0) i = 0;
      return `${tool.participants[i] ?? ''} → ${tool.outcomes[result[i] ?? 0] ?? ''}`;
    }
    case 'settlement': {
      const total = tool.expenses.reduce((s, e) => s + e.amount, 0);
      return `${tool.expenses.length}건 · 총 ${formatWon(total)}`;
    }
    case 'trip': {
      const done = tool.checklist.filter((c) => c.done).length;
      return `일정 ${tool.items.length} · 준비물 ${done}/${tool.checklist.length}`;
    }
    case 'custom': {
      const parts = [`블록 ${tool.blocks.length}`];
      let checks = 0;
      let checked = 0;
      let votes = 0;
      for (const b of tool.blocks) {
        if (b.type === 'checklist') {
          checks += b.items.length;
          checked += b.items.filter((x) => x.done).length;
        } else if (b.type === 'vote') votes += Object.keys(b.votes).length;
      }
      if (checks > 0) parts.push(`체크 ${checked}/${checks}`);
      if (votes > 0) parts.push(`투표 ${votes}표`);
      return parts.join(' · ');
    }
  }
}
