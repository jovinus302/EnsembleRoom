import type { RoomEvent, ToolName } from '@ensemble/shared';
import { decideA2A } from './mockA2A';
import { decideBoardTool } from './mockBoardTools';
import { isTrivialReaction } from './rules';
import type { AgentProvider, ProviderEvent, ToolCall, TurnInput } from './types';

/**
 * AGENT_MODE=mock: LLM 없이 결정적으로 도구 호출을 만든다 (계획 6절).
 * 같은 입력이면 항상 같은 결과다. 일하는 모습이 보이도록 단계별 활동(phase)과 텍스트 스트림을 흉내 낸다.
 *
 * 규칙 요약
 *  - 방문 턴 상한(forcedTool=end_visit) → end_visit
 *  - 방문 도착 → 인사(say)
 *  - 불렸을 때: "확정/결정" → request_approval, "기억" → remember, "수정/제안"·카드 지목 → propose_edit,
 *    "카드/보드" → edit_board(권한이 없으면 propose_edit), 그 외 → say
 *    권한이 없는 도구가 필요하면 pass(outside_mandate)
 *  - 다른 Agent가 "ping"을 담아 불렀으면 "pong"으로 되돌려 말한다 (연쇄 상한 시연·테스트용)
 *  - 동행 중 불리지 않았으면 pass, 대리·방문 중에는 질문이면 답하고 카드 변화에는 코멘트
 *  - Room Agent: 질문·"정리"면 요약, "확정"이면 선택지 2개로 request_approval
 *  - A2A(mockA2A.ts): 부재 구성원 Agent에게 ask_agents → 답 → 정리(propose_edit) 흐름. 시각·조율 표현("14시 반 어때")이 있을 때만
 */

export interface MockOptions {
  /** 단계 사이 지연(ms). 0이면 지연 없음 */
  delayMs?: number;
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

const isQuestion = (t: string) => /[?？]/.test(t);

type Ev = Extract<RoomEvent, { type: 'message' }>;

/** 방별 Room Agent 꼬리말 (결정적) */
const ROOM_TAIL: Record<string, string> = {
  room_our_family: '식사 이야기면 카드 "주말 가족 점심"에 모아 둘게요. 엄마·아빠 의견도 들어 보죠.',
  room_our_team: '일정이면 카드에 정리해 둘게요. 범위와 시간만 정하면 됩니다.',
  room_our_friends: '모일 날짜와 장소를 한 가지씩 정해 볼까요? 카드 "주말 저녁 영화 모임"에 적어 둘게요.',
};

/** 시드 인물(엄마·아빠·Dana)과 Bob의 대사. 말투는 persona(seed.ts)와 같다. 해당 없으면 null */
function personaLine(agentId: string, roomId: string, text: string): string | null {
  if (agentId === 'ag_mom') {
    if (/아프|감기|피곤|힘들|건강|다쳤/.test(text)) return '밥은 챙겨 먹었니? 따뜻하게 입고 무리하지 말렴.';
    if (/일요일|오전|행사/.test(text)) return '일요일 오전엔 가족 행사가 있잖니. 그 뒤로 하자.';
    if (/점심|저녁|밥|식사|먹/.test(text)) return '그래, 밥은 내가 준비할게. 일요일 오전은 행사니까 토요일이 좋겠다.';
    if (/주말|토요일|언제|어때/.test(text)) return '주말이면 토요일이 좋겠다. 장은 내가 볼게.';
    return '그래, 알았다. 밥 거르지 말고 챙겨 먹으렴.';
  }
  if (agentId === 'ag_dad') {
    if (/아프|감기|피곤|힘들|건강|다쳤/.test(text)) return '그래, 몸부터 챙기자. 운전할 일 있으면 말하렴.';
    if (/일요일|오전|행사/.test(text)) return '그래, 일요일 오전은 행사니까 그 뒤로 하마.';
    if (/점심|저녁|밥|식사|먹|고기/.test(text)) return '고기는 내가 구우마. 운전도 맡으마.';
    if (/주말|토요일|언제|어때/.test(text)) return '토요일 아침엔 등산 다녀오마. 12시 이후면 된다.';
    return '그래, 알았다.';
  }
  if (agentId === 'ag_dana') {
    if (/회의|회고|미팅/.test(text)) return '회의는 30분 안에 끝냈으면 해요. 아젠다만 미리 카드에 적어 두면 좋겠어요.';
    if (/금요일|시간|언제|\d\s*시/.test(text)) return '금요일 15시에 30분이면 저는 괜찮아요. 범위만 미리 정해 두죠.';
    if (/범위|스프린트|일정|마감|점심/.test(text)) return '일정과 범위는 카드 기준으로 맞춰요. 마감이 밀리지 않게 확인할게요.';
    return '네, 확인했어요. 일정과 범위만 정리되면 저는 진행할게요.';
  }
  if (agentId === 'ag_bob') {
    if (/영화/.test(text)) return '영화 좋지! 난 팝콘 담당할게 ㅋㅋ';
    if (roomId === 'room_our_team') return '오 좋은데요? 저는 다 괜찮아요 ㅋㅋ 시간만 정해지면 갈게요.';
    if (/토요일|저녁|주말|언제/.test(text)) return '토요일 저녁이면 나 가능해! 장소만 정해지면 바로 가자.';
    return '오 좋은데? 나는 다 괜찮아 ㅋㅋ';
  }
  return null;
}

/** 도구 호출을 정한다. 순수 함수 — 테스트에서 직접 호출해도 된다. */
export function decide(input: TurnInput): ToolCall {
  const has = (t: ToolName) => input.tools.some((x) => x.name === t);
  const call = (name: ToolName, args: Record<string, unknown>): ToolCall => ({ name, input: args });
  const pass = (reason: 'not_addressed' | 'nothing_to_add' | 'waiting_for_human' | 'outside_mandate') => call('pass', { reason });
  const me = input.agent.id;
  const nameOf = (id: string | null | undefined) => (id ? (input.names[id] ?? id) : '누군가');
  const ev = input.trigger.event;
  const msg: Ev | null = ev?.type === 'message' ? ev : null;
  const text = msg?.text ?? '';
  const memIds = input.memories.slice(0, 1).map((m) => m.id);
  const cite = input.memories[0] ? ` (기억: ${clip(input.memories[0].text, 40)})` : '';
  const rationale = { public_rationale: '요청 내용이 확정·승인이 필요한 사안이라 직접 정하지 않았습니다.' };

  // 방문 턴 상한: 공개 takeout과 소유자용 보고
  if (input.forcedTool === 'end_visit') {
    const seen = input.events.filter((e) => e.type === 'message').length;
    return call('end_visit', {
      public_takeout: `${input.roomTitle}에서 ${seen}개의 대화를 나눴고, 위임 범위(${input.mandate?.text ?? '없음'}) 안에서만 이야기했습니다.`,
      report_for_owner: `${input.roomTitle} 방문을 마쳤습니다. 본 대화 ${seen}건. 확정된 것은 없고, 필요하면 승인으로 넘겼습니다.`,
    });
  }

  // A2A·A2H: 답 턴(a2a_ask)·정리 턴(a2a_collect)·A2A에서 나온 승인 해소·질문 시작(ask_agents). 해당이 없으면 null.
  const a2a = decideA2A(input);
  if (a2a) return a2a;

  // 내가 올린 decision 승인이 해소됨: 결과를 이어서 처리
  if (ev?.type === 'approval_resolved') {
    if (!has('say')) return pass('nothing_to_add');
    return call('say', {
      text:
        ev.outcome === 'rejected'
          ? '승인되지 않았어요. 일단 보류하고 다른 방법을 찾아볼게요.'
          : `승인되었어요${ev.option ? `: "${ev.option}"` : ''}. 이 결정대로 이어서 진행할게요.`,
    });
  }

  // 도착 인사
  if (input.trigger.reason === 'arrival') {
    const greeting = `안녕하세요, ${input.agent.ownerName ?? nameOf(me)}님을 대신해 방문했습니다. ${input.mandate ? `${clip(input.mandate.text, 60)} 범위에서 이야기 나눌게요.` : ''}`.trim();
    if (has('say')) return call('say', { text: greeting });
    return pass('nothing_to_add');
  }

  // Room Agent: 중립 조율
  if (input.mode === 'room') {
    const bt = decideBoardTool(input);
    if (bt) return bt;
    if (/확정|결정/.test(text) && has('request_approval')) {
      return call('request_approval', {
        question: `이 내용을 확정할까요? "${clip(text, 60)}"`,
        options: ['확정', '조금 더 논의'],
        ...rationale,
      });
    }
    if (msg?.to === me || isQuestion(text) || /정리|요약/.test(text)) {
      const lines = input.events.filter((e): e is Ev => e.type === 'message' && e.actorKind !== 'room_agent').slice(-3);
      const recap = lines.map((m) => `${nameOf(m.actorId)}: ${clip(m.text, 30)}`).join(' / ');
      return has('say') ? call('say', { text: `정리해 볼게요. ${recap || '아직 나온 이야기가 없어요.'}` }) : pass('nothing_to_add');
    }
    // 자동 반응: 사람이 평범하게 말해도 짧게 반응한다 (2글자 이하 반응은 pass)
    if (msg && msg.actorKind === 'human' && text.trim() && has('say')) {
      if (isTrivialReaction(text)) return pass('nothing_to_add');
      const tail = ROOM_TAIL[input.roomId] ?? '다른 분들 의견도 모아 볼까요? 정할 게 있으면 말씀해 주세요.';
      return call('say', { text: `${nameOf(msg.actorId)}님, "${clip(text, 30)}" 좋아요. ${tail}` });
    }
    return pass('not_addressed');
  }

  // 자동 대리: 소유자가 접속하지 않았고 Leave도 하지 않았다. 대화만 하고 소유자가 정할 일은 승인으로 넘긴다.
  if (input.trigger.reason === 'auto_reply') {
    const owner = input.agent.ownerName ?? nameOf(me);
    if (!msg || !text.trim()) return pass('nothing_to_add');
    if (isTrivialReaction(text)) return pass('nothing_to_add');
    // 인물 설정(엄마·Dana·Bob)에 맞는 대사. 승인 도구가 있는 사람(Bob)은 소유자가 정할 일이면 아래 승인 요청이 먼저다.
    const persona = personaLine(input.agent.id, input.roomId, text);
    const needsOwner = /확정|결정|요일|\d\s*시|오전|오후|약속|만나|모이/.test(text) && has('request_approval');
    if (persona && !needsOwner && has('say')) {
      return call('say', { text: persona, ...(memIds.length ? { used_memory_ids: memIds } : {}) });
    }
    if (needsOwner) {
      return call('request_approval', {
        question: `${nameOf(msg.actorId)}님의 제안 "${clip(text, 50)}", ${owner}님이 정해야 할 일이에요. 어떻게 할까요?`,
        options: ['좋아요', '다른 때로'],
        room_message: `${owner}님은 지금 자리에 안 계셔서, 확인을 요청해 두었어요.`,
        ...rationale,
      });
    }
    if (has('say')) {
      return call('say', {
        text: `${owner}님은 지금 자리에 안 계세요. 대신 말씀드리면, "${clip(text, 40)}" 잘 봤어요. 정해야 할 일이면 ${owner}님께 넘길게요.${cite}`,
        ...(memIds.length ? { used_memory_ids: memIds } : {}),
      });
    }
    return pass('nothing_to_add');
  }

  const addressed = input.trigger.reason === 'addressed' || input.trigger.reason === 'pointed' || msg?.to === me;
  const pointedCard = ev?.type === 'card_pointed' ? ev.cardId : undefined;

  if (addressed) {
    // 연쇄 시연: 사람이 "ping <agentId>"로 시키면 그 Agent에게 ping을 보내고, Agent가 ping으로 불렀으면 ping으로 되받는다.
    const fromAgent = msg?.actorKind === 'agent' || msg?.actorKind === 'room_agent';
    const pingTarget = /ping\s+([\w-]+)/i.exec(text)?.[1];
    if (msg && /ping/i.test(text) && has('say') && (fromAgent ? msg.actorId : pingTarget)) {
      return call('say', { text: `ping (${nameOf(me)})`, to: fromAgent ? msg.actorId : pingTarget });
    }
    const bt = decideBoardTool(input);
    if (bt) return bt;
    if (/확정|결정/.test(text)) {
      if (has('request_approval')) {
        return call('request_approval', { question: `확정할까요? "${clip(text, 60)}"`, options: ['확정', '보류'], ...rationale });
      }
      // 방문 중에는 승인 도구가 없다: 침묵하지 않고 직접 정할 수 없다고 말하고 소유자에게 메모를 남긴다
      if (has('say')) {
        return call('say', {
          text: `${nameOf(msg?.actorId)}님, 확정은 제가 정할 수 없어요. ${input.agent.ownerName ?? '소유자'}님께 전달해 둘게요.`,
          ...(msg?.actorId ? { to: msg.actorId } : {}),
          owner_note: `"${clip(text, 60)}" 확정 요청이 있었어요. 제가 정하지 않고 남겨 둡니다.`,
        });
      }
      return pass('outside_mandate');
    }
    if (/기억/.test(text)) {
      return has('remember')
        ? call('remember', { text: clip(text.replace(/기억해( 줘| 주세요)?/g, '').trim() || text, 200), kind: 'fact' })
        : pass('outside_mandate');
    }
    if (pointedCard || /수정|제안/.test(text)) {
      if (has('propose_edit')) {
        return call('propose_edit', {
          ...(pointedCard ? { card_id: pointedCard } : {}),
          title: pointedCard ? undefined : `제안: ${clip(text, 30)}`,
          body: `${nameOf(me)}의 제안 — ${clip(text || '지목된 카드를 다듬어 보겠습니다.', 120)}`,
        });
      }
      if (pointedCard && has('comment')) return call('comment', { card_id: pointedCard, text: '확인했습니다. 수정은 승인 후에 진행할게요.' });
      return pass('outside_mandate');
    }
    if (/카드|보드/.test(text)) {
      if (has('edit_board')) return call('edit_board', { op: 'create', title: clip(text, 30), body: `${nameOf(me)}가 추가함` });
      if (has('propose_edit')) return call('propose_edit', { title: clip(text, 30), body: `${nameOf(me)}의 제안` });
      return pass('outside_mandate');
    }
    if (has('say')) {
      return call('say', {
        text: `${nameOf(msg?.actorId)}님, "${clip(text, 40)}" 확인했어요.${cite}`,
        ...(msg?.actorId ? { to: msg.actorId } : {}),
        ...(memIds.length ? { used_memory_ids: memIds } : {}),
      });
    }
    return pass('outside_mandate');
  }

  // 불리지 않았을 때
  if (input.mode === 'accompanied' || input.mode === 'member') return pass(input.mode === 'accompanied' ? 'nothing_to_add' : 'not_addressed');

  // 대리·방문 중: 위임 범위 안에서 스스로 한다
  if (ev?.type === 'card_created' || ev?.type === 'card_updated') {
    return has('comment') ? call('comment', { card_id: ev.cardId, text: '확인했습니다. 위임 범위에서는 문제 없어 보여요.' }) : pass('nothing_to_add');
  }
  if (msg && isQuestion(text)) {
    return has('say')
      ? call('say', { text: `제가 아는 범위에서 답해 볼게요: "${clip(text, 40)}"에 대해서는 소유자 확인이 필요한 부분을 빼고 협조할게요.${cite}`, ...(memIds.length ? { used_memory_ids: memIds } : {}) })
      : pass('outside_mandate');
  }
  return pass('nothing_to_add');
}

/** 보낼 텍스트가 있는 도구의 스트리밍 필드 */
function streamedText(call: ToolCall): string | null {
  if (call.name === 'say' || call.name === 'comment') return String(call.input.text ?? '');
  if (call.name === 'ask_agents') return String(call.input.question ?? '');
  return null;
}

export class MockProvider implements AgentProvider {
  readonly name = 'mock';
  constructor(private readonly opts: MockOptions = {}) {}

  async *stream(input: TurnInput, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
    const delay = this.opts.delayMs ?? 0;
    const stop = () => signal?.aborted;

    yield { type: 'phase', phase: 'thinking' };
    await sleep(delay);
    if (input.memories.length > 0) {
      yield { type: 'phase', phase: 'recalling' };
      await sleep(delay);
    }
    if (stop()) return;

    const call = decide(input);
    if (call.name !== 'pass') {
      yield { type: 'phase', phase: 'writing' };
      yield { type: 'tool_start', tool: call.name };
      const to = call.input.to;
      if (typeof to === 'string') yield { type: 'target', to };
      const text = streamedText(call);
      if (text) {
        const chunk = 6;
        for (let i = 0; i < text.length && !stop(); i += chunk) {
          yield { type: 'text_delta', tool: call.name, delta: text.slice(i, i + chunk) };
          await sleep(Math.round(delay / 8));
        }
      } else {
        await sleep(delay);
      }
    }
    yield { type: 'tool_call', call };
  }
}
