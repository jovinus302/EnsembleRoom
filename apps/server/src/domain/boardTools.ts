import { randomBytes, randomInt } from 'node:crypto';
import {
  BOARD_TOOL_LIMITS,
  COVER_KINDS,
  BoardToolInitInputSchema,
  OP_KIND,
  materializeInit,
  materializeOp,
  settleParticipants,
  type BoardTool,
  type CustomBlock,
  type NewId,
  type BoardToolOpInput,
} from '@ensemble/shared';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { resolveOwnerTag, type Action, type ActionHandler, type HandlerEnv } from './actions';
import { roomStateOf } from './rooms';

/**
 * 보드 도구 핸들러 (계획 4.2절). 상태는 이벤트 리듀싱(roomStateOf)이 진실이다.
 * 리듀서는 무효 op를 조용히 무시하므로 엄격한 검증(404/409/400)은 여기 authorize가 맡는다.
 * dispatch는 동기 SQLite 트랜잭션이라 같은 Room의 쓰기는 직렬화된다(동시 실행 → 두 번째는 409).
 */

type A<K extends Action['type']> = Extract<Action, { type: K }>;
const L = BOARD_TOOL_LIMITS;

const newToolId = () => `t_${randomBytes(6).toString('hex')}`;
const newItemId: NewId = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;

function liveTool(env: HandlerEnv, toolId: string): BoardTool {
  const tool = roomStateOf(env.ctx, env.room.id).boardTools[toolId];
  if (!tool || tool.removed) throw notFound('tool_not_found', '존재하지 않는 도구');
  return tool;
}

function requireHuman(env: HandlerEnv, what: string): void {
  if (env.actor.kind !== 'human') throw forbidden('humans_only', `${what}은(는) 사람만 할 수 있습니다`);
}

function hasItem(list: readonly object[], key: string, id: string): boolean {
  return list.some((x) => (x as Record<string, unknown>)[key] === id);
}

/** custom 도구의 op 검증 (대상 블록·항목 존재, 블록 종류, 상한). 사람 전용 op는 호출 전에 걸러진다 */
function authorizeCustom(env: HandlerEnv, tool: Extract<BoardTool, { kind: 'custom' }>, op: BoardToolOpInput): void {
  if (op.op === 'vote_cast' || op.op === 'counter_add' || op.op === 'vote_option_remove') {
    requireHuman(env, op.op === 'counter_add' ? '카운터 조작' : '투표');
  }
  if (op.op === 'block_add') {
    if (tool.blocks.length >= L.customBlocks) throw conflict('tool_full', `블록은 ${L.customBlocks}개까지입니다`);
    return;
  }
  if (!('blockId' in op)) return;
  const block: CustomBlock | undefined = tool.blocks.find((b) => b.blockId === op.blockId);
  if (!block) throw notFound('item_not_found', '존재하지 않는 블록');
  const need = (type: CustomBlock['type']) => {
    if (block.type !== type) throw badRequest('op_kind_mismatch', `${block.type} 블록에는 ${op.op}를 쓸 수 없습니다`);
  };
  switch (op.op) {
    case 'block_check_add':
      need('checklist');
      if (block.type === 'checklist' && block.items.length >= L.customChecklist) {
        throw conflict('tool_full', `체크 항목은 ${L.customChecklist}개까지입니다`);
      }
      break;
    case 'block_check_set':
    case 'block_check_remove':
      need('checklist');
      if (block.type === 'checklist' && !hasItem(block.items, 'checkId', op.checkId)) {
        throw notFound('item_not_found', '존재하지 않는 체크 항목');
      }
      break;
    case 'vote_option_add':
      need('vote');
      if (block.type === 'vote' && block.options.length >= L.customVoteOptions) {
        throw conflict('tool_full', `선택지는 ${L.customVoteOptions}개까지입니다`);
      }
      break;
    case 'vote_option_remove':
    case 'vote_cast':
      need('vote');
      if (block.type === 'vote' && !hasItem(block.options, 'optionId', op.optionId)) {
        throw notFound('item_not_found', '존재하지 않는 선택지');
      }
      break;
    case 'counter_add':
      need('counter');
      break;
    default:
      break;
  }
}

const createBoardTool: ActionHandler<A<'create_board_tool'>> = {
  capability: 'board_tools',
  authorize(env, a) {
    if (!a.title.trim()) throw badRequest('empty_title');
    const parsed = BoardToolInitInputSchema.safeParse(a.init);
    if (!parsed.success) {
      throw badRequest('invalid_tool_init', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    const live = Object.values(roomStateOf(env.ctx, env.room.id).boardTools).filter((t) => !t.removed).length;
    if (live >= L.toolsPerRoom) throw conflict('too_many_tools', `도구는 Room당 ${L.toolsPerRoom}개까지입니다`);
  },
  apply(env, a) {
    const toolId = newToolId();
    const init = materializeInit(BoardToolInitInputSchema.parse(a.init), newItemId);
    const ownerTag = resolveOwnerTag(env, undefined);
    return {
      events: [{ type: 'board_tool_created', toolId, title: a.title.trim(), ownerTag, init }],
      data: { toolId },
    };
  },
  afterAppend(env, _a, events) {
    const e = events[0];
    if (e?.type === 'board_tool_created' && COVER_KINDS.includes(e.init.kind)) env.ctx.covers.enqueue(env.room.id, e.toolId);
  },
};

function checkKind(tool: BoardTool, op: BoardToolOpInput): void {
  const kind = OP_KIND[op.op];
  if (kind && !(Array.isArray(kind) ? kind.includes(tool.kind) : kind === tool.kind)) throw badRequest('op_kind_mismatch', `${tool.kind} 도구에는 ${op.op}를 쓸 수 없습니다`);
}

const updateBoardTool: ActionHandler<A<'update_board_tool'>> = {
  capability: 'board_tools',
  authorize(env, a) {
    const tool = liveTool(env, a.toolId);
    const op = a.op;
    checkKind(tool, op);
    if (op.op === 'ladder_run' || op.op === 'ladder_reset') requireHuman(env, '사다리 실행·초기화');
    if (tool.kind === 'ladder') {
      if (op.op === 'ladder_run' && tool.run) throw conflict('already_ran', '이미 실행된 사다리입니다');
      if (op.op === 'ladder_reset' && !tool.run) throw conflict('not_ran', '아직 실행하지 않은 사다리입니다');
      if (op.op === 'ladder_set' && tool.run) throw conflict('already_ran', '실행된 사다리는 고칠 수 없습니다');
    }
    if (tool.kind === 'settlement') {
      if (op.op === 'expense_remove' && !hasItem(tool.expenses, 'expenseId', op.expenseId)) {
        throw notFound('item_not_found', '존재하지 않는 지출');
      }
      if (op.op === 'expense_add') {
        if (tool.expenses.length >= L.expenses) throw conflict('tool_full', `지출은 ${L.expenses}건까지입니다`);
        const next = materializeOp(op, { newId: newItemId, seed: () => 0, participants: settleParticipants(tool) });
        if (next.op === 'expense_add') {
          const names = settleParticipants({ participants: tool.participants, expenses: [...tool.expenses, next.expense] });
          if (names.length > L.participants) throw conflict('tool_full', `참가자는 ${L.participants}명까지입니다`);
        }
      }
    }
    if (tool.kind === 'custom') authorizeCustom(env, tool, op);
    if (tool.kind === 'trip') {
      if (op.op === 'trip_item_remove' && !hasItem(tool.items, 'itemId', op.itemId)) {
        throw notFound('item_not_found', '존재하지 않는 일정');
      }
      if ((op.op === 'check_set' || op.op === 'check_remove') && !hasItem(tool.checklist, 'checkId', op.checkId)) {
        throw notFound('item_not_found', '존재하지 않는 준비물');
      }
      if (op.op === 'trip_item_add') {
        if (op.day > tool.days) throw badRequest('invalid_day', `일정은 ${tool.days}일차까지입니다`);
        if (tool.items.length >= L.tripItems) throw conflict('tool_full', `일정은 ${L.tripItems}개까지입니다`);
      }
      if (op.op === 'check_add' && tool.checklist.length >= L.checklist) {
        throw conflict('tool_full', `준비물은 ${L.checklist}개까지입니다`);
      }
    }
  },
  apply(env, a) {
    const tool = liveTool(env, a.toolId);
    const op = materializeOp(a.op, {
      newId: newItemId,
      seed: () => randomInt(0, 2 ** 32),
      participants: tool.kind === 'settlement' ? settleParticipants(tool) : undefined,
    });
    return { events: [{ type: 'board_tool_updated', toolId: a.toolId, op }], data: { toolId: a.toolId, op: op.op } };
  },
};

const removeBoardTool: ActionHandler<A<'remove_board_tool'>> = {
  capability: 'board_tools',
  authorize(env, a) {
    requireHuman(env, '도구 내리기');
    liveTool(env, a.toolId);
  },
  apply(_env, a) {
    return { events: [{ type: 'board_tool_removed', toolId: a.toolId }], data: { toolId: a.toolId } };
  },
};

/** 커버 이미지 상태 기록: 서버 시스템 전용(사람·Agent는 403). 이벤트 actor는 system */
const setBoardToolCover: ActionHandler<A<'set_board_tool_cover'>> = {
  capability: null,
  authorize(env, a) {
    if (env.actor.kind !== 'system') throw forbidden('system_only', '시스템만 할 수 있습니다');
    const tool = liveTool(env, a.toolId);
    if (!COVER_KINDS.includes(tool.kind)) throw badRequest('op_kind_mismatch', `${tool.kind} 도구에는 커버를 붙일 수 없습니다`);
    if (a.status === 'ready' && !a.assetId) throw badRequest('invalid_cover');
  },
  apply(_env, a) {
    const op = a.status === 'ready' ? { op: 'cover_set' as const, status: a.status, assetId: a.assetId } : { op: 'cover_set' as const, status: a.status };
    return { events: [{ type: 'board_tool_updated', toolId: a.toolId, op }], data: { toolId: a.toolId } };
  },
};

export const BOARD_TOOL_HANDLERS = {
  create_board_tool: createBoardTool,
  update_board_tool: updateBoardTool,
  remove_board_tool: removeBoardTool,
  set_board_tool_cover: setBoardToolCover,
};
