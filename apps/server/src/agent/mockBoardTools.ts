import { BOARD_TOOL_LIMITS, type RoomEvent } from '@ensemble/shared';
import type { ToolCall, TurnInput } from './types';

/**
 * Mock Agent의 보드 도구 판단(결정적, 난수 없음). decide()가 두 곳에서 호출한다:
 * Room Agent 블록 맨 앞, 그리고 불렸을 때(addressed)의 ping 처리 직후.
 *
 * 마지막 사람 발화만 본다(Agent·Room Agent 자신의 발화에는 반응하지 않아 루프가 없다).
 *  - 사다리: 사다리|제비뽑기|누가 살/쏠/사/낼/할|내기 → create_board_tool(ladder). 참가자 = Room의 사람들
 *  - 정산표: 정산|얼마씩|n빵|더치|나눠 내 → create_board_tool(settlement). 금액이 말에 있을 때만 지출 1건(지불자 = 발화자)
 *  - 여행 계획: 여행|일정 짜/잡|놀러|나들이|당일치기|N박 → create_board_tool(trip)
 *  - 자유형(custom): 투표 → vote 블록(선택지는 문장에서 읽히는 것만, 없으면 빈 선택지로 두고 사람이 추가),
 *    체크리스트|할 일 나누자 → checklist 블록(항목은 ':' 뒤 쉼표 목록에서만). 위 3종보다 먼저 판정한다.
 *  같은 종류의 도구가 이미 있으면 정산표만 expense_add로 이어 가고, 나머지는 null(기존 흐름).
 */

export const LADDER_RE = /사다리|제비\s*뽑|누가\s*(살|쏠|사|낼|할|쏘)|내기/;
export const SETTLE_RE = /정산|얼마씩|[nN엔]\s*빵|더치|나눠\s*(내|낼)/;
export const TRIP_RE = /여행|일정\s*(짜|잡)|놀러|나들이|당일치기|\d\s*박/;

export const VOTE_RE = /투표/;
export const CHECKLIST_RE = /체크\s*리스트|할\s*일\s*(나누|나눠|정리|적|만들|분담)|역할\s*분담/;

const MSG = {
  vote: '보드에 투표를 올려 뒀어요. 한 사람당 한 표씩 눌러 주세요.',
  voteEmpty: '보드에 투표를 올려 뒀어요. 선택지를 추가하고 한 표씩 눌러 주세요.',
  checklist: '보드에 체크리스트를 올려 뒀어요. 끝낸 일은 체크해 주세요.',
  ladder: '보드에 사다리를 올려 뒀어요. 준비되면 누군가 실행해 주세요.',
  settlement: '보드에 정산표를 올려 뒀어요. 빠진 지출이 있으면 추가해 주세요.',
  settlementAdd: '정산표에 지출을 추가해 뒀어요.',
  trip: '보드에 여행 계획을 올려 뒀어요. 가고 싶은 곳을 하나씩 채워 봐요.',
} as const;

/** 목적어로 쓰지 않는 말 ("오늘 누가 살까"의 "오늘") */
const NOT_OBJECT = /^(오늘|내일|이번|다음|지금|저녁|점심|아침|주말|그럼|그러면|자|우리|이제|다들|그냥)$/;

/** "커피 누가 살까" / "누가 커피 살까" → "커피 사기" 같은 결과 항목 문구. 목적어를 못 찾으면 null */
export function ladderOutcomeFrom(text: string): string | null {
  const m = /누가\s*([^?？!.,\n]*)/.exec(text);
  if (!m) return null;
  const verb = (v: string) =>
    v
      .replace(/^(살|사)(까요|까|지|래요|래)?$/, '사기')
      .replace(/^(쏠|쏘)(까요|까|지|래요|래)?$/, '쏘기')
      .replace(/^낼(까요|까|지|래요|래)?$/, '내기')
      .replace(/^할(까요|까|지|래요|래)?$/, '하기');
  const after = m[1]!.trim();
  const words = after.split(/\s+/).filter(Boolean);
  const lastVerb = verb(words.pop() ?? '');
  if (!/^(사기|쏘기|내기|하기)$/.test(lastVerb)) {
    // 동사 형태가 아니면 "누가 X" 전체를 하기로 묶는다
    return after && after.length <= 34 ? `${after} 하기` : null;
  }
  let obj = words.join(' ');
  if (!obj) {
    const before = text.slice(0, m.index).trim().split(/\s+/).filter(Boolean);
    const tok = before.at(-1);
    if (tok && !NOT_OBJECT.test(tok)) obj = tok;
  }
  return obj && obj.length + lastVerb.length < 38 ? `${obj} ${lastVerb}` : null;
}

/** 금액(원)을 말에서 읽는다. 없으면 null — 지어내지 않는다 */
export function parseAmount(text: string): number | null {
  const man = /(\d+(?:\.\d+)?)\s*만\s*원?/.exec(text);
  if (man) return Math.round(Number(man[1]) * 10000);
  const won = /(\d[\d,]*)\s*원/.exec(text);
  if (won) return Number(won[1]!.replace(/,/g, ''));
  return null;
}

/**
 * "A랑 B 중에", "A vs B", "A, B, C 중" 같은 말에서 선택지를 읽는다. 읽히지 않으면 [] — 지어내지 않는다.
 * 구분자(vs, 쉼표, 슬래시, 이랑/랑/와/과/하고, 또는/아니면/or)가 있고 "중"/"vs"/"or" 같은 단서가 있을 때만.
 */
export function voteOptionsFrom(text: string): string[] {
  const clause = (text.split(/[\n?？!.]/).find((c) => /투표|중에|중\s|vs|VS|아니면|또는|\bor\b/.test(c)) ?? '').trim();
  let seg = clause;
  const mid = /^(.*?)\s*중(?:에서|에|으로)?(?:\s|$)/.exec(clause);
  if (mid) seg = mid[1]!;
  else if (!/vs|VS|아니면|또는|\bor\b/.test(clause)) return [];
  seg = seg.replace(/\s*투표.*$/, '');
  const parts = seg
    .split(/\s*(?:,|，|、|\/|\bvs\b|VS|또는|아니면|\bor\b|이랑|하고|랑|와|과)\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length < 2) return [];
  const toks = (x: string) => x.split(/\s+/).filter(Boolean);
  // 첫 항목에만 앞말이 붙은 경우("점심 라멘이랑 국밥"): 나머지가 모두 한 단어면 첫 항목은 마지막 단어만
  if (toks(parts[0]!).length > 1 && parts.slice(1).every((x) => toks(x).length === 1)) parts[0] = toks(parts[0]!).at(-1)!;
  const out = [...new Set(parts)].filter((x) => x.length <= BOARD_TOOL_LIMITS.customOptionChars);
  return out.length >= 2 && out.length <= BOARD_TOOL_LIMITS.customVoteOptions ? out : [];
}

/** "체크리스트 만들어줘: 장보기, 청소" → ['장보기','청소']. ':' 뒤 목록이 없으면 [] */
export function checklistItemsFrom(text: string): string[] {
  const m = /[:：]\s*([^\n]+)/.exec(text);
  if (!m) return [];
  return m[1]!
    .split(/\s*(?:,|，|、|\/)\s*/)
    .map((x) => x.trim().replace(/[.!?？]+$/, ''))
    .filter((x) => x.length > 0 && x.length <= 60)
    .slice(0, BOARD_TOOL_LIMITS.customChecklist);
}

export function decideBoardTool(input: TurnInput): ToolCall | null {
  if (!input.tools.some((t) => t.name === 'create_board_tool')) return null;
  const addressed = input.trigger.reason === 'addressed' || input.trigger.reason === 'pointed';
  if (input.mode !== 'room' && !addressed) return null;

  const ev = input.trigger.event;
  if (!ev || ev.type !== 'message' || ev.actorKind !== 'human') return null;
  const text = ev.text;
  const tool = (name: 'create_board_tool' | 'update_board_tool', args: Record<string, unknown>): ToolCall => ({ name, input: args });

  // 이 사람 발화 뒤에 이미 도구가 만들어졌으면 다시 만들지 않는다(중복 생성 방지)
  if (input.events.some((e: RoomEvent) => e.seq > ev.seq && (e.type === 'board_tool_created' || (e.type === 'board_tool_updated' && e.op.op !== 'cover_set')))) return null;

  const who = input.names[ev.actorId ?? ''] ?? null;
  const members = input.members.map((m) => m.name).slice(0, 8);
  const existing = (kind: string) => input.boardTools.find((t) => t.kind === kind);

  if (VOTE_RE.test(text)) {
    const options = voteOptionsFrom(text);
    const prefix = (/^([^\n]*?)\s*투표/.exec(text)?.[1] ?? '').replace(/(을|를|에|에\s*대해서?|으로|로)$/, '').trim();
    const question = options.length > 0 ? '어느 쪽이 좋을까요?' : prefix && prefix.length <= 60 ? `${prefix}?` : '투표';
    return tool('create_board_tool', {
      kind: 'custom',
      title: '투표',
      blocks: [{ type: 'vote', question, options }],
      room_message: options.length > 0 ? MSG.vote : MSG.voteEmpty,
    });
  }

  if (CHECKLIST_RE.test(text)) {
    return tool('create_board_tool', {
      kind: 'custom',
      title: '체크리스트',
      blocks: [{ type: 'checklist', title: '할 일', items: checklistItemsFrom(text) }],
      room_message: MSG.checklist,
    });
  }

  if (LADDER_RE.test(text)) {
    if (existing('ladder') || members.length < 2) return null;
    const outcome = ladderOutcomeFrom(text);
    return tool('create_board_tool', {
      kind: 'ladder',
      title: outcome ? `누가 ${outcome}?` : '사다리타기',
      participants: members,
      outcomes: [outcome ?? '당첨', '꽝'],
      room_message: MSG.ladder,
    });
  }

  if (SETTLE_RE.test(text)) {
    const amount = parseAmount(text);
    const prev = existing('settlement');
    if (prev) {
      if (!amount || !who) return null;
      return tool('update_board_tool', { tool_id: prev.toolId, op: 'expense_add', payer: who, amount, room_message: MSG.settlementAdd });
    }
    return tool('create_board_tool', {
      kind: 'settlement',
      title: '정산표',
      participants: members,
      expenses: amount && who ? [{ payer: who, amount }] : [],
      room_message: MSG.settlement,
    });
  }

  if (TRIP_RE.test(text)) {
    if (existing('trip')) return null;
    const nights = /(\d)\s*박/.exec(text);
    return tool('create_board_tool', {
      kind: 'trip',
      title: '여행 계획',
      days: nights ? Math.min(14, Number(nights[1]) + 1) : 1,
      checklist: ['준비물 정하기'],
      room_message: MSG.trip,
    });
  }

  return null;
}
