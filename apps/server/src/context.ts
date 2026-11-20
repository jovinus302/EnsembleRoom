import { AgentRuntime } from './agent/index';
import type { Config } from './config';
import type { Db } from './db/index';
import { Repo } from './db/repo';
import { PresenceManager } from './domain/presence';
import { CoverService } from './media/covers';
import { EventStore } from './events/store';
import { LocalMemoryStore } from './memory/localStore';
import { MemoryGateway } from './memory/gateway';
import { Summarizer } from './memory/summarizer';
import { Hub } from './realtime/hub';

/** 서버 전체가 공유하는 의존성 묶음. 도메인 함수는 이것만 받는다. */
export interface AppContext {
  config: Pick<Config, 'agentMode'> & Partial<Config>;
  db: Db;
  repo: Repo;
  store: EventStore;
  hub: Hub;
  /** Room 구독 → 영속 presence (입장·암묵적 퇴장 타이머) */
  presence: PresenceManager;
  /** 메모리 접근의 유일한 통로 */
  memory: MemoryGateway;
  /** Agent 런타임(스케줄러·provider). `agents.start()` 전에는 아무 턴도 돌지 않는다. */
  agents: AgentRuntime;
  /** Room 요약·Rejoin 다이제스트 (agents.start()와 함께 시작) */
  summarizer: Summarizer;
  /** 보드 도구 커버 이미지 생성(선택 기능, 키 없으면 no-op) */
  covers: CoverService;
}

export function createContext(db: Db, config: AppContext['config'] = { agentMode: 'mock' }): AppContext {
  const repo = new Repo(db);
  const store = new EventStore(db, repo);
  const ctx = { config, db, repo, store } as AppContext;
  ctx.hub = new Hub(ctx);
  ctx.presence = new PresenceManager(ctx);
  ctx.hub.setPresenceListener(ctx.presence);
  ctx.memory = new MemoryGateway(ctx, new LocalMemoryStore(repo));
  ctx.summarizer = new Summarizer(ctx);
  ctx.agents = new AgentRuntime(ctx);
  ctx.covers = new CoverService(ctx, { enabled: !!config.boardCovers });
  return ctx;
}
