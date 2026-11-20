import type { BoardCard, RoomEvent } from '@ensemble/shared';
import { CHECKLIST_RE, LADDER_RE, SETTLE_RE, TRIP_RE, VOTE_RE } from './mockBoardTools';
import type { ToolCall, TurnInput } from './types';

/**
 * Mock Agent의 A2A(Agent↔Agent)·A2H 판단 (결정적). mock.ts의 decide()가 forcedTool 블록 바로 다음에 부른다.
 * 해당이 없으면 null을 돌려 기존 흐름을 그대로 탄다.
 *
 * 규칙(위에서부터)
 *  A. a2a_ask(답 턴)     질문자가 Personal Agent이고 request_approval을 쓸 수 있으면 → request_approval(소유자에게 넘김)
 *                        그 외에는 say(Agent별 대사. 서버가 to=질문자·replyTo를 붙인다)
 *  B. a2a_collect(정리)  Room Agent: 방별 시드 카드에 propose_edit(없으면 say 요약) / Personal Agent: 소유자에게 say(to=소유자)
 *  C. approval_resolved  approved + option + propose_edit 가능 + **A2A에서 나온 승인**이면 propose_edit. 아니면 null(기존 say)
 *  D. Room Agent가 사람 메시지(SLOT_RE+COORD_RE)로 깨어났고 ask_agents가 있으면 → ask_agents(방별 질문 템플릿)
 *  E. Personal Agent가 소유자 메시지(addressed)로 깨어났고 SLOT_RE+COORD_RE, 문장에 askable 소유자 이름이 있으면 → ask_agents
 * D·E는 보드 도구 정규식(사다리·정산표·여행·투표·체크리스트)이 먼저 맞으면 양보한다(null → 기존 보드 도구 분기가 처리).
 */

export const SLOT_RE = /((월|화|수|목|금|토|일)요일\s*)?((오전|오후|저녁|점심)\s*)?\d{1,2}\s*시(\s*(반|\d{1,2}\s*분))?/;
export const COORD_RE = /당겨|당길|옮겨|옮길|미뤄|미룰|맞춰|조율|괜찮|가능|어때|할까|될까/;
const CLOCK_RE = /\d{1,2}\s*시(\s*(반|\d{1,2}\s*분))?/;
const DAY_RE = /(월|화|수|목|금|토|일)요일/;
const MEAL_RE = /(오전|오후|저녁|점심)\s*/;

type Ev = Extract<RoomEvent, { type: 'message' }>;

/** 보드 도구 의도(사다리·정산표·여행·투표·체크리스트): 맞으면 A2A 질문은 양보한다. 도구가 이미 있어도 마찬가지(기존 흐름이 처리) */
const BOARD_INTENT = [LADDER_RE, SETTLE_RE, TRIP_RE, VOTE_RE, CHECKLIST_RE];

/** 받침 유무로 조사를 고른다 (한글은 유니코드로, 라틴 이름은 끝 글자로 어림, "Agent"는 에이전트라 받침 없음) */
function hasBatchim(word: string): boolean {
  const w = word.trim();
  if (/agent$/i.test(w)) return false;
  const c = w.at(-1) ?? '';
  const code = c.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (/\d/.test(c)) return '0136780'.includes(c);
  return /[bdgklmnp]/i.test(c);
}
export const iga = (w: string) => `${w}${hasBatchim(w) ? '이' : '가'}`;
export const eunNeun = (w: string) => `${w}${hasBatchim(w) ? '은' : '는'}`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 방별 시드 카드 (없으면 첫 번째 미합의 카드) */
const SEED_CARD: Record<string, string> = {
  room_our_family: 'c_seed_family_lunch',
  room_our_team: 'c_seed_team_retro',
  room_our_friends: 'c_seed_friends_movie',
};

export function slotOf(text: string): string | null {
  const m = SLOT_RE.exec(text);
  return m ? m[0].trim() : null;
}

/** 문맥의 요일을 붙이고, 가족 방은 카드에 "점심"이 있으니 식사 단어를 뺀 표현 ("토요일 12시 반") */
function whenOf(slotRaw: string | null, context: string, roomId: string): string | null {
  if (!slotRaw) return null;
  let s = slotRaw;
  if (!DAY_RE.test(s)) {
    const day = DAY_RE.exec(context)?.[0];
    if (day) s = `${day} ${s}`;
  }
  if (roomId === 'room_our_family') s = s.replace(MEAL_RE, '');
  return s.replace(/\s+/g, ' ').trim();
}

const clockOf = (s: string | null): string | null => (s ? (CLOCK_RE.exec(s)?.[0].replace(/\s+/g, ' ') ?? null) : null);

/** 방별 카드 본문 */
export function cardBody(card: BoardCard, roomId: string, when: string): string {
  if (roomId === 'room_our_family') return `${when}, 집에서 점심. 메뉴는 백숙(엄마가 준비)과 구이(아빠가 담당).`;
  if (roomId === 'room_our_friends') return `${when}, 영화 + 저녁 식사. 장소는 아직 미정.`;
  const clock = clockOf(when);
  if (clock && CLOCK_RE.test(card.body)) return card.body.replace(CLOCK_RE, clock);
  return `${when} · ${card.body}`;
}

function targetCard(input: TurnInput): BoardCard | null {
  const seeded = SEED_CARD[input.roomId] ? input.board.find((c) => c.cardId === SEED_CARD[input.roomId] && !c.deleted) : undefined;
  return seeded ?? input.board.find((c) => !c.agreed && !c.deleted) ?? null;
}

export function decideA2A(input: TurnInput): ToolCall | null {
  const has = (t: string) => input.tools.some((x) => x.name === t);
  const call = (name: ToolCall['name'], args: Record<string, unknown>): ToolCall => ({ name, input: args });
  const pass = () => call('pass', { reason: 'nothing_to_add' });
  const nameOf = (id: string | null | undefined) => (id ? (input.names[id] ?? id) : '누군가');
  const ev = input.trigger.event;
  const msg: Ev | null = ev?.type === 'message' ? ev : null;
  const a2a = input.a2a;
  const reason = input.trigger.reason;

  // A. 답 턴
  if (reason === 'a2a_ask' && a2a?.role === 'answer') {
    const owner = input.agent.ownerName ?? nameOf(input.agent.id);
    const raw = slotOf(a2a.question);
    const when = whenOf(raw, a2a.question, input.roomId);
    const clock = clockOf(raw) ?? clockOf(when);
    const memFor = (re: RegExp) => input.memories.find((m) => re.test(m.text));
    const withMem = (m: { id: string } | undefined) => (m ? { used_memory_ids: [m.id] } : {});

    if (a2a.askerKind === 'personal' && has('request_approval')) {
      const mem = input.memories[0];
      const topic = /영화/.test(a2a.question) ? '영화를' : '일정을';
      const slotText = when ?? '그 시간';
      return call('request_approval', {
        question: `${iga(a2a.askerName)} ${slotText} ${topic} 제안했어요. 이대로 할까요?`,
        options: [`${slotText} 좋아요`, '다른 시간으로'],
        room_message: `${mem ? `${clip(mem.text, 30)} (기억) ` : ''}${when ? `${eunNeun(clock ?? when)} ` : ''}${owner}님께 확인을 요청해 뒀어요.`,
        public_rationale: '약속이 걸린 일이라 제가 정하지 않고 소유자에게 넘겼어요.',
        ...withMem(mem),
      });
    }
    if (!has('say')) return pass();
    const w = when ?? '그 시간';
    const c = clock ?? w;
    if (input.agent.id === 'ag_mom') {
      return call('say', { text: `${w}이면 좋다. 장은 오전에 내가 보고, 백숙 해 줄게.`, ...withMem(memFor(/장/)) });
    }
    if (input.agent.id === 'ag_dad') {
      const m = memFor(/등산/);
      return call('say', { text: `${c}이면 좋아요. 등산 다녀와서 고기는 내가 구울게요.`, ...withMem(m) });
    }
    if (input.agent.id === 'ag_dana') return call('say', { text: `${c}이면 괜찮아요. 대신 30분 안에 끝내요.` });
    if (input.agent.id === 'ag_bob') {
      const m = memFor(/16시/);
      if (m) return call('say', { text: `오히려 좋아요 ㅋㅋ 16시에 고객 미팅이 있어서 ${c} 시작이면 여유 있어요.`, used_memory_ids: [m.id] });
      return call('say', { text: `${w}이면 나도 괜찮아 ㅋㅋ` });
    }
    return call('say', { text: `${owner}님 입장에서는 ${w} 괜찮아 보여요. 확정은 사람들이 정해 주세요.` });
  }

  // B. 정리 턴
  if (reason === 'a2a_collect' && a2a?.role === 'collect') {
    if (input.mode === 'room') {
      const raw = slotOf(a2a.question);
      const when = whenOf(raw, a2a.question, input.roomId);
      const card = targetCard(input);
      const summary = a2a.answers.map((a) => `${a.name}: ${clip(a.text, 36)}`).join(' / ');
      if (card && when && has('propose_edit')) {
        return call('propose_edit', {
          card_id: card.cardId,
          body: cardBody(card, input.roomId, when),
          public_rationale: summary || '답을 모아 정리했어요.',
        });
      }
      return has('say') ? call('say', { text: `정리해 볼게요. ${summary || '아직 받은 답이 없어요.'}` }) : pass();
    }
    // Personal Agent: 소유자에게 보고(A2H)
    const ownerId = input.agent.ownerId;
    if (!has('say') || !ownerId) return pass();
    const parts = a2a.answers.map((a) => `${a.name} 답이에요: "${clip(a.text, 60)}"${a.approvalPending ? ` 시간은 ${iga(a.ownerName ?? '상대')} 직접 확인 중이에요. 정해지면 카드에 반영돼요.` : ''}`);
    return call('say', { text: `${input.agent.ownerName ?? ''}님, ${parts.join(' ') || '아직 받은 답이 없어요.'}`.trim(), to: ownerId });
  }

  // C. A2A에서 나온 승인이 해소됨 → 카드 수정안
  if (ev?.type === 'approval_resolved') {
    if (ev.outcome === 'approved' && ev.option && has('propose_edit') && isA2AApproval(input, ev.approvalId)) {
      const card = targetCard(input);
      const when = whenOf(slotOf(ev.option), ev.option, input.roomId) ?? ev.option;
      if (card) {
        return call('propose_edit', {
          card_id: card.cardId,
          body: cardBody(card, input.roomId, when),
          public_rationale: `${input.agent.ownerName ?? nameOf(input.agent.id)} 승인: ${ev.option}`,
        });
      }
    }
    return null;
  }

  // D·E. 질문 시작. 보드 도구 정규식이 먼저 맞으면 양보한다.
  if (msg && msg.actorKind === 'human' && has('ask_agents') && input.askable.length > 0) {
    const text = msg.text;
    const raw = slotOf(text);
    if (!raw || !COORD_RE.test(text)) return null;
    if (BOARD_INTENT.some((re) => re.test(text))) return null;
    const when = whenOf(raw, text, input.roomId)!;
    const proposer = nameOf(msg.actorId);

    // D. Room Agent
    if (input.mode === 'room' && reason === 'room_agent_call') {
      const ids = input.askable.map((a) => a.id);
      const names = input.askable.map((a) => `${a.name}님`).join(', ');
      const owners = input.askable.map((a) => a.ownerName).join('·');
      let question: string;
      if (input.roomId === 'room_our_family') question = `${names}, ${iga(proposer)} ${when} 점심을 제안했어요. ${owners} 일정과 메뉴 의견 부탁해요.`;
      else if (input.roomId === 'room_our_team') question = `${names}, 회고를 ${when}으로 30분 당기려 해요. 일정 괜찮을까요?`;
      else question = `${names}, ${iga(proposer)} ${when}을 제안했어요. 괜찮을까요?`;
      return call('ask_agents', { agent_ids: ids, question });
    }

    // E. Personal Agent: 소유자가 직접 시킨 조율 (문장에 askable 소유자 이름이 있을 때)
    if (input.mode !== 'room' && reason === 'addressed' && msg.actorId === input.agent.ownerId) {
      const targets = input.askable.filter((a) => text.includes(a.ownerName));
      if (targets.length > 0) {
        const topic = /영화/.test(text) ? '영화를' : '일정을';
        const names = targets.map((a) => `${a.name}님`).join(', ');
        const who = targets.map((a) => a.ownerName).join('·');
        return call('ask_agents', {
          agent_ids: targets.map((a) => a.id),
          question: `${names}, ${iga(proposer)} ${when} ${topic} 제안해요. ${who}도 괜찮을까요?`,
        });
      }
    }
  }
  return null;
}

/** 이 승인이 A2A 답 턴에서 나온 것인가: 같은 turnId에 replyTo가 있는 message가 있다 */
function isA2AApproval(input: TurnInput, approvalId: string): boolean {
  const req = input.events.find((e) => e.type === 'approval_requested' && e.approvalId === approvalId);
  if (!req?.turnId) return false;
  return input.events.some((e) => e.type === 'message' && e.turnId === req.turnId && e.replyTo !== undefined);
}
