import { z } from 'zod';
import {
  MemoryKindSchema,
  PassReasonSchema,
  TOOL_NAMES,
  allowedTools,
  privateNamespaceOpen,
  privateTo,
  type PassReason,
  type PermissionSubject,
  type SourceChip,
  type ToolName,
} from '@ensemble/shared';
import { namespaceContextFor } from '../memory/nsContext';
import type { AppContext } from '../context';
import { dispatch, type Action } from '../domain/actions';
import { requireRoom, resolveSubject, type ActorCtx } from '../domain/rooms';
import { endVisit } from '../domain/visits';
import { badRequest, forbidden } from '../errors';
import { validateUsedMemoryIds } from '../memory/gateway';
import { BOARD_TOOL_DEFS, BOARD_TOOL_INPUT_SCHEMAS, executeBoardToolCall } from './boardToolTools';
import { memoryChipResolver, normalizeBlocks } from './answerBlocks';
import type { ToolSpec } from './types';

/**
 * Agent 도구 (계획 6절 도구 표). 모델이 낸 tool_use를 검증하고 Action으로 바꿔 dispatch로 실행한다.
 * 권한은 여기서 한 번 더 서버 진실로 강제한다: 실행 직전에 resolveSubject → allowedTools를 다시 계산한다.
 * (dispatch가 capability를 다시 한 번 검사하므로 두 겹이다.)
 */

const common = {
  public_rationale: z.string().max(500).optional(),
  owner_note: z.string().max(500).optional(),
  used_memory_ids: z.array(z.string()).max(20).optional(),
};
const obj = <S extends z.ZodRawShape>(shape: S) => z.object({ ...shape, ...common }).strict();

export const TOOL_INPUT_SCHEMAS = {
  say: obj({ text: z.string().min(1).max(2000), to: z.string().min(1).optional(), blocks: z.array(z.unknown()).max(6).optional() }),
  comment: obj({ card_id: z.string().min(1), text: z.string().min(1).max(1000) }),
  propose_edit: obj({
    card_id: z.string().min(1).optional(),
    title: z.string().max(200).optional(),
    body: z.string().max(4000).optional(),
    room_message: z.string().min(1).max(500).optional(),
  }),
  edit_board: obj({
    op: z.enum(['create', 'update', 'delete']),
    card_id: z.string().min(1).optional(),
    title: z.string().max(200).optional(),
    body: z.string().max(4000).optional(),
  }),
  request_approval: obj({
    question: z.string().min(1).max(500),
    options: z.array(z.string().min(1).max(200)).min(2).max(4),
    room_message: z.string().min(1).max(500).optional(),
  }),
  remember: obj({ text: z.string().min(1).max(1000), kind: MemoryKindSchema }),
  end_visit: obj({ public_takeout: z.string().max(1500), report_for_owner: z.string().max(3000) }),
  // `to`가 아니라 agent_ids를 쓴다: claude.ts가 부분 JSON의 문자열 `to`를 대화 상대(target)로 읽기 때문이다.
  ask_agents: obj({ agent_ids: z.array(z.string().min(1)).min(1).max(3), question: z.string().min(1).max(500) }),
  pass: obj({ reason: PassReasonSchema }),
  ...BOARD_TOOL_INPUT_SCHEMAS,
} satisfies Record<ToolName, z.ZodTypeAny>;

const COMMON_PROPS = {
  public_rationale: { type: 'string', description: '이 행동의 공개 근거(선택). 승인 요청이면 승인 카드에 보인다.' },
  owner_note: { type: 'string', description: '소유자에게만 남기는 메모(선택).' },
  used_memory_ids: { type: 'array', items: { type: 'string' }, description: '이번 턴에 제공된 기억 중 사용한 항목 id. 제공되지 않은 id는 거부된다.' },
};
const schema = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties: { ...properties, ...COMMON_PROPS },
  required,
  additionalProperties: false,
});

/** 모델에 줄 도구 정의. S9의 claude.ts가 그대로 `tools`에 넣는다 (`tool_choice: {type: 'any'}`). */
export const TOOL_DEFS: Record<ToolName, ToolSpec> = {
  say: {
    name: 'say',
    description: 'Room에 메시지를 말한다. 특정 Agent·사람에게 하는 말이면 to에 id를 넣는다.',
    inputSchema: schema({ text: { type: 'string' }, to: { type: 'string', description: '수신자 id(선택)' } }, ['text']),
  },
  comment: {
    name: 'comment',
    description: '보드의 카드에 코멘트를 남긴다.',
    inputSchema: schema({ card_id: { type: 'string' }, text: { type: 'string' } }, ['card_id', 'text']),
  },
  propose_edit: {
    name: 'propose_edit',
    description: '카드 수정(또는 새 카드)을 제안한다. 승인자가 확인해야 반영된다.',
    inputSchema: schema(
      {
        card_id: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        room_message: { type: 'string', description: '제안을 올린 뒤 Room에 함께 남길 짧은 안내·요약 한두 문장(선택, 권장).' },
      },
      [],
    ),
  },
  edit_board: {
    name: 'edit_board',
    description: '보드 카드를 직접 만들거나 고치거나 지운다. 소유자와 함께 있는 My Room에서만 쓸 수 있다.',
    inputSchema: schema(
      { op: { type: 'string', enum: ['create', 'update', 'delete'] }, card_id: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } },
      ['op'],
    ),
  },
  request_approval: {
    name: 'request_approval',
    description:
      '확정, 위임 범위 밖의 일, 소유자가 정해야 하는 일, 돈·시간이 드는 약속은 say로 얼버무리지 말고 이 도구로 실제 승인을 요청한다. 선택지 2~4개. 승인자는 서버가 정한다. room_message에는 대화 상대에게 보일 한 문장 안내(예: "OO님께 확인을 요청해 두었어요")를 적는다.',
    inputSchema: schema(
      {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
        room_message: { type: 'string', description: '대화 상대에게 Room에 함께 남길 짧은 안내 한 문장(선택, 권장).' },
      },
      ['question', 'options'],
    ),
  },
  remember: {
    name: 'remember',
    description: '기억을 저장한다. 저장 공간은 서버가 정한다.',
    inputSchema: schema({ text: { type: 'string' }, kind: { type: 'string', enum: MemoryKindSchema.options } }, ['text', 'kind']),
  },
  end_visit: {
    name: 'end_visit',
    description: '방문을 끝낸다. public_takeout은 호스트 Room에 공개되고, report_for_owner는 소유자만 본다.',
    inputSchema: schema({ public_takeout: { type: 'string' }, report_for_owner: { type: 'string' } }, ['public_takeout', 'report_for_owner']),
  },
  ask_agents: {
    name: 'ask_agents',
    description:
      '지금 이 Room에 없는 구성원의 Agent에게 묻는다. 각자 한 번 답하고, 모두 답하면 당신이 다시 깨어나 정리한다. 사람 메시지 1건당 1회. 자리에 있는 사람에게는 say로 직접 묻는다. say의 to에 Agent id를 넣어 대화를 이어가지 않는다. agent_ids는 [물어볼 수 있는 Agent]에 있는 id만(1~3개).',
    inputSchema: schema(
      { agent_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3, description: '물어볼 Agent id' }, question: { type: 'string', description: '그 Agent들에게 할 질문 한두 문장' } },
      ['agent_ids', 'question'],
    ),
  },
  pass: {
    name: 'pass',
    description: '이번 턴에는 아무것도 하지 않는다.',
    inputSchema: schema({ reason: { type: 'string', enum: PassReasonSchema.options } }, ['reason']),
  },
  ...BOARD_TOOL_DEFS,
};

/* ---- say.blocks (답변 카드): My Room에서 소유자와 단둘이 있을 때만 스키마에 넣는다(토큰 절약) ---- */

const strS = { type: 'string' };
const srcS = { type: 'array', items: { type: 'string' }, maxItems: 4, description: '근거 id(mem_…, d…, #번호). 제공된 것만. 없으면 항목이 지워진다' };
const arr = (items: Record<string, unknown>, max: number, min?: number) => ({ type: 'array', items, maxItems: max, ...(min ? { minItems: min } : {}) });
const objS = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required });

const BLOCK_SCHEMAS: Record<string, unknown>[] = [
  objS(
    {
      type: { const: 'schedule' },
      title: strS,
      days: arr(
        objS(
          {
            label: { type: 'string', description: '요일/날짜 라벨 (예: 토)' },
            items: arr(
              objS(
                {
                  start: { type: 'string', description: 'HH:MM' },
                  end: { type: 'string', description: 'HH:MM' },
                  when: { type: 'string', description: '시각 대신 쓰는 짧은 말 (예: 저녁)' },
                  title: strS,
                  with: strS,
                  room: strS,
                  status: { type: 'string', enum: ['fixed', 'tentative', 'pending', 'free', 'conflict'] },
                  src: srcS,
                },
                ['title', 'status', 'src'],
              ),
              8,
            ),
          },
          ['label', 'items'],
        ),
        7,
      ),
      verdict: strS,
    },
    ['type', 'days'],
  ),
  objS(
    {
      type: { const: 'profile' },
      title: strS,
      groups: arr(
        objS(
          { label: strS, chips: arr(objS({ text: strS, tone: { type: 'string', enum: ['like', 'dislike', 'note'] }, src: srcS }, ['text', 'tone', 'src']), 6) },
          ['label', 'chips'],
        ),
        4,
      ),
    },
    ['type', 'title', 'groups'],
  ),
  objS(
    {
      type: { const: 'compare' },
      question: strS,
      options: arr(
        objS(
          {
            label: strS,
            pros: arr(strS, 3),
            cons: arr(strS, 3),
            people: arr(objS({ name: strS, ok: { type: 'string', enum: ['yes', 'no', 'maybe'] }, note: strS }, ['name', 'ok']), 6),
            recommended: { type: 'boolean' },
          },
          ['label'],
        ),
        4,
        2,
      ),
      recommendation: strS,
    },
    ['type', 'question', 'options'],
  ),
  objS(
    {
      type: { const: 'checklist' },
      title: strS,
      items: arr(objS({ text: strS, due: strS, room: strS, done: { type: 'boolean' }, src: srcS }, ['text']), 8),
    },
    ['type', 'title', 'items'],
  ),
  objS(
    {
      type: { const: 'money' },
      title: strS,
      total: { type: 'integer' },
      lines: arr(objS({ label: strS, amount: { type: 'integer' }, from: strS, to: strS }, ['label', 'amount']), 8),
      note: strS,
    },
    ['type', 'title', 'lines'],
  ),
  objS(
    {
      type: { const: 'status' },
      rooms: arr(
        objS(
          {
            room: strS,
            items: arr(objS({ text: strS, state: { type: 'string', enum: ['decided', 'pending_approval', 'waiting', 'todo'] }, src: srcS }, ['text', 'state', 'src']), 4),
          },
          ['room', 'items'],
        ),
        4,
      ),
    },
    ['type', 'rooms'],
  ),
];

const BLOCKS_PROP = {
  type: 'array',
  maxItems: 2,
  items: { anyOf: BLOCK_SCHEMAS },
  description: '답변 카드(선택, 보통 1개). 사용 기준은 시스템 프롬프트의 [답변 카드]. 항목마다 src에 근거 id를 적는다.',
};

export function toolSpecs(names: readonly ToolName[], opts: { allowBlocks?: boolean } = {}): ToolSpec[] {
  return names.map((n) => {
    const def = TOOL_DEFS[n];
    if (n !== 'say' || !opts.allowBlocks) return def;
    const props = def.inputSchema.properties as Record<string, unknown>;
    // text, to, blocks 순서: 스트리밍 미리보기가 text를 먼저 읽을 수 있게 한다
    const { text, to, ...rest } = props;
    return { ...def, inputSchema: { ...def.inputSchema, properties: { text, to, blocks: BLOCKS_PROP, ...rest } } };
  });
}

/**
 * 이 턴에 줄 도구. 권한(`allowedTools`)으로 거른다. 강제 턴이면 그 도구 하나만(권한이 있을 때).
 */
/** 자동 대리(trigger.reason='auto_reply') 턴의 보수적 위임: 대화와 승인 요청만 */
export const AUTO_REPLY_TOOLS: readonly ToolName[] = ['say', 'request_approval', 'pass'];

export function toolsForTurn(
  subject: PermissionSubject | null,
  forced: ToolName | null,
  autoReply = false,
  seedOwner = false,
  opts: { allowAsk?: boolean; noApproval?: boolean; closingOnly?: boolean } = {},
): ToolName[] {
  if (!subject) return [];
  let allowed = allowedTools(subject);
  if (autoReply) allowed = allowed.filter((t) => AUTO_REPLY_TOOLS.includes(t));
  // 마무리(확정) 턴: say/pass만. 새 질문·승인을 만들 수 없다
  if (opts.closingOnly) allowed = allowed.filter((t) => t === 'say' || t === 'pass');
  // 시드 사용자(엄마·Dana)는 로그인하지 않아 승인해 줄 사람이 없다: 승인 요청 없이 대화(say)만, 인물 설정 범위 안에서 스스로 답한다
  // Room Agent가 물은 답 턴(noApproval)도 의견만 말한다
  if (seedOwner || opts.noApproval) allowed = allowed.filter((t) => t !== 'request_approval');
  // ask_agents는 capability 도구가 아니다. 스케줄러가 정한 allowAsk일 때만, 강제 턴이 아니고 say가 허용된 경우에 pass 앞에 붙인다.
  if (opts.allowAsk && !autoReply && !forced && allowed.includes('say')) {
    const i = allowed.indexOf('pass');
    allowed = i >= 0 ? [...allowed.slice(0, i), 'ask_agents', ...allowed.slice(i)] : [...allowed, 'ask_agents'];
  }
  return forced ? allowed.filter((t) => t === forced) : allowed;
}

export const isToolName = (v: unknown): v is ToolName => typeof v === 'string' && (TOOL_NAMES as readonly string[]).includes(v);

/* ------------------------------ 실행 ------------------------------ */

export interface ExecContext {
  roomId: string;
  agentId: string;
  agentKind: 'personal' | 'room_agent';
  turnId: string;
  forcedTool: ToolName | null;
  /** 이번 턴에 gateway가 제공한 기억 id */
  providedMemoryIds: readonly string[];
  /** 자동 대리 턴: 도구를 say/request_approval/pass로 제한 */
  autoReply?: boolean;
  /** 이 턴에 ask_agents를 줄 수 있는가 (스케줄러가 정한다) */
  allowAsk?: boolean;
  /** Room Agent가 물은 답 턴: request_approval 제외 */
  noApproval?: boolean;
  /** 마무리(확정) 턴: say/pass만 */
  closingOnly?: boolean;
  /** 답변 카드(say.blocks) 허용: 서버가 My Room 소유자 단독 상황에서만 준다. 근거 id 검증에 쓸 서버 진실을 함께 싣는다 */
  blocks?: { digestRefs: ReadonlyMap<string, SourceChip>; eventSeqs: readonly number[] };
  /** ask_agents로 물을 수 있는 Agent id (서버가 턴 시작 때 계산) */
  askable?: readonly string[];
  /** A2A 답·정리 턴: 내 발화에 붙일 replyTo(질문 seq)와 강제 수신자(답 턴이면 질문자) */
  reply?: { seq: number; forceTo?: string };
}

export interface ExecResult {
  result: 'acted' | 'pass';
  tool: ToolName;
  passReason?: PassReason;
  data?: Record<string, unknown>;
}

/** 이 Personal Agent의 소유자가 시드(가상 인물) 사용자인가 */
export const isSeedAgent = (ctx: AppContext, agentId: string): boolean => {
  const a = ctx.repo.getAgent(agentId);
  return !!a && ctx.repo.getUser(a.ownerId)?.kind === 'seed';
};

export const actorOf = (e: Pick<ExecContext, 'agentId' | 'agentKind' | 'turnId'>): ActorCtx =>
  e.agentKind === 'personal'
    ? { kind: 'agent', agentId: e.agentId, turnId: e.turnId }
    : { kind: 'room_agent', roomAgentId: e.agentId, turnId: e.turnId };

/**
 * 도구 호출 1개를 실행한다. 위반하면 DomainError(403 등)를 던진다. 호출자(runTurn)가 `agent_turn_ended{error}`로 기록한다.
 */
export function executeTool(ctx: AppContext, ex: ExecContext, name: ToolName, rawInput: unknown): ExecResult {
  // 방문 중인 Agent의 메모는 소유자가 볼 수 있는 출발 Room에 둔다. end_visit이 방문을 끝내기 전에 정해 둔다.
  const noteRoomId = ownerNoteRoom(ctx, ex);
  const res = executeToolInner(ctx, ex, name, rawInput);
  saveOwnerNote(ctx, ex, noteRoomId, rawInput);
  return res;
}

function ownerNoteRoom(ctx: AppContext, ex: ExecContext): string {
  if (ex.agentKind !== 'personal') return ex.roomId;
  const agent = ctx.repo.getAgent(ex.agentId);
  const visit = ctx.repo.findOpenAgentVisit(ex.agentId);
  if (agent && visit?.status === 'active' && visit.hostRoomId === ex.roomId) {
    return ctx.repo.getMyRoomByOwner(agent.ownerId)?.id ?? ex.roomId;
  }
  return ex.roomId;
}

/**
 * `owner_note`는 소유자에게만 남기는 메모다. `agent_owner_note` 이벤트를 `private:<소유자>`로 기록한다.
 * 도구 실행이 성공한 뒤에만 남긴다(입력 검증은 executeToolInner가 마쳤다). Room Agent에는 소유자가 없어 남기지 않는다.
 */
function saveOwnerNote(ctx: AppContext, ex: ExecContext, roomId: string, rawInput: unknown): void {
  const note = (rawInput as { owner_note?: unknown } | null)?.owner_note;
  if (typeof note !== 'string' || !note.trim() || ex.agentKind !== 'personal') return;
  const agent = ctx.repo.getAgent(ex.agentId);
  if (!agent) return;
  try {
    ctx.store.append({
      roomId,
      actorKind: 'agent',
      actorId: ex.agentId,
      turnId: ex.turnId,
      visibility: privateTo(agent.ownerId),
      type: 'agent_owner_note',
      agentId: ex.agentId,
      note: note.trim(),
    });
  } catch (err) {
    console.error('[agent] owner_note failed', err);
  }
}

function executeToolInner(ctx: AppContext, ex: ExecContext, name: ToolName, rawInput: unknown): ExecResult {
  const room = requireRoom(ctx, ex.roomId);
  const actor = actorOf(ex);

  // 1) 서버 진실로 권한 재계산: 이 도구를 지금 써도 되는가
  const subject = resolveSubject(ctx, room, actor);
  if (!subject) throw forbidden('not_in_room', '이 Room에 접근할 수 없습니다');
  const tools = toolsForTurn(subject, ex.forcedTool, ex.autoReply, isSeedAgent(ctx, ex.agentId), {
    allowAsk: ex.allowAsk,
    noApproval: ex.noApproval,
    closingOnly: ex.closingOnly,
  });
  if (!tools.includes(name)) throw forbidden('tool_not_allowed', `이 상황에서 쓸 수 없는 도구: ${name}`);

  // 2) 입력 검증
  const parsed = TOOL_INPUT_SCHEMAS[name].safeParse(rawInput);
  if (!parsed.success) throw badRequest('invalid_tool_input', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const input = parsed.data as Record<string, unknown> & {
    used_memory_ids?: string[];
    public_rationale?: string;
  };

  // 3) 이번 턴에 제공되지 않은 기억을 썼다고 주장하면 거부
  validateUsedMemoryIds(input.used_memory_ids ?? [], ex.providedMemoryIds);

  const run = (action: Action) => dispatch(ctx, actor, action);
  const rationale = input.public_rationale;

  switch (name) {
    case 'say': {
      const i = parsed.data as z.infer<typeof TOOL_INPUT_SCHEMAS.say>;
      // 답변 카드는 허용된 턴에서만. 아니면 조용히 버리고 평문만 보낸다. 검증을 통과한 블록만 남는다
      // 실행 시점에 방문자가 들어왔으면(스트리밍 중 입장) 소유자 전용 카드는 버린다
      const blocks = ex.blocks && i.blocks?.length && privateNamespaceOpen(namespaceContextFor(ctx, ex.agentId, ex.roomId))
        ? normalizeBlocks(i.blocks, {
            providedIds: ex.providedMemoryIds,
            digestRefs: ex.blocks.digestRefs,
            eventSeqs: ex.blocks.eventSeqs,
            memoryChip: memoryChipResolver(ctx),
          })
        : [];
      const r = run({
        type: 'send_message',
        roomId: ex.roomId,
        text: i.text,
        // A2A 답 턴은 모델이 준 to를 무시하고 질문자에게 간다
        // 마무리(closing) 턴은 다른 Agent를 지목하지 못한다(새 승인 연쇄 방지)
        to: ex.reply?.forceTo ?? (ex.closingOnly ? undefined : i.to),
        memoryRefs: i.used_memory_ids?.length ? i.used_memory_ids : undefined,
        ...(ex.reply ? { replyTo: ex.reply.seq } : {}),
        ...(blocks.length ? { blocks } : {}),
      });
      return { result: 'acted', tool: name, data: r.data };
    }
    case 'comment': {
      const i = parsed.data as z.infer<typeof TOOL_INPUT_SCHEMAS.comment>;
      const r = run({ type: 'add_comment', roomId: ex.roomId, cardId: i.card_id, text: i.text });
      return { result: 'acted', tool: name, data: r.data };
    }
    case 'propose_edit': {
      const i = parsed.data as z.infer<typeof TOOL_INPUT_SCHEMAS.propose_edit>;
      const r = run({
        type: 'propose_edit',
        roomId: ex.roomId,
        cardId: i.card_id,
        title: i.title,
        body: i.body,
        rationale,
      });
      // 방에 보일 요약·안내는 제안이 만들어진 뒤에만 남기고, 실패해도 제안은 유지한다
      if (i.room_message?.trim()) {
        try {
          run({
            type: 'send_message',
            roomId: ex.roomId,
            text: i.room_message.trim(),
            ...(ex.reply?.forceTo ? { to: ex.reply.forceTo } : {}),
            ...(ex.reply ? { replyTo: ex.reply.seq } : {}),
          });
        } catch (err) {
          console.error('[agent] room_message failed', err);
        }
      }
      return { result: 'acted', tool: name, data: r.data };
    }
    case 'edit_board': {
      const i = parsed.data as z.infer<typeof TOOL_INPUT_SCHEMAS.edit_board>;
      if (i.op === 'create') {
        const r = run({ type: 'create_card', roomId: ex.roomId, title: i.title ?? '', body: i.body ?? '' });
        return { result: 'acted', tool: name, data: r.data };
      }
      if (!i.card_id) throw badRequest('card_id_required', 'update/delete에는 card_id가 필요합니다');
      const card = ctx.repo.getCard(ex.roomId, i.card_id);
      if (!card || card.deleted) throw badRequest('card_not_found', '존재하지 않는 카드');
      const patch = i.op === 'delete' ? { deleted: true } : { title: i.title, body: i.body };
      const r = run({ type: 'update_card', roomId: ex.roomId, cardId: i.card_id, patch, baseVersion: card.version });
      return { result: 'acted', tool: name, data: r.data };
    }
    case 'request_approval': {
      const i = parsed.data as z.infer<typeof TOOL_INPUT_SCHEMAS.request_approval>;
      const r = run({ type: 'request_approval', roomId: ex.roomId, question: i.question, options: i.options, rationale });
      // 상대에게 보일 안내는 승인 요청이 만들어진 뒤에만 남기고, 실패해도 승인 요청은 유지한다
      if (i.room_message?.trim()) {
        try {
          run({
            type: 'send_message',
            roomId: ex.roomId,
            text: i.room_message.trim(),
            ...(ex.reply?.forceTo ? { to: ex.reply.forceTo } : {}),
            ...(ex.reply ? { replyTo: ex.reply.seq } : {}),
          });
        } catch (err) {
          console.error('[agent] room_message failed', err);
        }
      }
      return { result: 'acted', tool: name, data: r.data };
    }
    case 'remember': {
      const i = parsed.data as z.infer<typeof TOOL_INPUT_SCHEMAS.remember>;
      // ns는 gateway가 서버 진실로 정한다. 쓸 수 없는 상황이면 403.
      const r = ctx.memory.retainFromAgent(ex.agentId, ex.roomId, { kind: i.kind, text: i.text, turnId: ex.turnId });
      return { result: 'acted', tool: name, data: { ...r } };
    }
    case 'end_visit': {
      const i = parsed.data as z.infer<typeof TOOL_INPUT_SCHEMAS.end_visit>;
      const visit = ctx.repo.findOpenAgentVisit(ex.agentId);
      if (!visit || visit.status !== 'active' || visit.hostRoomId !== ex.roomId) {
        throw forbidden('not_visiting', '진행 중인 방문이 없습니다');
      }
      const r = endVisit(ctx, actor, visit.id, {
        reason: ex.forcedTool === 'end_visit' ? 'turn_limit' : 'agent_ended',
        takeout: i.public_takeout,
        report: i.report_for_owner,
      });
      return { result: 'acted', tool: name, data: r.data };
    }
    case 'create_board_tool':
    case 'update_board_tool':
      return executeBoardToolCall(ex.roomId, name, parsed.data as never, run);
    case 'ask_agents': {
      const i = parsed.data as z.infer<typeof TOOL_INPUT_SCHEMAS.ask_agents>;
      const askable = ex.askable ?? [];
      const wanted = new Set(i.agent_ids);
      const bad = [...wanted].filter((id) => !askable.includes(id));
      if (bad.length > 0) throw badRequest('not_askable', `지금 물을 수 없는 Agent: ${bad.join(', ')}`);
      // 수신자는 askable 순서(구성원 순서)로 정규화한다: 결정적 순서
      const recipients = askable.filter((id) => wanted.has(id));
      const r = run({
        type: 'send_message',
        roomId: ex.roomId,
        text: i.question,
        recipients,
        memoryRefs: i.used_memory_ids?.length ? i.used_memory_ids : undefined,
      });
      return { result: 'acted', tool: name, data: { ...r.data, recipients } };
    }
    case 'pass': {
      const i = parsed.data as z.infer<typeof TOOL_INPUT_SCHEMAS.pass>;
      return { result: 'pass', tool: name, passReason: i.reason };
    }
  }
}
