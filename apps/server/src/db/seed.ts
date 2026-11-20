import { USER_COLORS, type ThemeId, type ThemeVariant } from '@ensemble/shared';
import type { AppContext } from '../context';
import { seedBoardTools } from './seedBoardTools';

/**
 * 시드 (계획 2·4절). 고정 id + INSERT OR IGNORE + "Room에 이벤트가 없을 때만 이벤트·카드 시드"로 멱등이다.
 * 사용자 5명(Alice, Bob, 엄마(seed), 아빠(seed), Dana(seed)), 각자의 Personal Agent와 My Room,
 * Our Room 3개(모두 cafe 테마), Our마다 Room Agent, Alice–Bob DM.
 */

export const SEED = {
  users: { alice: 'u_alice', bob: 'u_bob', mom: 'u_mom', dad: 'u_dad', dana: 'u_dana' },
  agents: { alice: 'ag_alice', bob: 'ag_bob', mom: 'ag_mom', dad: 'ag_dad', dana: 'ag_dana' },
  rooms: {
    myAlice: 'room_my_alice',
    myBob: 'room_my_bob',
    myMom: 'room_my_mom',
    myDad: 'room_my_dad',
    myDana: 'room_my_dana',
    friends: 'room_our_friends',
    family: 'room_our_family',
    team: 'room_our_team',
    dmAliceBob: 'room_dm_alice_bob',
  },
  roomAgents: { friends: 'ra_friends', family: 'ra_family', team: 'ra_team' },
} as const;

/** 인물 설정 (프롬프트의 "성격:"에 들어간다. 가상 인물만) */
const PERSONA = {
  bob: 'Bob의 Agent. 친구이자 동료. 가볍고 유머가 있는 편한 말투("~야", "~지", "ㅋㅋ"). 계획과 실행 가능성도 따져 본다.',
  mom: '엄마의 Agent. 다정하고 실용적이며 가족 식사와 건강을 챙긴다. 존대 없는 짧은 구어체("~하자", "~했니", "~하렴"). 일요일 오전은 가족 행사라 비워 둔다.',
  dad: '아빠의 Agent. 말수가 적고 다정하다. 운전과 고기 굽기를 맡는다. 존대 없는 짧은 구어체("~하마", "그래", "~하자"). 주말 아침엔 등산을 간다.',
  dana: 'Dana의 Agent. 팀 동료. 간결하고 일정·범위에 꼼꼼하다. 회의가 30분을 넘기는 것을 싫어한다. 말투는 "~요"체.',
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
      { id: U.dad, name: '아빠', color: USER_COLORS.green, kind: 'seed' as const },
    ];
    for (const u of users) repo.insertUser(u);

    const agents: [string, string, string, string][] = [
      [SEED.agents.alice, U.alice, 'beret', '꼼꼼하게 정리해 주는 Alice의 Agent. 일정과 아이디어를 챙긴다.'],
      [SEED.agents.bob, U.bob, 'code', PERSONA.bob],
      [SEED.agents.mom, U.mom, 'goggles', PERSONA.mom],
      [SEED.agents.dana, U.dana, 'beret', PERSONA.dana],
      [SEED.agents.dad, U.dad, 'code', PERSONA.dad],
    ];
    for (const [id, ownerId, variant, persona] of agents) {
      const owner = users.find((u) => u.id === ownerId)!;
      repo.insertAgent({ id, ownerId, name: `${owner.name}의 Agent`, personaPublic: persona, variant });
      // 인물 설정은 시드가 정한다: 이전 버전으로 만든 기존 DB에도 반영되도록 매번 맞춘다 (persona를 수정하는 API는 없다)
      db.raw.prepare('UPDATE agents SET persona_public = ? WHERE id = ? AND persona_public <> ?').run(persona, id, persona);
    }

    const room = (id: string, kind: 'my' | 'our' | 'dm', ownerId: string | null, title: string, theme: ThemeId, variant: ThemeVariant | null = null) =>
      repo.insertRoom({ id, kind, ownerId, title, theme, themeVariant: variant });

    // My Room: Alice=studio, Bob=lounge. 엄마와 Dana도 월드에서 "뒤편 캡슐"로 보이도록 My Room을 둔다.
    room(R.myAlice, 'my', U.alice, 'Alice의 Room', 'studio');
    room(R.myBob, 'my', U.bob, 'Bob의 Room', 'lounge');
    room(R.myMom, 'my', U.mom, '엄마의 Room', 'lounge');
    room(R.myDana, 'my', U.dana, 'Dana의 Room', 'studio');
    room(R.myDad, 'my', U.dad, '아빠의 Room', 'lounge');

    room(R.friends, 'our', null, '친구들', 'cafe');
    room(R.family, 'our', null, '우리 가족', 'cafe', 'home');
    room(R.team, 'our', null, '팀', 'cafe', 'meeting');
    room(R.dmAliceBob, 'dm', null, 'Alice · Bob', 'cafe');

    const members: [string, string[]][] = [
      [R.friends, [U.alice, U.bob]],
      [R.family, [U.alice, U.mom, U.dad]],
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
    // 친구들 방은 예전 시드에서 room_created만 있던 DB가 있다: 대화·카드가 없으면 시나리오를 시드한다
    const noContent = (roomId: string) => !store.listAll(roomId).some((e) => e.type === 'message' || e.type === 'card_created');
    const sys = { actorKind: 'system' as const, actorId: null };
    const human = (userId: string) => ({ actorKind: 'human' as const, actorId: userId });

    // 시드 직후에는 아무도 접속하지 않았다. member_entered는 Room을 실제로 열 때(WS 구독·명시적 진입) 기록된다.
    for (const roomId of [R.myAlice, R.myBob, R.myMom, R.myDana, R.myDad]) {
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

    if (noContent(R.friends)) {
      store.append({ roomId: R.friends, ...human(U.alice), type: 'message', text: '이번 주말에 영화 보고 저녁도 같이 먹을까?' });
      store.append({ roomId: R.friends, ...human(U.bob), type: 'message', text: '좋아! 나는 토요일 저녁 괜찮아.' });
      card(R.friends, 'c_seed_friends_movie', '주말 저녁 영화 모임', '토요일 저녁, 영화 + 저녁 식사. 영화와 장소는 아직 미정.');
      store.append({ roomId: R.friends, ...human(U.alice), type: 'message', text: '그럼 볼 영화부터 골라 보자.' });
    }

    // ---- 시드 기억 (격리 시연용: 가족과 팀의 내용이 서로 다르다) ----
    const mem = (id: string, ns: string, kind: 'fact' | 'preference' | 'agreement', text: string, sourceRoomId: string | null, createdBy: string) =>
      repo.insertMemoryItem({ id, ns, kind, text, sourceRoomId, createdBy });
    mem('mem_seed_family_1', `room:${R.family}`, 'agreement', '주말 점심은 일요일 오전 가족 행사 뒤로 잡는다.', R.family, 'system');
    mem('mem_seed_family_2', `room:${R.family}`, 'fact', '가족 모임은 보통 집에서 한다.', R.family, 'system');
    mem('mem_seed_team_1', `room:${R.team}`, 'agreement', '스프린트 회고는 금요일 15시에 30분으로 한다.', R.team, 'system');
    mem('mem_seed_team_2', `room:${R.team}`, 'preference', '팀 회의는 30분을 넘기지 않는다.', R.team, 'system');
    // 친구들: Bob의 가능 시간은 대화에 이미 나온 공개 정보다. Alice의 비공개 선호(매운 음식)는 방 기억에 넣지 않는다.
    mem('mem_seed_friends_1', `room:${R.friends}`, 'fact', 'Bob은 토요일 저녁에 시간이 된다.', R.friends, 'system');
    mem('mem_seed_friends_2', `room:${R.friends}`, 'agreement', '이번 모임은 영화와 저녁 식사를 함께 한다.', R.friends, 'system');
    // 소유자가 우리 가족에만 공유하기로 고른 개인 기억 / 공유하지 않은 개인 기억
    mem('mem_seed_alice_for_family', `agent:${SEED.agents.alice}:for:${R.family}`, 'fact', '일요일 오전은 가족 행사가 있다.', R.family, U.alice);
    mem('mem_seed_alice_private', `agent:${SEED.agents.alice}:private`, 'preference', '매운 음식은 잘 못 먹는다.', null, U.alice);
    // 기본 일정·취향 기억 (가상의 내용). 소유자가 그 Room에만 공유하기로 한 개인 기억(for:Room)과, My Room에서만 쓰는 비공개 기억(private).
    // 서로 맞물리도록 짰다: 가족 12시 반 점심, 팀 금 14시 반 회고(15시 원안), 친구들 토 저녁 영화·메뉴(라멘 vs 국밥, 1인 2만 원).
    // 주의: mockA2A가 /장/(엄마), /등산/(아빠), /16시/(Bob) 정규식으로 기억을 고르므로 다른 기억 문장에는 그 낱말을 쓰지 않는다.
    const personal = (who: keyof typeof SEED.agents, owner: string, scope: string | null, rows: [string, 'fact' | 'preference', string][]) => {
      for (const [topic, kind, text] of rows) {
        const ns = scope ? `agent:${SEED.agents[who]}:for:${scope}` : `agent:${SEED.agents[who]}:private`;
        mem(`mem_seed_${who}_${topic}`, ns, kind, text, scope, owner);
      }
    };
    personal('alice', U.alice, null, [
      ['sat', 'fact', '토요일 오전엔 운동을 하고, 저녁은 비어 있다.'],
      ['todo_retro', 'fact', '금요일 팀 회고 아젠다를 카드에 정리해야 한다.'],
      ['todo_movie', 'fact', '이번 주 안에 토요일 저녁 영화 모임에서 볼 영화를 골라야 한다.'],
      ['todo_settle', 'fact', '지난주 영화표 값은 내가 냈고, 이번 주 안에 정산을 받아야 한다.'],
      ['food', 'preference', '국밥을 좋아하고 고수는 못 먹는다.'],
    ]);
    personal('alice', U.alice, R.friends, [
      ['sat_friends', 'fact', '토요일 오전엔 운동을 하고, 저녁은 비어 있다.'],
      ['food_friends', 'preference', '국밥을 좋아하고 고수는 못 먹는다.'],
      ['movie_friends', 'preference', '영화는 잔잔한 드라마를 좋아한다.'],
      ['budget_friends', 'preference', '친구 모임 식사는 1인 2만 원 선이 좋다.'],
      ['paid_friends', 'fact', '지난주 영화표 값은 내가 냈다.'],
    ]);
    personal('alice', U.alice, R.family, [
      ['sat_family', 'fact', '토요일 오전엔 운동을 하고, 점심은 12시 이후면 된다.'],
      ['food_family', 'preference', '국밥을 좋아하고 고수는 못 먹는다.'],
    ]);
    personal('alice', U.alice, R.team, [['fri_team', 'fact', '금요일 14시 반이든 15시든 회고에 참석할 수 있다.']]);
    personal('bob', U.bob, R.team, [
      ['retro_team', 'fact', '금요일 14시 반부터 15시까지는 비어 있다.'],
      ['meeting_team', 'preference', '회의는 30분 이내를 선호한다.'],
    ]);
    personal('bob', U.bob, R.friends, [
      ['sat_friends', 'fact', '토요일 저녁엔 시간이 된다.'],
      ['food_friends', 'preference', '매운 음식을 좋아하고 라멘파다.'],
      ['movie_friends', 'preference', 'SF 영화를 좋아하고 공포 영화는 싫어한다.'],
      ['budget_friends', 'preference', '친구 모임 식사는 1인 2만 원 선이 좋다.'],
      ['move_friends', 'fact', '주말 모임엔 지하철로 이동한다.'],
      ['sun_friends', 'fact', '일요일은 쉬는 날이라 비어 있다.'],
    ]);
    personal('dana', U.dana, R.team, [
      ['wfh_team', 'fact', '금요일 오전엔 재택근무를 한다.'],
      ['slot_team', 'fact', '금요일 14시부터 15시 사이에 회의가 가능하다.'],
      ['docs_team', 'preference', '회의 전에 문서를 먼저 공유받고 싶다.'],
      ['len_team', 'preference', '회의는 30분 이내를 선호한다.'],
      ['veg_team', 'preference', '채식 위주로 먹는다.'],
      ['retro_team', 'preference', '회고는 잘한 점, 아쉬운 점, 다음 액션 순서로 하길 원한다.'],
    ]);
    personal('mom', U.mom, R.family, [
      ['sun_family', 'fact', '일요일 오전엔 가족 행사가 있다.'],
      ['lunch_family', 'preference', '토요일 점심은 12시 반 이후가 좋다.'],
      ['food_family', 'preference', '백숙에 자신 있고, 점심은 집에서 차리는 걸 좋아한다.'],
      ['kimchi_family', 'fact', '김치찌개는 돼지고기와 신김치를 먼저 볶아서 끓인다.'],
      ['dessert_family', 'preference', '디저트는 과일을 챙긴다.'],
      ['spicy_family', 'preference', '매운 음식은 약하게 한다.'],
    ]);
    personal('dad', U.dad, R.family, [
      ['grill_family', 'fact', '고기 굽기를 담당한다.'],
      ['raw_family', 'preference', '회는 안 좋아한다.'],
      ['drive_family', 'fact', '가족 이동은 아빠가 운전한다.'],
      ['sun_family', 'fact', '일요일 오전 가족 행사에 참석한다.'],
      ['lunch_family', 'preference', '토요일 점심은 12시 반이면 좋다.'],
      ['food_family', 'preference', '김치찌개와 고기를 좋아한다.'],
    ]);
    // A2A 시연: 부재 구성원의 Agent가 질문을 받으면 이 기억을 근거로 답한다 (해당 Room에만 공유하기로 한 개인 기억)
    mem('mem_seed_bob_for_team', `agent:${SEED.agents.bob}:for:${R.team}`, 'fact', '금요일 16시에 고객 미팅이 있다.', R.team, U.bob);
    mem('mem_seed_mom_for_family', `agent:${SEED.agents.mom}:for:${R.family}`, 'fact', '토요일 오전엔 장을 본다.', R.family, U.mom);
    mem('mem_seed_dad_for_family', `agent:${SEED.agents.dad}:for:${R.family}`, 'fact', '토요일 아침엔 등산을 다녀와 12시 이후에 시간이 된다.', R.family, U.dad);

    // ---- 보드 도구 (Room Agent가 올려 둔 사다리·정산표·여행 계획. 도구 이벤트가 없는 Room에만) ----
    seedBoardTools(ctx);
  });
}
