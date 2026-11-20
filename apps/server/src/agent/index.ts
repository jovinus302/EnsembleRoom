import type { AppContext } from '../context';
import { createProvider } from './llm';
import { Scheduler } from './scheduler';
import type { AgentProvider, TurnOutcome } from './types';

/**
 * Agent 런타임: provider + 결정적 스케줄러. `start()`를 불러야 이벤트 로그를 구독해 턴을 돌린다
 * (시드·테스트가 의도치 않게 Agent를 깨우지 않도록 createContext는 시작하지 않는다. index.ts가 시드 뒤에 시작한다).
 */
export class AgentRuntime {
  private provider: AgentProvider;
  readonly scheduler: Scheduler;
  /** 최근 턴 결과 (진단·테스트용, 최대 200개) */
  readonly outcomes: TurnOutcome[] = [];

  constructor(private readonly ctx: AppContext) {
    this.provider = createProvider(ctx.config);
    this.scheduler = new Scheduler(ctx, () => this.provider);
    this.scheduler.onTurnEnded((o) => {
      this.outcomes.push(o);
      if (this.outcomes.length > 200) this.outcomes.shift();
    });
  }

  start(): void {
    this.scheduler.start();
    this.ctx.summarizer.start();
  }
  /** 진행 중인 턴·요약에 AbortSignal을 보내 중단하고 새 작업을 받지 않는다 */
  stop(): void {
    this.scheduler.stop();
    this.ctx.summarizer.stop();
  }
  /** 진행 중·대기 중인 턴과 요약이 모두 끝날 때까지 기다린다 */
  async drain(): Promise<void> {
    await this.scheduler.drain();
    await this.ctx.summarizer.drain();
  }
  /** S9(claude)나 테스트가 provider를 바꾼다 */
  setProvider(p: AgentProvider): void {
    this.provider = p;
  }
  getProvider(): AgentProvider {
    return this.provider;
  }
}

export type { AgentProvider, ProviderEvent, ToolCall, TurnInput, TurnOutcome } from './types';
