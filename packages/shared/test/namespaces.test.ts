import { describe, expect, it } from 'vitest';
import {
  allowedNamespaces,
  isPrivateNamespace,
  isSubsetOfProvided,
  nsFor,
  nsPrivate,
  nsRoom,
  nsVisit,
  parseNamespace,
  privateNamespaceOpen,
  writableNamespace,
  type NamespaceContext,
} from '../src';

const aliceAgent = { kind: 'personal', agentId: 'agent-alice', ownerId: 'alice' } as const;
const bobAgent = { kind: 'personal', agentId: 'agent-bob', ownerId: 'bob' } as const;

const base = (over: Partial<NamespaceContext>): NamespaceContext => ({
  agent: aliceAgent,
  room: { id: 'room-alice', kind: 'my', ownerId: 'alice' },
  presentUserIds: ['alice'],
  presentVisitorAgentIds: [],
  visitId: null,
  ...over,
});

describe('allowedNamespaces (7절 표)', () => {
  it('My Room에 소유자와 그 Agent뿐: private + for:room + room 전부', () => {
    expect(allowedNamespaces(base({}))).toEqual([
      nsPrivate('agent-alice'),
      nsFor('agent-alice', 'room-alice'),
      nsRoom('room-alice'),
    ]);
  });

  it('방문자(사람)가 있으면 private이 닫힌다', () => {
    const ns = allowedNamespaces(base({ presentUserIds: ['alice', 'bob'] }));
    expect(ns).not.toContain(nsPrivate('agent-alice'));
    expect(ns).toEqual([nsFor('agent-alice', 'room-alice'), nsRoom('room-alice')]);
  });

  it('방문 Agent가 있어도 private이 닫힌다', () => {
    expect(allowedNamespaces(base({ presentVisitorAgentIds: ['agent-bob'] }))).not.toContain(nsPrivate('agent-alice'));
  });

  it('소유자가 자리를 비운 대리 참여 중에는 private이 닫힌다', () => {
    const ctx = base({ presentUserIds: [] });
    expect(privateNamespaceOpen(ctx)).toBe(false);
    expect(allowedNamespaces(ctx)).not.toContain(nsPrivate('agent-alice'));
  });

  it('Our Room에서는 private이 절대 열리지 않는다 (혼자 있어도)', () => {
    const ctx = base({ room: { id: 'room-family', kind: 'our', ownerId: null }, presentUserIds: ['alice'] });
    expect(allowedNamespaces(ctx)).toEqual([nsFor('agent-alice', 'room-family'), nsRoom('room-family')]);
  });

  it('남의 My Room에서는 private이 열리지 않는다 (소유자 불일치)', () => {
    const ctx = base({ agent: bobAgent, presentUserIds: ['alice'] });
    expect(privateNamespaceOpen(ctx)).toBe(false);
  });

  it('가족 Room 항목은 팀 Room 턴에 없다 (room별 격리)', () => {
    const family = allowedNamespaces(base({ room: { id: 'family', kind: 'our', ownerId: null }, presentUserIds: ['alice', 'mom'] }));
    const team = allowedNamespaces(base({ room: { id: 'team', kind: 'our', ownerId: null }, presentUserIds: ['alice', 'bob', 'dana'] }));
    expect(family).toContain(nsFor('agent-alice', 'family'));
    expect(team).not.toContain(nsFor('agent-alice', 'family'));
    expect(team).not.toContain(nsRoom('family'));
    expect(team).toEqual([nsFor('agent-alice', 'team'), nsRoom('team')]);
  });

  it('방문 Agent는 방문 ns만 읽는다 (개인 ns와 호스트 room ns 없음)', () => {
    const ns = allowedNamespaces(
      base({
        room: { id: 'room-bob', kind: 'my', ownerId: 'bob' },
        presentUserIds: ['bob'],
        visitId: 'v2',
      }),
    );
    expect(ns).toEqual([nsVisit('v2')]);
    expect(ns.some(isPrivateNamespace)).toBe(false);
  });

  it('Room Agent는 그 room ns만 읽는다', () => {
    const ns = allowedNamespaces(
      base({ agent: { kind: 'room_agent', roomAgentId: 'ra' }, room: { id: 'room-friends', kind: 'our', ownerId: null }, presentUserIds: ['alice', 'bob'] }),
    );
    expect(ns).toEqual([nsRoom('room-friends')]);
  });

  it('DM에는 Agent 메모리가 없다', () => {
    expect(allowedNamespaces(base({ room: { id: 'dm1', kind: 'dm', ownerId: null } }))).toEqual([]);
  });
});

describe('writableNamespace', () => {
  it('My Room 단독: 개인 private', () => {
    expect(writableNamespace(base({}))).toBe(nsPrivate('agent-alice'));
  });

  it('방문자가 있거나 대리 참여 중이면 room ns', () => {
    expect(writableNamespace(base({ presentUserIds: ['alice', 'bob'] }))).toBe(nsRoom('room-alice'));
    expect(writableNamespace(base({ presentUserIds: [] }))).toBe(nsRoom('room-alice'));
  });

  it('Our Room 구성원 Agent: room ns', () => {
    expect(writableNamespace(base({ room: { id: 'family', kind: 'our', ownerId: null } }))).toBe(nsRoom('family'));
  });

  it('방문 Agent, Room Agent, DM은 쓸 수 없다', () => {
    expect(writableNamespace(base({ visitId: 'v2' }))).toBeNull();
    expect(writableNamespace(base({ agent: { kind: 'room_agent', roomAgentId: 'ra' } }))).toBeNull();
    expect(writableNamespace(base({ room: { id: 'dm1', kind: 'dm', ownerId: null } }))).toBeNull();
  });
});

describe('ns 문자열 도구', () => {
  it('만들기와 파싱이 왕복한다', () => {
    expect(parseNamespace(nsRoom('r1'))).toEqual({ kind: 'room', roomId: 'r1' });
    expect(parseNamespace(nsPrivate('a1'))).toEqual({ kind: 'private', agentId: 'a1' });
    expect(parseNamespace(nsFor('a1', 'r1'))).toEqual({ kind: 'for', agentId: 'a1', roomId: 'r1' });
    expect(parseNamespace(nsVisit('v1'))).toEqual({ kind: 'visit', visitId: 'v1' });
    expect(parseNamespace('garbage')).toBeNull();
  });

  it('개인 ns 판별: private, for는 개인, room, visit은 아님', () => {
    expect(isPrivateNamespace(nsPrivate('a'))).toBe(true);
    expect(isPrivateNamespace(nsFor('a', 'r'))).toBe(true);
    expect(isPrivateNamespace(nsRoom('r'))).toBe(false);
    expect(isPrivateNamespace(nsVisit('v'))).toBe(false);
  });

  it('허용 밖의 used_memory_ids는 부분집합 검사에서 걸린다', () => {
    expect(isSubsetOfProvided(['m1'], ['m1', 'm2'])).toBe(true);
    expect(isSubsetOfProvided([], ['m1'])).toBe(true);
    expect(isSubsetOfProvided(['m1', 'm9'], ['m1', 'm2'])).toBe(false);
  });
});
