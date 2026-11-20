import { describe, expect, it } from 'vitest';
import { ClaudeProvider, createClaudeProvider, scanTopLevelStrings, type MessagesClient, type RawStreamEvent } from '../src/agent/claude';
import { createProvider } from '../src/agent/llm';
import type { ProviderEvent, TurnInput } from '../src/agent/types';

const input = (over: Partial<TurnInput> = {}): TurnInput =>
  ({
    turnId: 't1',
    roomId: 'r1',
    forcedTool: null,
    tools: [{ name: 'say', description: 'say', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
    system: 'SYS',
    prompt: 'PROMPT',
    ...over,
  }) as TurnInput;

const start = (index: number, name: string): RawStreamEvent => ({ type: 'content_block_start', index, content_block: { type: 'tool_use', name } });
const delta = (index: number, partial_json: string): RawStreamEvent => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
const stop = (index: number): RawStreamEvent => ({ type: 'content_block_stop', index });

function fakeClient(events: RawStreamEvent[], calls: Array<Record<string, unknown>> = []): MessagesClient {
  return {
    messages: {
      async create(params, options) {
        calls.push({ ...params, __signal: options?.signal });
        return (async function* () {
          for (const e of events) {
            await Promise.resolve();
            yield e;
          }
        })();
      },
    },
  };
}

const collect = async (p: ClaudeProvider, i: TurnInput, signal?: AbortSignal) => {
  const out: ProviderEvent[] = [];
  for await (const ev of p.stream(i, signal)) out.push(ev);
  return out;
};

describe('scanTopLevelStrings', () => {
  it('부분 문자열과 이스케이프를 처리한다', () => {
    expect(scanTopLevelStrings('{"text": "안녕\\n하')).toEqual({ text: { value: '안녕\n하', complete: false } });
    expect(scanTopLevelStrings('{"text": "a\\')).toEqual({ text: { value: 'a', complete: false } });
    expect(scanTopLevelStrings('{"text": "\\u00')).toEqual({ text: { value: '', complete: false } });
    expect(scanTopLevelStrings('{"a":{"text":"x"},"n":1,"text":"y","to":"ag')).toEqual({
      text: { value: 'y', complete: true },
      to: { value: 'ag', complete: false },
    });
  });
});

describe('ClaudeProvider 스트림 매핑', () => {
  it('부분 JSON을 text_delta로 누적하고 to를 target으로, 블록 종료에 tool_call을 낸다', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const full = '{"to":"agent_bob","text":"안녕하세요 반갑습니다"}';
    const chunks = ['{"to":"agent', '_bob","te', 'xt":"안녕', '하세요 반갑', '습니다"}'];
    expect(chunks.join('')).toBe(full);
    const events = [{ type: 'message_start' }, start(0, 'say'), ...chunks.map((c) => delta(0, c)), stop(0), { type: 'message_stop' }];
    const out = await collect(new ClaudeProvider({ client: fakeClient(events, calls), model: 'm-agent', lightModel: 'm-light' }), input());

    expect(out.find((e) => e.type === 'tool_start')).toEqual({ type: 'tool_start', tool: 'say' });
    expect(out.filter((e) => e.type === 'target')).toEqual([{ type: 'target', to: 'agent_bob' }]);
    const text = out.flatMap((e) => (e.type === 'text_delta' ? [e.delta] : [])).join('');
    expect(text).toBe('안녕하세요 반갑습니다');
    expect(out.filter((e) => e.type === 'text_delta').length).toBeGreaterThan(1);
    expect(out[out.length - 1]).toEqual({ type: 'tool_call', call: { name: 'say', input: { to: 'agent_bob', text: '안녕하세요 반갑습니다' } } });

    expect(calls[0]).toMatchObject({
      model: 'm-agent',
      stream: true,
      tool_choice: { type: 'any' },
      system: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'PROMPT' }],
      tools: [{ name: 'say', input_schema: { type: 'object', properties: { text: { type: 'string' } } } }],
    });
  });

  it('첫 tool_use 블록만 쓰고, say 외 도구는 text_delta 없이 tool_call만 낸다', async () => {
    const events = [start(0, 'pass'), delta(0, '{"reason":"nothing_to_add"}'), stop(0), start(1, 'say'), delta(1, '{"text":"x"}'), stop(1)];
    const out = await collect(new ClaudeProvider({ client: fakeClient(events), model: 'm' }), input());
    expect(out.filter((e) => e.type === 'tool_call')).toEqual([{ type: 'tool_call', call: { name: 'pass', input: { reason: 'nothing_to_add' } } }]);
    expect(out.some((e) => e.type === 'text_delta')).toBe(false);
  });

  it('ask_agents는 도구 목록에 그대로 실리고 question이 text_delta로 흐르며 tool_call로 끝난다', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const events = [start(0, 'ask_agents'), delta(0, '{"agent_ids":["ag_mom"],"question":"토요일 '), delta(0, '12시 반 괜찮아요?"}'), stop(0)];
    const i = input();
    i.tools = [...i.tools, { name: 'ask_agents', description: 'ask', inputSchema: { type: 'object', properties: { agent_ids: { type: 'array' }, question: { type: 'string' } } } }];
    const out = await collect(new ClaudeProvider({ client: fakeClient(events, calls), model: 'm' }), i);
    expect((calls[0]!.tools as Array<{ name: string }>).map((t) => t.name)).toContain('ask_agents');
    const deltas = out.filter((e) => e.type === 'text_delta') as Array<{ tool: string; delta: string }>;
    expect(deltas.every((d) => d.tool === 'ask_agents')).toBe(true);
    expect(deltas.map((d) => d.delta).join('')).toBe('토요일 12시 반 괜찮아요?');
    expect(out[out.length - 1]).toEqual({ type: 'tool_call', call: { name: 'ask_agents', input: { agent_ids: ['ag_mom'], question: '토요일 12시 반 괜찮아요?' } } });
  });

  it('입력이 비어 있어도 tool_call({})을 낸다. 강제 턴은 경량 모델을 쓴다', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const p = new ClaudeProvider({ client: fakeClient([start(0, 'pass'), stop(0)], calls), model: 'm-agent', lightModel: 'm-light' });
    const out = await collect(p, input({ forcedTool: 'end_visit' }));
    expect(out[out.length - 1]).toEqual({ type: 'tool_call', call: { name: 'pass', input: {} } });
    expect(calls[0]!.model).toBe('m-light');
  });

  it('tool_use 없이 끝나면 tool_call이 없다', async () => {
    const out = await collect(new ClaudeProvider({ client: fakeClient([{ type: 'message_stop' }]), model: 'm' }), input());
    expect(out.some((e) => e.type === 'tool_call')).toBe(false);
  });

  it('깨진 JSON이면 던진다', async () => {
    const p = new ClaudeProvider({ client: fakeClient([start(0, 'say'), delta(0, '{"text":"a'), stop(0)]), model: 'm' });
    await expect(collect(p, input())).rejects.toThrow();
  });

  it('signal이 중단되면 던지고 signal을 SDK에 넘긴다', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ac = new AbortController();
    const events = [start(0, 'say'), delta(0, '{"text":"a'), delta(0, 'b"}'), stop(0)];
    const p = new ClaudeProvider({ client: fakeClient(events, calls), model: 'm' });
    const got: ProviderEvent[] = [];
    await expect(
      (async () => {
        for await (const ev of p.stream(input(), ac.signal)) {
          got.push(ev);
          if (ev.type === 'text_delta') ac.abort();
        }
      })(),
    ).rejects.toThrow();
    expect(got.some((e) => e.type === 'tool_call')).toBe(false);
    expect(calls[0]!.__signal).toBe(ac.signal);
  });
});

describe('provider 선택', () => {
  it('claude 모드에서 키가 없으면 기동 실패한다', () => {
    expect(() => createClaudeProvider({})).toThrow(/ANTHROPIC_API_KEY/);
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => createProvider({ agentMode: 'claude' })).toThrow(/ANTHROPIC_API_KEY/);
      expect(createProvider({ agentMode: 'mock' }).name).toBeTruthy();
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
