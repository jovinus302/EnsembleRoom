import type { RoomEvent, ToolName } from '@ensemble/shared';
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
 */

export interface MockOptions {
  /** 단계 사이 지연(ms). 0이면 지연 없음 */
  delayMs?: number;
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

const isQuestion = (t: string) => /[?？]/.test(t);

type Ev = Extract<RoomEvent, { type: 'message' }>;

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
    if (/확정|결정/.test(text) && has('request_approval')) {
      return call('request_approval', {
        question: `이 내용을 확정할까요? "${clip(text, 60)}"`,
        options: ['확정', '조금 더 논의'],
        ...rationale,
      });
    }
    if (msg?.to === me || isQuestion(text) || /정리|요약/.test(text)) {
      const lines = input.events.filter((e): e is Ev => e.type === 'message').slice(-3);
      const recap = lines.map((m) => `${nameOf(m.actorId)}: ${clip(m.text, 30)}`).join(' / ');
      return has('say') ? call('say', { text: `정리해 볼게요. ${recap || '아직 나온 이야기가 없어요.'}` }) : pass('nothing_to_add');
    }
    return pass('not_addressed');
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
