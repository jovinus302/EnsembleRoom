/**
 * 1회성 스모크: 프록시가 모델 ID를 받는지, 스트리밍 + tool use가 되는지 확인한다.
 * 실행: npm run smoke:claude   (저장소 루트. 모델 ID를 인자로 줄 수 있다: npm run smoke:claude -- <모델ID> [--list-models])
 * 출력은 모델 ID, 성공/실패, HTTP 상태, 에러 타입, 이벤트 요약만이다. 키·URL·에러 본문은 출력하지 않는다.
 */
import Anthropic from '@anthropic-ai/sdk';
import { loadEnvFile } from '../src/config';

loadEnvFile();
const apiKey = process.env.ANTHROPIC_API_KEY;
const baseURL = process.env.ANTHROPIC_BASE_URL || undefined;
if (!apiKey) {
  console.log('ANTHROPIC_API_KEY 없음');
  process.exit(1);
}
const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}), maxRetries: 0 });

const argModels = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const models = argModels.length > 0 ? argModels : [process.env.ANTHROPIC_MODEL_AGENT || 'claude-sonnet-5', process.env.ANTHROPIC_MODEL_LIGHT || 'claude-sonnet-4-6'];
let anyFail = false;

for (const model of models) {
  try {
    const stream = await client.messages.create({
      model,
      max_tokens: 200,
      stream: true,
      system: [{ type: 'text', text: '당신은 방 안의 Agent입니다. 반드시 say 도구로 한 문장만 말하세요.', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: '안녕이라고 인사해 주세요.' }],
      tools: [{ name: 'say', description: '방에 말한다', input_schema: { type: 'object', properties: { text: { type: 'string' }, to: { type: 'string' } }, required: ['text'] } }],
      tool_choice: { type: 'any' },
    });
    const seen: Record<string, number> = {};
    let json = '';
    for await (const ev of stream) {
      seen[ev.type] = (seen[ev.type] ?? 0) + 1;
      if (ev.type === 'content_block_delta' && ev.delta.type === 'input_json_delta') json += ev.delta.partial_json;
    }
    console.log(`[OK] ${model} stream events=${JSON.stringify(seen)} tool_json_parses=${(() => { try { return typeof JSON.parse(json).text === 'string'; } catch { return false; } })()}`);
  } catch (e) {
    anyFail = true;
    const err = e as { status?: number; error?: { error?: { type?: string }; type?: string }; name?: string };
    console.log(`[FAIL] ${model} status=${err.status ?? '-'} type=${err.error?.error?.type ?? err.error?.type ?? err.name ?? '-'}`);
  }
}

if (anyFail && process.argv.includes('--list-models')) {
  try {
    const page = await client.models.list({ limit: 100 });
    console.log('models:', page.data.map((m) => m.id).join(', '));
  } catch (e) {
    console.log(`[FAIL] models.list status=${(e as { status?: number }).status ?? '-'}`);
  }
}
