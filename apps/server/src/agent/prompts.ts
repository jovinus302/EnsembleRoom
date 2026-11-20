import type { BoardCard, BoardTool, Mandate, RoomEvent } from '@ensemble/shared';
import { BOARD_TOOL_RULES, renderBoardToolEvent, renderBoardTools } from './boardToolTools';
import type { AskableAgent, ToolSpec, TurnA2A, TurnMemory, TurnMode, Trigger } from './types';

/**
 * 프롬프트 조립 (계획 6절 프롬프트). 상한 약 9k 토큰:
 *   기억 1.5k, Room 요약 0.6k, 최근 이벤트 3k, 보드 1.5k + 규칙·persona·mandate.
 * 토큰 수는 보수적으로 `글자수 / 2`로 어림한다(한국어 위주).
 */

export const TOKEN_BUDGET = { memories: 1500, summary: 600, events: 3000, board: 1500, tools: 800 } as const;
export const MAX_EVENTS = 30;
export const MAX_MEMORIES = 20;

export const estimateTokens = (text: string): number => Math.ceil(text.length / 2);

/** 앞에서부터 줄을 채우되 예산을 넘으면 멈춘다 */
function fit(lines: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    const t = estimateTokens(l) + 1;
    if (used + t > budget) break;
    out.push(l);
    used += t;
  }
  return out;
}

/** 뒤(최신)부터 채워서 예산 안에 드는 가장 최근 줄들을 시간순으로 돌려준다 */
function fitRecent(lines: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = estimateTokens(lines[i]!) + 1;
    if (used + t > budget) break;
    out.unshift(lines[i]!);
    used += t;
  }
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function renderEvent(e: RoomEvent, name: (id: string | null) => string): string | null {
  const who = name(e.actorId);
  switch (e.type) {
    case 'message':
      if (e.recipients?.length) return `#${e.seq} ${who} → ${e.recipients.map((r) => name(r)).join(', ')} (질문): ${clip(e.text, 300)}`;
      if (e.replyTo !== undefined) return `#${e.seq} ${who} ↩#${e.replyTo}${e.to ? ` → ${name(e.to)}` : ''}: ${clip(e.text, 300)}`;
      return `#${e.seq} ${who}${e.to ? ` → ${name(e.to)}` : ''}: ${clip(e.text, 300)}`;
    case 'card_created':
      return `#${e.seq} ${who}가 카드 만듦 [${e.cardId}] "${clip(e.title, 60)}": ${clip(e.body, 160)}`;
    case 'card_updated':
      return `#${e.seq} ${who}가 카드 수정 [${e.cardId}] v${e.version}${e.patch.title ? ` 제목="${clip(e.patch.title, 60)}"` : ''}${e.patch.body ? ` 내용="${clip(e.patch.body, 160)}"` : ''}${e.patch.deleted ? ' (삭제)' : ''}`;
    case 'comment_added':
      return `#${e.seq} ${who}의 코멘트 [${e.cardId}]: ${clip(e.text, 200)}`;
    case 'card_pointed':
      return `#${e.seq} ${who}가 카드 [${e.cardId}]를 ${name(e.toAgentId)}에게 지목`;
    case 'approval_requested':
      return `#${e.seq} ${who}가 승인 요청: ${clip(e.summary, 160)}${e.options ? ` (선택지: ${e.options.join(' / ')})` : ''}`;
    case 'approval_resolved':
      return `#${e.seq} 승인 결과: ${e.outcome}`;
    case 'agreement_formed':
      return `#${e.seq} 합의 형성: 카드 [${e.cardId}]`;
    case 'agent_arrived':
      return `#${e.seq} ${name(e.agentId)} 도착`;
    case 'visit_takeout':
      return `#${e.seq} 방문 takeout: ${clip(e.text, 200)}`;
    case 'visit_ended':
      return `#${e.seq} 방문 종료 (${e.reason})`;
    case 'member_left':
      return `#${e.seq} ${name(e.userId)} 자리를 비움${e.mandate ? ` (대리 위임: ${clip(e.mandate.text, 120)})` : ''}`;
    case 'member_rejoined':
      return `#${e.seq} ${name(e.userId)} 돌아옴`;
    case 'board_tool_created':
    case 'board_tool_updated':
    case 'board_tool_removed':
      return renderBoardToolEvent(e, who);
    default:
      return null;
  }
}

export function renderBoard(board: readonly BoardCard[]): string[] {
  return fit(
    board.map(
      (c) => `[${c.cardId}] v${c.version}${c.agreed ? ' (합의됨)' : ''} "${clip(c.title, 60)}" (${c.ownerTag}): ${clip(c.body, 200)}${c.comments.length ? ` / 코멘트 ${c.comments.length}개` : ''}`,
    ),
    TOKEN_BUDGET.board,
  );
}

export function renderBoardToolSection(tools: readonly BoardTool[]): string[] {
  return fit(renderBoardTools(tools), TOKEN_BUDGET.tools);
}

export function renderMemories(memories: readonly TurnMemory[]): string[] {
  return fit(
    memories.slice(0, MAX_MEMORIES).map((m) => `(${m.id}) [${m.kind}] ${clip(m.text, 200)}`),
    TOKEN_BUDGET.memories,
  );
}

export function renderEvents(events: readonly RoomEvent[], name: (id: string | null) => string): string[] {
  const lines = events.slice(-MAX_EVENTS).map((e) => renderEvent(e, name)).filter((l): l is string => l !== null);
  return fitRecent(lines, TOKEN_BUDGET.events);
}

export function clipSummary(text: string): string {
  return fit([text], TOKEN_BUDGET.summary)[0] ?? clip(text, TOKEN_BUDGET.summary * 2);
}

const MODE_RULES: Record<TurnMode, string> = {
  accompanied:
    '지금 소유자가 이 Room에 함께 있다(동행). 거의 침묵한다. 불렸을 때, 또는 소유자의 기준과 충돌할 때만 말한다. 보드는 소유자의 요청이 있을 때만 직접 고친다.',
  representing:
    '소유자가 자리를 비웠고 당신이 위임 범위(mandate) 안에서 대리 참여한다. 코멘트, 제안, 응답을 스스로 한다. 보드를 직접 고칠 수 없다(propose_edit로 제안). 확정, 위임 밖의 일, 소유자 선호와 상충하는 타협, 돈이나 시간이 드는 약속, 소유자가 정하지 않은 세부 사항(예: 구체적인 시간)은 반드시 request_approval 도구로 넘긴다. say로 "승인 요청해 볼게요", "확인해 볼게요"라고 약속만 하지 않는다(말만 하면 소유자에게 아무것도 전달되지 않는다). request_approval의 room_message에 상대에게 보일 안내 한 문장("OO님께 확인을 요청해 두었어요")을 함께 적는다. 위임 범위 안의 단순 질문은 say로 바로 답한다.',
  visiting:
    '당신은 다른 사람의 Room을 방문 중인 손님 Agent다. 위임 범위(mandate)와 호스트가 허락한 권한 안에서만 행동한다. 보드 편집과 기억 저장은 할 수 없다. 방문이 끝나면 end_visit로 공개 takeout과 소유자용 보고를 남긴다. takeout은 호스트 Room에 공개되므로 개인 정보를 넣지 않는다.',
  member:
    'Our Room의 구성원 Agent다. 소유자가 함께 있다. 불렸을 때만 말하고, 보드 변경은 propose_edit로 제안한다. 승인으로 넘길 일은 request_approval을 쓴다.',
  room:
    '당신은 이 Our Room의 중립 조율자(Room Agent)다. 편을 들지 않는다. 요약하고, 의견이 갈리면 선택지 2~3개로 request_approval을 올리고, 합의 카드를 정리한다. 지목되면 답하되 결정하지 않는다. 사람이 말을 걸어 깨워졌다면 1~2문장으로 짧게 반응한다(정리, 제안, 되묻기 중 하나). 정말 할 말이 없을 때만 pass한다.',
};

export function buildSystemPrompt(p: {
  mode: TurnMode;
  agentName: string;
  ownerName: string | null;
  personaPublic: string;
  mandate: Mandate | null;
  tools: readonly ToolSpec[];
  forcedTool: string | null;
  /** Our Room 자동 대리 턴 (소유자가 접속하지 않았고 Leave도 하지 않음) */
  autoReply?: boolean;
  /** 소유자가 로그인하지 않는 가상 인물(시드). 승인 요청 없이 인물 설정 범위 안에서 스스로 답한다 */
  seedOwner?: boolean;
}): string {
  const lines = [
    `당신은 "${p.agentName}"이다.${p.ownerName ? ` 소유자는 ${p.ownerName}이다.` : ''}`,
    `성격: ${p.personaPublic}`,
    '',
    '[공통 규칙]',
    '- 턴당 행동은 정확히 1개다. 도구를 하나만 호출한다.',
    '- 아래에 제공된 정보(기억, 요약, 이벤트, 보드)만 근거로 쓴다. 제공되지 않은 정보를 추측하지 않는다.',
    '- 기억을 근거로 썼다면 used_memory_ids에 제공된 id만 적는다.',
    '- 할 말이 없으면 pass를 쓴다.',
    '',
    '[말투·형식] (say·comment의 text, 승인 질문·선택지)',
    '- 한국어 메신저 말투로, 1~3문장(120자 안팎)으로 짧게 쓴다. 기본은 존댓말이지만 성격에 말투(반말, "~요"체 등)가 적혀 있으면 그 말투를 따른다. 인사말·맺음말·이모지·마크다운(**, #, 목록)은 쓰지 않는다.',
    '- 카드 id(c_...)·이벤트 번호·내부 id를 문장에 쓰지 않는다. 카드는 제목으로, 사람은 이름으로 부른다.',
    '- 되묻기보다 제공된 정보로 바로 답한다. 정보가 정말 없을 때만 한 가지만 묻는다.',
    '',
    '[도구 선택 기준]',
    '- 질문·대화에 답하기: say. 사람에게 답할 때는 to를 생략한다. to는 [대화 상대 id]에 있는 id만 쓰고, 다른 Agent를 부를 때만 쓴다.',
    '- 일정·장소·메뉴를 확정하거나, 소유자가 정하지 않은 선택지가 갈릴 때: request_approval(options 2~3개, 질문은 한 문장). "승인 요청하겠다"는 말을 say로 하지 말고 request_approval을 직접 호출한다.',
    '- 카드 id가 필요한 도구(comment, propose_edit·edit_board의 update/delete)에는 [보드]의 대괄호 안 id만 쓴다. 없는 카드를 지어내지 않는다.',
    '- 소유자가 "기억해 줘"라고 하면 remember(핵심만 한 문장).',
    ...(p.tools.some((t) => t.name === 'ask_agents')
      ? [
          '- 지금 이 Room에 없는 구성원의 Agent에게 묻는다: ask_agents. 각자 한 번 답하고, 모두 답하면 당신이 다시 깨어나 정리한다. 사람 메시지 1건당 1회. 자리에 있는 사람에게는 say로 직접 묻는다. say의 to에 Agent id를 넣어 대화를 이어가지 않는다.',
          '- 부재 구성원의 일정·선호가 있어야 하는 조율(시간 변경·약속·메뉴)이면 먼저 ask_agents. 잡담·요약에는 쓰지 않는다.',
        ]
      : []),
    ...(p.tools.some((t) => t.name === 'create_board_tool') ? BOARD_TOOL_RULES : []),
    '',
    '[현재 모드]',
    MODE_RULES[p.mode],
  ];
  if (p.autoReply && p.seedOwner) {
    const o = p.ownerName ?? '소유자';
    lines.push(
      '',
      '[인물 대리 응답]',
      `${o}은(는) 이 Room의 가상 구성원이라 직접 접속하지 않는다. 당신은 ${o}의 Agent로서 위 성격에 적힌 입장·말투로 대화에 직접 답한다. 승인 요청 도구는 없다. 일정·메뉴·가능 여부 같은 질문에는 성격과 제공된 기억·보드 범위 안에서 ${o}의 입장을 바로 말한다(예: 성격에 적힌 고정 일정). 제공되지 않은 사실(구체적인 약속, 금액 등)은 지어내지 말고, 확정은 사람들이 정하도록 의견·제안 수준으로만 말한다. 자신이 Agent임을 먼저 내세울 필요는 없지만 묻는다면 숨기지 않는다. 1~2문장으로 답하고, 이미 같은 취지로 말했거나 할 말이 없을 때만 pass한다.`,
    );
  } else if (p.autoReply) {
    lines.push(
      '',
      '[자동 대리]',
      `${p.ownerName ?? '소유자'}님은 지금 이 Room에 접속해 있지 않다(위임을 남기지도 않았다). 당신은 짧게 자동으로 응대한다. say로 대화만 하고, 소유자가 정해야 할 일(일정·장소·금액 확정, 약속, 선호가 필요한 선택)은 말로 얼버무리지 말고 request_approval로 소유자에게 넘긴다. 소유자 이름으로 확정하거나 약속하지 않는다. 제공된 기억 밖의 사적인 사정은 말하지 않는다. 소유자를 3인칭 이름으로 부르고("OO님은 지금 자리에 안 계세요" 정도로만 밝힌다) 1~2문장으로 답한다.`,
    );
  }
  if (p.mandate) lines.push('', '[위임 범위(mandate)]', p.mandate.text, `허용된 행동: ${p.mandate.allowedActions.join(', ') || '(없음)'}`);
  lines.push('', '[사용할 수 있는 도구]', p.tools.map((t) => t.name).join(', '));
  if (p.forcedTool) lines.push('', `[이번 턴] 반드시 ${p.forcedTool}만 호출한다. 방문 턴 한도에 도달했다.`);
  return lines.join('\n');
}

/** 트리거별 마지막 지시. 일반 규칙("할 말이 없으면 pass")보다 우선한다 */
function closingHint(reason: Trigger['reason'], seedOwner = false, a2a: TurnA2A | null = null, seq = 0): string | null {
  if (reason === 'a2a_ask') {
    const asker = a2a?.role === 'answer' ? a2a.askerName : '다른 Agent';
    const roomAsker = a2a?.role === 'answer' && a2a.askerKind === 'room_agent';
    const handoff = seedOwner
      ? '승인 요청 도구는 없다. 소유자의 성격에 적힌 입장으로 say 한 가지만 답한다.'
      : '다른 사람의 Agent가 소유자의 약속·시간 확정을 요구하면 say로 얼버무리지 말고 request_approval로 소유자에게 넘기고 room_message에 질문자에게 줄 답을 적는다.';
    return `${asker}가 당신에게 물었다(#${a2a?.role === 'answer' ? a2a.askSeq : seq}). 소유자의 기억·성격·보드만 근거로 1~2문장 답한다(say). 답은 자동으로 질문자에게 간다. ${roomAsker ? '질문자가 Room Agent이므로 의견·가능 여부만 답한다(확정은 사람들의 승인으로 정해진다). ' : ''}${handoff} 지금 할 행동을 도구 하나로 고르라.`;
  }
  if (reason === 'a2a_collect') {
    return `당신의 질문 #${a2a?.role === 'collect' ? a2a.askSeq : seq}에 답이 모였다(↩#${a2a?.role === 'collect' ? a2a.askSeq : seq}). Room Agent: 관련 카드에 propose_edit(public_rationale에 누가 뭐라 했는지 한 줄), 의견이 갈리면 request_approval. Personal Agent: 소유자에게 say(to=소유자 id)로 결과를 전하고 소유자가 정할 일이면 request_approval. 지금 할 행동을 도구 하나로 고르라.`;
  }
  if (reason === 'auto_reply' && seedOwner) {
    return '방금 사람이 말했고 당신이 소유자 대신 응대하도록 깨워졌다. 성격에 적힌 입장·말투로 say로 1~2문장 자연스럽게 답한다(공감, 의견, 되묻기 중 하나). 승인 요청은 없다. 단순한 맞장구에는 pass해도 된다. 지금 할 행동을 도구 하나로 고르라.';
  }
  if (reason === 'room_agent_call') {
    return '사람이 방금 말했고 당신이 깨워졌다. 이 지시가 일반 규칙의 pass보다 우선한다: pass하지 말고 say로 1~2문장 짧게 반응한다(공감, 지금까지 정리, 다음 제안, 되묻기 중 하나). 이미 같은 내용을 방금 말했거나 정말 덧붙일 말이 없을 때만 pass. 지금 할 행동을 도구 하나로 고르라.';
  }
  if (reason === 'auto_reply') {
    return '소유자는 자리에 없다. 일정·시간·장소·가능 여부·선호처럼 소유자 본인이 답해야 하는 질문이면 say로 얼버무리거나 "확인해서 알려드릴게요"라고 약속하지 말고 반드시 request_approval(options 2~3개)을 호출하고 room_message에 안내 한 문장을 적는다. 그 밖의 가벼운 대화에는 say로 1~2문장 답한다. 지금 할 행동을 도구 하나로 고르라.';
  }
  return null;
}

export function buildUserPrompt(p: {
  roomTitle: string;
  trigger: Trigger;
  memories: readonly TurnMemory[];
  summary: string | null;
  board: readonly BoardCard[];
  /** 보드 도구. 생략하면 섹션을 만들지 않는다 */
  boardTools?: readonly BoardTool[];
  events: readonly RoomEvent[];
  name: (id: string | null) => string;
  /** `to`에 쓸 수 있는 대화 상대 (사람, Agent). 자기 자신은 제외 */
  participants?: readonly { id: string; name: string }[];
  seedOwner?: boolean;
  /** ask_agents로 물을 수 있는 Agent. 있을 때만 섹션을 만든다 */
  askable?: readonly AskableAgent[];
  a2a?: TurnA2A | null;
}): string {
  const mem = renderMemories(p.memories);
  const board = renderBoard(p.board);
  const toolLines = p.boardTools ? renderBoardToolSection(p.boardTools) : null;
  const events = renderEvents(p.events, p.name);
  return [
    `Room: ${p.roomTitle}`,
    `트리거: ${p.trigger.reason} (이벤트 #${p.trigger.seq})`,
    '',
    '[대화 상대 id] (say의 to에는 여기 있는 id만)',
    p.participants?.length ? p.participants.map((x) => `${x.name}=${x.id}`).join(', ') : '(없음)',
    '',
    ...(p.askable?.length
      ? ['[물어볼 수 있는 Agent] (ask_agents의 agent_ids에는 여기 있는 id만)', p.askable.map((x) => `${x.name}=${x.id} (소유자 ${x.ownerName}, 자리 비움)`).join(', '), '']
      : []),
    '[제공된 기억]',
    mem.length ? mem.join('\n') : '(없음)',
    '',
    '[Room 요약]',
    p.summary ? clipSummary(p.summary) : '(없음)',
    '',
    '[보드]',
    board.length ? board.join('\n') : '(카드 없음)',
    '',
    ...(toolLines ? ['[보드 도구]', toolLines.length ? toolLines.join('\n') : '(도구 없음)', ''] : []),
    '[최근 이벤트]',
    events.length ? events.join('\n') : '(없음)',
    '',
    closingHint(p.trigger.reason, p.seedOwner, p.a2a ?? null, p.trigger.seq) ?? '지금 할 행동을 도구 하나로 고르라.',
  ].join('\n');
}
