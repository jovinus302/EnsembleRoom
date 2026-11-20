import { describe, expect, it } from 'vitest';
import {
  glassClarity,
  glassReveals,
  GLASS_TRANSITION_SECONDS,
  relation,
  roomLabel,
  worldTopology,
  type RoomRef,
  type VisitRef,
} from '../src';

const names: Record<string, string> = { alice: 'Alice', bob: 'Bob', mom: '엄마', dana: 'Dana' };
const nameOf = (id: string) => names[id] ?? id;

const aliceRoom: RoomRef = { id: 'room-alice', kind: 'my', ownerId: 'alice', memberIds: [], title: '' };
const bobRoom: RoomRef = { id: 'room-bob', kind: 'my', ownerId: 'bob', memberIds: [], title: '' };
const momRoom: RoomRef = { id: 'room-mom', kind: 'my', ownerId: 'mom', memberIds: [], title: '' };
const danaRoom: RoomRef = { id: 'room-dana', kind: 'my', ownerId: 'dana', memberIds: [], title: '' };
const friends: RoomRef = { id: 'room-friends', kind: 'our', ownerId: null, memberIds: ['alice', 'bob'], title: '친구들' };
const family: RoomRef = { id: 'room-family', kind: 'our', ownerId: null, memberIds: ['alice', 'mom'], title: '우리 가족' };
const team: RoomRef = { id: 'room-team', kind: 'our', ownerId: null, memberIds: ['alice', 'bob', 'dana'], title: '팀' };
const all = [aliceRoom, bobRoom, momRoom, danaRoom, friends, family, team];

describe('relation / roomLabel: 두 시점 대칭', () => {
  it('Alice 창과 Bob 창에서 mine/yours와 라벨이 정확히 반대로 나온다', () => {
    expect(relation('alice', aliceRoom)).toBe('mine');
    expect(relation('alice', bobRoom)).toBe('yours');
    expect(relation('bob', aliceRoom)).toBe('yours');
    expect(relation('bob', bobRoom)).toBe('mine');

    expect(roomLabel('alice', aliceRoom, nameOf)).toBe('My Room');
    expect(roomLabel('alice', bobRoom, nameOf)).toBe('Bob의 Room');
    expect(roomLabel('bob', aliceRoom, nameOf)).toBe('Alice의 Room');
    expect(roomLabel('bob', bobRoom, nameOf)).toBe('My Room');
  });

  it('Our Room은 누가 봐도 ours이고 제목이 라벨이다', () => {
    expect(relation('alice', friends)).toBe('ours');
    expect(relation('bob', friends)).toBe('ours');
    expect(roomLabel('alice', friends, nameOf)).toBe('친구들');
    expect(roomLabel('bob', friends, nameOf)).toBe('친구들');
  });

  it('모든 (viewer, room) 쌍에서 mine은 정확히 viewer의 My Room 하나뿐이다', () => {
    for (const viewer of ['alice', 'bob', 'mom', 'dana']) {
      const mine = all.filter((r) => relation(viewer, r) === 'mine');
      expect(mine.map((r) => r.ownerId)).toEqual([viewer]);
    }
  });
});

describe('glassClarity: 유리 = 경계', () => {
  const none: VisitRef[] = [];

  it('내 캡슐과 내가 구성원인 Our 캡슐은 투명', () => {
    expect(glassClarity('alice', aliceRoom, none)).toBe('clear');
    expect(glassClarity('alice', friends, none)).toBe('clear');
    expect(glassClarity('alice', family, none)).toBe('clear');
    expect(glassClarity('bob', friends, none)).toBe('clear');
  });

  it('남의 캡슐과 내가 구성원이 아닌 Our 캡슐은 서리 유리', () => {
    expect(glassClarity('alice', bobRoom, none)).toBe('frosted');
    expect(glassClarity('bob', aliceRoom, none)).toBe('frosted');
    expect(glassClarity('bob', family, none)).toBe('frosted');
    expect(glassClarity('mom', team, none)).toBe('frosted');
  });

  it('방문이 수락돼 활성이면 그 캡슐이 나에게 투명해지고, 끝나면 다시 서리가 낀다', () => {
    const v = (status: VisitRef['status']): VisitRef[] => [
      { hostRoomId: 'room-bob', visitorKind: 'human', visitorUserId: 'alice', status },
    ];
    expect(glassClarity('alice', bobRoom, v('requested'))).toBe('frosted');
    expect(glassClarity('alice', bobRoom, v('active'))).toBe('clear');
    expect(glassClarity('alice', bobRoom, v('ended'))).toBe('frosted');
    expect(glassClarity('alice', bobRoom, v('declined'))).toBe('frosted');
  });

  it('방문은 그 캡슐과 그 방문자에게만 유효하다', () => {
    const visits: VisitRef[] = [{ hostRoomId: 'room-bob', visitorKind: 'human', visitorUserId: 'alice', status: 'active' }];
    expect(glassClarity('alice', momRoom, visits)).toBe('frosted'); // 다른 캡슐
    expect(glassClarity('dana', bobRoom, visits)).toBe('frosted'); // 다른 방문자
    expect(glassClarity('bob', aliceRoom, visits)).toBe('frosted'); // Bob은 Alice 캡슐을 방문하지 않았다
  });

  it('내 Agent가 방문 중이면 agent 시야(옅은 서리), 끝나면 다시 서리. 제3자와 다른 캡슐은 서리', () => {
    const v = (status: VisitRef['status']): VisitRef[] => [
      { hostRoomId: 'room-bob', visitorKind: 'agent', visitorUserId: 'alice', status },
    ];
    expect(glassClarity('alice', bobRoom, v('requested'))).toBe('frosted');
    expect(glassClarity('alice', bobRoom, v('active'))).toBe('agent');
    expect(glassClarity('alice', bobRoom, v('ended'))).toBe('frosted');
    expect(glassClarity('alice', momRoom, v('active'))).toBe('frosted');
    expect(glassClarity('dana', bobRoom, v('active'))).toBe('frosted');
    expect(glassClarity('bob', bobRoom, v('active'))).toBe('clear'); // 호스트는 원래 투명
  });

  it('사람 방문과 Agent 방문이 같이 활성이면 사람 방문의 clear가 이긴다', () => {
    const visits: VisitRef[] = [
      { hostRoomId: 'room-bob', visitorKind: 'agent', visitorUserId: 'alice', status: 'active' },
      { hostRoomId: 'room-bob', visitorKind: 'human', visitorUserId: 'alice', status: 'active' },
    ];
    expect(glassClarity('alice', bobRoom, visits)).toBe('clear');
  });

  it('서리 유리여도 간판, 조명, 실루엣은 보이고 세부만 가려진다', () => {
    expect(glassReveals('frosted')).toEqual({ sign: true, lights: true, silhouettes: true, detail: false });
    expect(glassReveals('clear').detail).toBe(true);
    expect(glassReveals('agent').detail).toBe(false);
  });
});

describe('worldTopology: 시점 중심 배치', () => {
  it('Alice 창: 앞 중앙은 Alice의 캡슐, 뒤에 Alice의 Our들, 각 Our 뒤에 다른 구성원 캡슐', () => {
    const t = worldTopology('alice', all);
    expect(t.front).toBe('room-alice');
    expect(t.ours).toEqual([
      { roomId: 'room-friends', behind: ['room-bob'] },
      { roomId: 'room-family', behind: ['room-mom'] },
      { roomId: 'room-team', behind: ['room-bob', 'room-dana'] },
    ]);
    expect(t.tubes).toContainEqual({ from: 'room-alice', to: 'room-friends' });
    expect(t.tubes).toContainEqual({ from: 'room-friends', to: 'room-bob' });
    expect(t.tubes).toContainEqual({ from: 'room-team', to: 'room-dana' });
  });

  it('Bob 창: 앞 중앙이 Bob의 캡슐이고 Alice 캡슐은 Our 뒤편으로 간다 (대칭)', () => {
    const t = worldTopology('bob', all);
    expect(t.front).toBe('room-bob');
    expect(t.ours).toEqual([
      { roomId: 'room-friends', behind: ['room-alice'] },
      { roomId: 'room-team', behind: ['room-alice', 'room-dana'] },
    ]);
    // 가족 Room은 Bob이 구성원이 아니라 보이지 않는다
    expect(t.ours.map((o) => o.roomId)).not.toContain('room-family');
  });

  it('두 시점의 튜브 집합에서 공유 Our 캡슐 연결이 서로 대응한다', () => {
    const a = worldTopology('alice', [aliceRoom, bobRoom, friends]);
    const b = worldTopology('bob', [aliceRoom, bobRoom, friends]);
    expect(a.tubes).toEqual([
      { from: 'room-alice', to: 'room-friends' },
      { from: 'room-friends', to: 'room-bob' },
    ]);
    expect(b.tubes).toEqual([
      { from: 'room-bob', to: 'room-friends' },
      { from: 'room-friends', to: 'room-alice' },
    ]);
  });

  it('My Room이 없는 사용자는 front가 null', () => {
    expect(worldTopology('ghost', all).front).toBeNull();
  });
});

describe("GLASS_TRANSITION_SECONDS", () => {
  it("서리 와이프가 눈에 보이는 길이(1.8s)이고 웹이 배수 없이 그대로 쓴다", () => {
    expect(GLASS_TRANSITION_SECONDS).toBe(1.8);
  });
});
