import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../../..');

/** `.env`를 우선 읽고, 없으면 `.env.txt`를 읽는다. 값은 출력하지 않는다. */
export function loadEnvFile(root: string = REPO_ROOT): string | null {
  for (const name of ['.env', '.env.txt']) {
    const p = resolve(root, name);
    if (existsSync(p)) {
      process.loadEnvFile(p);
      // Claude Code 등 상위 프로세스가 ANTHROPIC_*를 이미 내보내 두면 loadEnvFile은 덮어쓰지 않아 파일의 프록시 설정이 무시된다.
      // 이 프로젝트의 환경 파일에 적은 BASE_URL·API_KEY는 상속된 값보다 우선한다.
      for (const [k, v] of Object.entries(parseEnv(readFileSync(p, 'utf8')))) {
        if ((k === 'ANTHROPIC_BASE_URL' || k === 'ANTHROPIC_API_KEY') && v !== undefined) process.env[k] = v;
      }
      return name;
    }
  }
  return null;
}

export type AgentMode = 'claude' | 'mock';

export interface Config {
  port: number;
  agentMode: AgentMode;
  envFile: string | null;
  /** SQLite 파일 경로. 기본 data/ensemble.db (gitignore) */
  dbPath: string;
  /** Room 구독이 끊긴 뒤 암묵적 퇴장(member_left{implicit})을 기록하기까지의 시간(ms). 기본 30초 */
  implicitLeaveMs: number;
  /** Agent 간 연쇄 상한 (계획 6절, 기본 4) */
  agentChainLimit: number;
  /** 방문 Agent의 턴 상한 (기본 6) */
  visitMaxTurns: number;
  /** Room당 시간당 Agent 턴 상한 (기본 60) */
  maxTurnsPerRoomHour: number;
  /** mock provider의 단계별 지연(ms). 0이면 지연 없음(테스트). 기본 350 */
  agentMockDelayMs: number;
  /** Our Room 자동 반응·자동 대리 (AGENT_AUTO_REPLY=off면 끔). 기본 켬 */
  agentAutoReply: boolean;
  /** A2A: Agent끼리 묻고 답하기(ask_agents). AGENT_A2A=off면 끔(기존 동작과 동일). 기본 켬 */
  agentA2A: boolean;
  /** 에피소드(사람 발언 1건)당 ask 라운드 (기본 1) */
  a2aMaxRounds: number;
  /** ask당 수신 Agent 상한 (기본 3) */
  a2aFanoutMax: number;
  /** 에피소드당 a2a 턴(답+정리) 하드캡 (기본 10) */
  a2aMaxTurnsPerEpisode: number;
  /** 사람 메시지 1건당 전체 Agent 턴 상한 (기본 10) */
  a2aMaxTurnsPerHumanEvent: number;
  /** 승인 해소 1건이 여는 확정 에피소드의 턴 상한 (기본 3) */
  a2aMaxTurnsPerResolution: number;
  /** Room 요약을 갱신하는 변화 이벤트 수 (계획 7절: 30) */
  summaryEveryEvents: number;
  /** 보드 도구 커버 이미지(APIFrame). APIFRAME_API_KEY가 있고 BOARD_TOOL_COVERS가 off가 아니면 켠다. 키 값은 Config에 두지 않는다 */
  boardCovers: boolean;
}

/** A2A 기본값 (agent/a2a.ts가 다시 내보낸다) */
export const A2A_DEFAULTS = {
  maxRounds: 2,
  fanoutMax: 3,
  maxTurnsPerEpisode: 10,
  maxTurnsPerHumanEvent: 10,
  maxTurnsPerResolution: 3,
} as const;

export const AGENT_DEFAULTS = {
  agentChainLimit: 4,
  visitMaxTurns: 6,
  maxTurnsPerRoomHour: 120,
  agentMockDelayMs: 0,
  summaryEveryEvents: 30,
} as const;

export function loadConfig(): Config {
  const envFile = loadEnvFile();
  const mode: AgentMode = process.env.AGENT_MODE === 'claude' ? 'claude' : 'mock';
  return {
    port: Number(process.env.PORT ?? 8787),
    agentMode: mode,
    envFile,
    dbPath: process.env.DB_PATH ?? resolve(REPO_ROOT, 'data', 'ensemble.db'),
    implicitLeaveMs: Number(process.env.IMPLICIT_LEAVE_MS ?? 30_000),
    agentChainLimit: Number(process.env.AGENT_CHAIN_LIMIT ?? AGENT_DEFAULTS.agentChainLimit),
    visitMaxTurns: Number(process.env.VISIT_MAX_TURNS ?? AGENT_DEFAULTS.visitMaxTurns),
    maxTurnsPerRoomHour: Number(process.env.MAX_TURNS_PER_ROOM_HOUR ?? AGENT_DEFAULTS.maxTurnsPerRoomHour),
    agentMockDelayMs: Number(process.env.AGENT_MOCK_DELAY_MS ?? 350),
    agentAutoReply: (process.env.AGENT_AUTO_REPLY ?? 'on').trim().toLowerCase() !== 'off',
    agentA2A: (process.env.AGENT_A2A ?? 'on').trim().toLowerCase() !== 'off',
    a2aMaxRounds: Number(process.env.A2A_MAX_ROUNDS ?? A2A_DEFAULTS.maxRounds),
    a2aFanoutMax: Number(process.env.A2A_FANOUT_MAX ?? A2A_DEFAULTS.fanoutMax),
    a2aMaxTurnsPerEpisode: Number(process.env.A2A_MAX_TURNS_PER_EPISODE ?? A2A_DEFAULTS.maxTurnsPerEpisode),
    a2aMaxTurnsPerHumanEvent: Number(process.env.A2A_MAX_TURNS_PER_HUMAN_EVENT ?? A2A_DEFAULTS.maxTurnsPerHumanEvent),
    a2aMaxTurnsPerResolution: Number(process.env.A2A_MAX_TURNS_PER_RESOLUTION ?? A2A_DEFAULTS.maxTurnsPerResolution),
    summaryEveryEvents: Number(process.env.SUMMARY_EVERY_EVENTS ?? AGENT_DEFAULTS.summaryEveryEvents),
    boardCovers:
      (process.env.BOARD_TOOL_COVERS ?? 'on').trim().toLowerCase() !== 'off' && !!process.env.APIFRAME_API_KEY?.trim(),
  };
}
