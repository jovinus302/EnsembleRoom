import type { BoardCard, Mandate, RoomEvent } from '@ensemble/shared';
import type { ToolSpec, TurnMemory, TurnMode, Trigger } from './types';

/**
 * 프롬프트 조립 (계획 6절 프롬프트). 상한 약 9k 토큰:
 *   기억 1.5k, Room 요약 0.6k, 최근 이벤트 3k, 보드 1.5k + 규칙·persona·mandate.
 * 토큰 수는 보수적으로 `글자수 / 2`로 어림한다(한국어 위주).
 */

export const TOKEN_BUDGET = { memories: 1500, summary: 600, events: 3000, board: 1500 } as const;
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
    '당신은 이 Our Room의 중립 조율자(Room Agent)다. 편을 들지 않는다. 요약하고, 의견이 갈리면 선택지 2~3개로 request_approval을 올리고, 합의 카드를 정리한다. 지목되면 답하되 결정하지 않는다.',
};

export function buildSystemPrompt(p: {
  mode: TurnMode;
  agentName: string;
  ownerName: string | null;
  personaPublic: string;
  mandate: Mandate | null;
  tools: readonly ToolSpec[];
  forcedTool: string | null;
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
    '- 한국어 존댓말 메신저 말투로, 1~3문장(120자 안팎)으로 짧게 쓴다. 인사말·맺음말·이모지·마크다운(**, #, 목록)은 쓰지 않는다.',
    '- 카드 id(c_...)·이벤트 번호·내부 id를 문장에 쓰지 않는다. 카드는 제목으로, 사람은 이름으로 부른다.',
    '- 되묻기보다 제공된 정보로 바로 답한다. 정보가 정말 없을 때만 한 가지만 묻는다.',
    '',
    '[도구 선택 기준]',
    '- 질문·대화에 답하기: say. 사람에게 답할 때는 to를 생략한다. to는 [대화 상대 id]에 있는 id만 쓰고, 다른 Agent를 부를 때만 쓴다.',
    '- 일정·장소·메뉴를 확정하거나, 소유자가 정하지 않은 선택지가 갈릴 때: request_approval(options 2~3개, 질문은 한 문장). "승인 요청하겠다"는 말을 say로 하지 말고 request_approval을 직접 호출한다.',
    '- 카드 id가 필요한 도구(comment, propose_edit·edit_board의 update/delete)에는 [보드]의 대괄호 안 id만 쓴다. 없는 카드를 지어내지 않는다.',
    '- 소유자가 "기억해 줘"라고 하면 remember(핵심만 한 문장).',
    '',
    '[현재 모드]',
    MODE_RULES[p.mode],
  ];
  if (p.mandate) lines.push('', '[위임 범위(mandate)]', p.mandate.text, `허용된 행동: ${p.mandate.allowedActions.join(', ') || '(없음)'}`);
  lines.push('', '[사용할 수 있는 도구]', p.tools.map((t) => t.name).join(', '));
  if (p.forcedTool) lines.push('', `[이번 턴] 반드시 ${p.forcedTool}만 호출한다. 방문 턴 한도에 도달했다.`);
  return lines.join('\n');
}

export function buildUserPrompt(p: {
  roomTitle: string;
  trigger: Trigger;
  memories: readonly TurnMemory[];
  summary: string | null;
  board: readonly BoardCard[];
  events: readonly RoomEvent[];
  name: (id: string | null) => string;
  /** `to`에 쓸 수 있는 대화 상대 (사람, Agent). 자기 자신은 제외 */
  participants?: readonly { id: string; name: string }[];
}): string {
  const mem = renderMemories(p.memories);
  const board = renderBoard(p.board);
  const events = renderEvents(p.events, p.name);
  return [
    `Room: ${p.roomTitle}`,
    `트리거: ${p.trigger.reason} (이벤트 #${p.trigger.seq})`,
    '',
    '[대화 상대 id] (say의 to에는 여기 있는 id만)',
    p.participants?.length ? p.participants.map((x) => `${x.name}=${x.id}`).join(', ') : '(없음)',
    '',
    '[제공된 기억]',
    mem.length ? mem.join('\n') : '(없음)',
    '',
    '[Room 요약]',
    p.summary ? clipSummary(p.summary) : '(없음)',
    '',
    '[보드]',
    board.length ? board.join('\n') : '(카드 없음)',
    '',
    '[최근 이벤트]',
    events.length ? events.join('\n') : '(없음)',
    '',
    '지금 할 행동을 도구 하나로 고르라.',
  ].join('\n');
}
