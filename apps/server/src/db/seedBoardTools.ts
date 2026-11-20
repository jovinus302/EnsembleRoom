import { materializeInit, type BoardToolInitInput } from '@ensemble/shared';
import type { AppContext } from '../context';
import { SEED } from './seed';

/**
 * 시드 보드 도구: Room Agent가 보드에 올려 둔 도구. 방마다 어울리는 도구 하나(친구들은 둘).
 * 멱등: 해당 Room에 board_tool_* 이벤트가 하나라도 있으면(사람이 만들었거나 이미 시드됨) 넣지 않는다.
 * 고정 id를 쓰고, 사다리는 실행 전 상태(seed 없음)로 둔다.
 */

interface SeedTool {
  roomId: string;
  roomAgentId: string;
  tools: { toolId: string; title: string; init: BoardToolInitInput }[];
}

// seed.ts와 순환 import이므로 모듈 로드 시점이 아니라 호출 시점에 SEED를 읽는다
const seedTools = (): SeedTool[] => [
  {
    roomId: SEED.rooms.friends,
    roomAgentId: SEED.roomAgents.friends,
    tools: [
      {
        toolId: 't_seed_friends_ladder',
        title: '오늘 커피 누가 살까?',
        init: { kind: 'ladder', participants: ['Alice', 'Bob'], outcomes: ['커피 사기', '꽝'] },
      },
      {
        toolId: 't_seed_friends_settle',
        title: '지난주 영화 정산',
        init: {
          kind: 'settlement',
          participants: ['Alice', 'Bob'],
          expenses: [
            { label: '영화표', payer: 'Alice', amount: 24000, splitAmong: ['Alice', 'Bob'] },
            { label: '팝콘', payer: 'Bob', amount: 12000, splitAmong: ['Alice', 'Bob'] },
          ],
        },
      },
    ],
  },
  {
    roomId: SEED.rooms.family,
    roomAgentId: SEED.roomAgents.family,
    tools: [
      {
        toolId: 't_seed_family_trip',
        title: '토요일 가족 점심',
        init: {
          kind: 'trip',
          days: 1,
          items: [
            { day: 1, time: '11:00', place: '마트 장보기', memo: '엄마' },
            { day: 1, time: '12:30', place: '고기 굽기', memo: '아빠' },
            { day: 1, time: '13:00', place: '집에서 점심' },
          ],
          checklist: ['장바구니', '숯·고기', '디저트 예약'],
        },
      },
    ],
  },
  {
    roomId: SEED.rooms.team,
    roomAgentId: SEED.roomAgents.team,
    tools: [
      {
        toolId: 't_seed_team_ladder',
        title: '회고 역할 정하기',
        init: { kind: 'ladder', participants: ['Alice', 'Bob', 'Dana'], outcomes: ['진행자', '서기', '타임키퍼'] },
      },
    ],
  },
];

/** seedDatabase의 트랜잭션 안에서 호출된다 */
export function seedBoardTools(ctx: AppContext): void {
  const { store } = ctx;
  for (const room of seedTools()) {
    if (store.listAll(room.roomId).some((e) => e.type.startsWith('board_tool_'))) continue;
    for (const tool of room.tools) {
      // 항목 id도 고정(도구 id 기반)이라 재시드해도 같은 값이다
      let n = 0;
      const init = materializeInit(tool.init, (prefix) => `${prefix}_${tool.toolId.slice(7)}_${++n}`);
      store.append({
        roomId: room.roomId,
        actorKind: 'room_agent',
        actorId: room.roomAgentId,
        type: 'board_tool_created',
        toolId: tool.toolId,
        title: tool.title,
        ownerTag: 'ours',
        init,
      });
    }
  }
}
