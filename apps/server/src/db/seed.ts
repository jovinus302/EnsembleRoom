import { USER_COLORS, type ThemeId, type ThemeVariant } from '@ensemble/shared';
import type { AppContext } from '../context';

/**
 * 시드 (계획 2·4절). 고정 id + INSERT OR IGNORE + "Room에 이벤트가 없을 때만 이벤트·카드 시드"로 멱등이다.
 * 사용자 4명(Alice, Bob, 엄마(seed), Dana(seed)), 각자의 Personal Agent와 My Room,
 * Our Room 3개(모두 cafe 테마), Our마다 Room Agent, Alice–Bob DM.
 */

export const SEED = {
  users: { alice: 'u_alice', bob: 'u_bob', mom: 'u_mom', dana: 'u_dana' },
  agents: { alice: 'ag_alice', bob: 'ag_bob', mom: 'ag_mom', dana: 'ag_dana' },
  rooms: {
    myAlice: 'room_my_alice',
    myBob: 'room_my_bob',
    myMom: 'room_my_mom',
    myDana: 'room_my_dana',
    friends: 'room_our_friends',
    family: 'room_our_family',
    team: 'room_our_team',
    dmAliceBob: 'room_dm_alice_bob',
  },
  roomAgents: { friends: 'ra_friends', family: 'ra_family', team: 'ra_team' },
} as const;

const U = SEED.users;
const R = SEED.rooms;

export function seedDatabase(ctx: AppContext): void {
  const { repo, store, db } = ctx;
  db.tx(() => {
    const users = [
      { id: U.alice, name: 'Alice', color: USER_COLORS.coral, kind: 'person' as const },
      { id: U.bob, name: 'Bob', color: USER_COLORS.sky, kind: 'person' as const },
      { id: U.mom, name: '엄마', color: USER_COLORS.pink, kind: 'seed' as const },
      { id: U.dana, name: 'Dana', color: USER_COLORS.yellow, kind: 'seed' as const },
    ];
    for (const u of users) repo.insertUser(u);

    const agents: [string, string, string, string][] = [
      [SEED.agents.alice, U.alice, 'beret', '꼼꼼하게 정리해 주는 Alice의 Agent. 일정과 아이디어를 챙긴다.'],
      [SEED.agents.bob, U.bob, 'code', 'Bob의 Agent. 계획과 실행 가능성을 따져 본다.'],
      [SEED.agents.mom, U.mom, 'goggles', '엄마의 Agent (시드).'],
      [SEED.agents.dana, U.dana, 'beret', 'Dana의 Agent (시드).'],
    ];
    for (const [id, ownerId, variant, persona] of agents) {
      const owner = users.find((u) => u.id === ownerId)!;
      repo.insertAgent({ id, ownerId, name: `${owner.name}의 Agent`, personaPublic: persona, variant });
    }

    const room = (id: string, kind: 'my' | 'our' | 'dm', ownerId: string | null, title: string, theme: ThemeId, variant: ThemeVariant | null = null) =>
      repo.insertRoom({ id, kind, ownerId, title, theme, themeVariant: variant });

    // My Room: Alice=studio, Bob=lounge. 엄마와 Dana도 월드에서 "뒤편 캡슐"로 보이도록 My Room을 둔다.
    room(R.myAlice, 'my', U.alice, 'Alice의 Room', 'studio');
    room(R.myBob, 'my', U.bob, 'Bob의 Room', 'lounge');
    room(R.myMom, 'my', U.mom, '엄마의 Room', 'lounge');
    room(R.myDana, 'my', U.dana, 'Dana의 Room', 'studio');

    room(R.friends, 'our', null, '친구들', 'cafe');
    room(R.family, 'our', null, '우리 가족', 'cafe', 'home');
    room(R.team, 'our', null, '팀', 'cafe', 'meeting');
    room(R.dmAliceBob, 'dm', null, 'Alice · Bob', 'cafe');

    const members: [string, string[]][] = [
      [R.friends, [U.alice, U.bob]],
      [R.family, [U.alice, U.mom]],
      [R.team, [U.alice, U.bob, U.dana]],
      [R.dmAliceBob, [U.alice, U.bob]],
    ];
    for (const [roomId, ids] of members) for (const id of ids) repo.addMember(roomId, id);

    for (const [key, roomId, title] of [
      ['friends', R.friends, '친구들'],
      ['family', R.family, '우리 가족'],
      ['team', R.team, '팀'],
    ] as const) {
      repo.insertRoomAgent({
        id: SEED.roomAgents[key],
        roomId,
        name: `${title} Room Agent`,
        personaPublic: '중립 조율자. 요약하고, 의견이 갈리면 선택지로 정리한다. 결정하지 않는다.',
      });
    }

    // ---- 이벤트·카드: Room에 이벤트가 하나도 없을 때만 (재실행해도 중복되지 않는다) ----
    const fresh = (roomId: string) => store.lastSeq(roomId) === 0;
    const sys = { actorKind: 'system' as const, actorId: null };
    const human = (userId: string) => ({ actorKind: 'human' as const, actorId: userId });

    // 시드 직후에는 아무도 접속하지 않았다. member_entered는 Room을 실제로 열 때(WS 구독·명시적 진입) 기록된다.
    for (const roomId of [R.myAlice, R.myBob, R.myMom, R.myDana]) {
      if (fresh(roomId)) store.append({ roomId, ...sys, type: 'room_created' });
    }

    const ourSeed = (roomId: string, title: string) => store.append({ roomId, ...sys, type: 'room_created', title });
    if (fresh(R.friends)) ourSeed(R.friends, '친구들');
    if (fresh(R.dmAliceBob)) ourSeed(R.dmAliceBob, 'Alice · Bob');

    const card = (roomId: string, cardId: string, title: string, body: string) => {
      repo.insertCard({ roomId, cardId, title, body, ownerTag: 'ours' });
      store.append({ roomId, ...sys, type: 'card_created', cardId, title, body, ownerTag: 'ours' });
    };

    if (fresh(R.family)) {
      ourSeed(R.family, '우리 가족');
      store.append({ roomId: R.family, ...human(U.mom), type: 'message', text: '이번 주말에 다 같이 점심 먹자.' });
      store.append({ roomId: R.family, ...human(U.alice), type: 'message', text: '좋아요! 일요일 오전엔 가족 행사가 있잖아요.' });
      card(R.family, 'c_seed_family_lunch', '주말 가족 점심', '일요일 오전 가족 행사 뒤, 집에서 점심.');
      store.append({ roomId: R.family, ...human(U.mom), type: 'message', text: '그럼 토요일이 낫겠네. 장은 내가 볼게.' });
    }

    if (fresh(R.team)) {
      ourSeed(R.team, '팀');
      store.append({ roomId: R.team, ...human(U.dana), type: 'message', text: '이번 스프린트 회고 언제 할까요?' });
      store.append({ roomId: R.team, ...human(U.bob), type: 'message', text: '금요일 오후 어때요?' });
      card(R.team, 'c_seed_team_retro', '스프린트 회고', '금요일 15시, 30분. 잘한 점 / 아쉬운 점 / 다음 액션.');
      store.append({ roomId: R.team, ...human(U.alice), type: 'message', text: '좋아요. 아젠다는 카드에 적어 둘게요.' });
    }

    // ---- 시드 기억 (격리 시연용: 가족과 팀의 내용이 서로 다르다) ----
    const mem = (id: string, ns: string, kind: 'fact' | 'preference' | 'agreement', text: string, sourceRoomId: string | null, createdBy: string) =>
      repo.insertMemoryItem({ id, ns, kind, text, sourceRoomId, createdBy });
    mem('mem_seed_family_1', `room:${R.family}`, 'agreement', '주말 점심은 일요일 오전 가족 행사 뒤로 잡는다.', R.family, 'system');
    mem('mem_seed_family_2', `room:${R.family}`, 'fact', '가족 모임은 보통 집에서 한다.', R.family, 'system');
    mem('mem_seed_team_1', `room:${R.team}`, 'agreement', '스프린트 회고는 금요일 15시에 30분으로 한다.', R.team, 'system');
    mem('mem_seed_team_2', `room:${R.team}`, 'preference', '팀 회의는 30분을 넘기지 않는다.', R.team, 'system');
    // 소유자가 우리 가족에만 공유하기로 고른 개인 기억 / 공유하지 않은 개인 기억
    mem('mem_seed_alice_for_family', `agent:${SEED.agents.alice}:for:${R.family}`, 'fact', '일요일 오전은 가족 행사가 있다.', R.family, U.alice);
    mem('mem_seed_alice_private', `agent:${SEED.agents.alice}:private`, 'preference', '매운 음식은 잘 못 먹는다.', null, U.alice);
  });
}
