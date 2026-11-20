import type { AppContext } from '../context';
import { createClaudeProvider } from './claude';
import { MockProvider } from './mock';
import type { AgentProvider } from './types';

export type { AgentProvider, ProviderEvent, ToolCall, TurnInput } from './types';

/**
 * provider 선택. `AGENT_MODE=mock`(기본, 미지정 포함)이면 MockProvider, `claude`면 ClaudeProvider.
 * claude인데 `ANTHROPIC_API_KEY`가 없으면 기동 실패(throw)한다.
 */
export function createProvider(config: AppContext['config']): AgentProvider {
  if (config.agentMode === 'claude') return createClaudeProvider();
  return new MockProvider({ delayMs: config.agentMockDelayMs ?? 0 });
}
