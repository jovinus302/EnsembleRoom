import Anthropic from '@anthropic-ai/sdk';
import type { ToolName } from '@ensemble/shared';
import type { AgentProvider, ProviderEvent, TurnInput } from './types';

/**
 * AGENT_MODE=claude: Anthropic Messages API 스트리밍 + tool use (계획 6절).
 * `tool_choice:{type:'any'}`로 턴당 도구 호출 1개를 강제하고, 첫 tool_use 블록만 쓴다. tool_result 루프는 없다.
 *
 * 스트림 매핑
 *   content_block_start(tool_use)  → tool_start
 *   input_json_delta               → 부분 JSON에서 say/comment의 `text`를 점진적으로 뽑아 text_delta, `to`가 확정되면 target
 *   content_block_stop             → 누적한 JSON을 파싱해 tool_call
 */

/** 스트림 원시 이벤트 중 우리가 쓰는 부분만 (SDK 타입에 의존하지 않는다) */
export interface RawStreamEvent {
  type: string;
  index?: number;
  content_block?: { type: string; name?: string };
  delta?: { type: string; partial_json?: string };
}

/** 테스트에서 가짜로 갈아끼울 수 있는 최소 클라이언트 모양 */
export interface MessagesClient {
  messages: {
    create(params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<AsyncIterable<RawStreamEvent>>;
  };
}

export interface ClaudeProviderOptions {
  client: MessagesClient;
  /** 일반 턴 모델 */
  model: string;
  /** 강제 턴(end_visit 등 짧은 턴)용 경량 모델. 없으면 model */
  lightModel?: string;
  maxTokens?: number;
}

/* ---------------- 부분 JSON에서 최상위 문자열 필드 뽑기 ---------------- */

interface PartialString {
  value: string;
  complete: boolean;
}

/** buf[start]가 `"`일 때 문자열을 읽는다. 끝나지 않았으면 지금까지의 값을 complete:false로 돌려준다. */
function readString(buf: string, start: number): PartialString & { end: number } {
  let out = '';
  let i = start + 1;
  while (i < buf.length) {
    const c = buf[i]!;
    if (c === '"') return { value: out, complete: true, end: i + 1 };
    if (c !== '\\') {
      out += c;
      i++;
      continue;
    }
    const n = buf[i + 1];
    if (n === undefined) break; // 이스케이프가 잘림
    if (n === 'u') {
      const hex = buf.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16) || 0);
      i += 6;
      continue;
    }
    const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
    out += map[n] ?? n;
    i += 2;
  }
  return { value: out, complete: false, end: buf.length };
}

/** 중첩 값(객체·배열) 건너뛰기. 닫히지 않았으면 -1 */
function skipNested(buf: string, start: number): number {
  let depth = 0;
  for (let i = start; i < buf.length; i++) {
    const c = buf[i]!;
    if (c === '"') {
      const s = readString(buf, i);
      if (!s.complete) return -1;
      i = s.end - 1;
    } else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** 아직 완성되지 않은 JSON 객체에서 최상위 문자열 필드(부분 포함)를 읽는다. */
export function scanTopLevelStrings(buf: string): Record<string, PartialString> {
  const out: Record<string, PartialString> = {};
  const ws = /\s/;
  let i = 0;
  const skipWs = () => {
    while (i < buf.length && ws.test(buf[i]!)) i++;
  };
  skipWs();
  if (buf[i] !== '{') return out;
  i++;
  for (;;) {
    skipWs();
    while (buf[i] === ',') {
      i++;
      skipWs();
    }
    if (i >= buf.length || buf[i] !== '"') return out;
    const key = readString(buf, i);
    if (!key.complete) return out;
    i = key.end;
    skipWs();
    if (buf[i] !== ':') return out;
    i++;
    skipWs();
    if (i >= buf.length) return out;
    const c = buf[i]!;
    if (c === '"') {
      const v = readString(buf, i);
      out[key.value] = { value: v.value, complete: v.complete };
      if (!v.complete) return out;
      i = v.end;
    } else if (c === '{' || c === '[') {
      const end = skipNested(buf, i);
      if (end < 0) return out;
      i = end;
    } else {
      while (i < buf.length && buf[i] !== ',' && buf[i] !== '}') i++;
      if (i >= buf.length) return out;
    }
  }
}

const STREAMED_TEXT_TOOLS = new Set<string>(['say', 'comment']);

export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude';
  constructor(private readonly opts: ClaudeProviderOptions) {}

  async *stream(input: TurnInput, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
    const { client } = this.opts;
    const model = input.forcedTool ? (this.opts.lightModel ?? this.opts.model) : this.opts.model;
    yield { type: 'phase', phase: 'thinking' };

    const raw = await client.messages.create(
      {
        model,
        max_tokens: this.opts.maxTokens ?? 1024,
        stream: true,
        system: [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: input.prompt }],
        tools: input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
        tool_choice: { type: 'any' },
      },
      signal ? { signal } : undefined,
    );

    try {
      let blockIndex: number | null = null; // 첫 tool_use 블록
      let tool: ToolName | null = null;
      let json = '';
      let sentText = '';
      let targetSent = false;

      for await (const ev of raw) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

        if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && blockIndex === null) {
          blockIndex = ev.index ?? 0;
          tool = ev.content_block.name as ToolName;
          yield { type: 'tool_start', tool };
          yield { type: 'phase', phase: 'writing' };
        } else if (ev.type === 'content_block_delta' && blockIndex !== null && ev.index === blockIndex && tool) {
          if (ev.delta?.type !== 'input_json_delta') continue;
          json += ev.delta.partial_json ?? '';
          const fields = scanTopLevelStrings(json);
          const to = fields.to;
          if (to?.complete && !targetSent && to.value) {
            targetSent = true;
            yield { type: 'target', to: to.value };
          }
          if (STREAMED_TEXT_TOOLS.has(tool)) {
            const text = fields.text?.value ?? '';
            if (text.length > sentText.length && text.startsWith(sentText)) {
              yield { type: 'text_delta', tool, delta: text.slice(sentText.length) };
              sentText = text;
            }
          }
        } else if (ev.type === 'content_block_stop' && blockIndex !== null && ev.index === blockIndex && tool) {
          let parsed: unknown = {};
          if (json.trim()) {
            try {
              parsed = JSON.parse(json);
            } catch {
              throw new Error('claude: tool input JSON을 해석하지 못했습니다');
            }
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('claude: tool input이 객체가 아닙니다');
          const args = parsed as Record<string, unknown>;
          // 스트리밍으로 못 흘린 텍스트를 마저 보낸다
          if (STREAMED_TEXT_TOOLS.has(tool) && typeof args.text === 'string' && args.text.startsWith(sentText) && args.text.length > sentText.length) {
            yield { type: 'text_delta', tool, delta: args.text.slice(sentText.length) };
          }
          if (!targetSent && typeof args.to === 'string' && args.to) yield { type: 'target', to: args.to };
          yield { type: 'tool_call', call: { name: tool, input: args } };
          return;
        }
      }
    } finally {
      // 일찍 끝내면 연결을 닫는다 (SDK Stream의 controller)
      (raw as { controller?: AbortController }).controller?.abort();
    }
  }
}

/** API 키가 없으면 던진다(메시지에 값은 넣지 않는다). */
export function createClaudeProvider(env: NodeJS.ProcessEnv = process.env): ClaudeProvider {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('AGENT_MODE=claude이지만 ANTHROPIC_API_KEY가 설정되지 않았습니다. .env(.txt)에 키를 넣거나 AGENT_MODE=mock으로 실행하세요.');
  }
  const baseURL = env.ANTHROPIC_BASE_URL?.trim() || undefined;
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}), maxRetries: 0 });
  return new ClaudeProvider({
    client: client as unknown as MessagesClient,
    model: env.ANTHROPIC_MODEL_AGENT?.trim() || 'claude-sonnet-5',
    lightModel: env.ANTHROPIC_MODEL_LIGHT?.trim() || 'claude-sonnet-4-6',
  });
}
