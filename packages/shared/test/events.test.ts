import { describe, expect, it } from 'vitest';
import {
  EVENT_TYPES,
  EventPayloadSchema,
  RoomEventSchema,
  VolatileMessageSchema,
  canSeeEvent,
  fromStoredRow,
  privateOwner,
  privateTo,
  toStoredRow,
  VisibilitySchema,
  type CanSeeContext,
  type VisitScope,
} from '../src';
import { SAMPLE_PAYLOADS, makeLog } from './helpers';

describe('events schema', () => {
  it('샘플이 모든 영속 이벤트 타입을 한 번씩 덮는다', () => {
    const sampled = SAMPLE_PAYLOADS.map((p) => p.type).sort();
    expect(sampled).toEqual([...EVENT_TYPES].sort());
    expect(EVENT_TYPES).toHaveLength(32);
  });

  it.each(SAMPLE_PAYLOADS.map((p) => [p.type, p] as const))('%s 샘플이 스키마를 통과한다', (_t, payload) => {
    expect(EventPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('알 수 없는 type과 필수 필드 누락을 거부한다', () => {
    expect(EventPayloadSchema.safeParse({ type: 'nope' }).success).toBe(false);
    expect(EventPayloadSchema.safeParse({ type: 'member_entered', userId: 'a' }).success).toBe(false);
    expect(EventPayloadSchema.safeParse({ type: 'agent_step', agentId: 'a', turnId: 't', kind: 'dancing' }).success).toBe(false);
    // 승인자는 1명 이상
    expect(
      EventPayloadSchema.safeParse({ type: 'approval_requested', approvalId: 'a', approvers: [], kind: 'edit', summary: 's' }).success,
    ).toBe(false);
  });

  it('RoomEvent 스키마는 봉투 필드를 요구한다', () => {
    const { events, push } = makeLog();
    const e = push({ type: 'message', text: 'hi' });
    expect(RoomEventSchema.parse(e)).toEqual(e);
    const { seq: _s, ...noSeq } = e;
    expect(RoomEventSchema.safeParse(noSeq).success).toBe(false);
    expect(events).toHaveLength(1);
  });

  it('visibility는 room 또는 private:<id>만 허용한다', () => {
    expect(VisibilitySchema.safeParse('room').success).toBe(true);
    expect(VisibilitySchema.safeParse('private:alice').success).toBe(true);
    expect(VisibilitySchema.safeParse('private:').success).toBe(false);
    expect(VisibilitySchema.safeParse('public').success).toBe(false);
    expect(privateOwner(privateTo('alice'))).toBe('alice');
    expect(privateOwner('room')).toBeNull();
  });

  it('저장 행으로 나눴다가 복원해도 같다(payload에서 type과 봉투 필드가 빠진다)', () => {
    const { push } = makeLog();
    for (const p of SAMPLE_PAYLOADS) {
      const e = push(p, { actorKind: 'agent', actorId: 'agent-alice', turnId: 't1', visibility: 'private:alice' });
      const row = toStoredRow(e);
      expect(row.payload).not.toHaveProperty('type');
      expect(row.payload).not.toHaveProperty('seq');
      expect(fromStoredRow(JSON.parse(JSON.stringify(row)))).toEqual(e);
    }
  });

  it('휘발성 메시지 스키마', () => {
    expect(
      VolatileMessageSchema.parse({ type: 'activity', roomId: 'r', agentId: 'a', turnId: 't', text: 'x', tokensPerSec: 12 }),
    ).toBeTruthy();
    expect(VolatileMessageSchema.parse({ type: 'cursor', userId: 'u', x: 1, y: 0, z: 2, roomId: null })).toBeTruthy();
    expect(VolatileMessageSchema.parse({ type: 'presence', roomId: 'r', userIds: ['u'] })).toBeTruthy();
    expect(VolatileMessageSchema.safeParse({ type: 'cursor', userId: 'u' }).success).toBe(false);
  });
});

describe('canSeeEvent (가시성 규칙)', () => {
  const myRoom = (viewerId: string, visits: VisitScope[] = []): CanSeeContext => ({
    viewerId,
    roomKind: 'my',
    ownerId: 'alice',
    memberIds: [],
    visits,
  });
  const ev = (seq: number, visibility: 'room' | `private:${string}` = 'room') => ({ seq, visibility });

  it('private:X는 X만 본다 (소유자 본인이어도 다른 사람 것은 못 본다)', () => {
    expect(canSeeEvent(ev(1, 'private:alice'), myRoom('alice'))).toBe(true);
    expect(canSeeEvent(ev(1, 'private:alice'), myRoom('bob'))).toBe(false);
    expect(canSeeEvent(ev(1, 'private:bob'), myRoom('alice'))).toBe(false);
  });

  it('my Room: 소유자는 room 이벤트를 전부 본다', () => {
    expect(canSeeEvent(ev(1), myRoom('alice'))).toBe(true);
  });

  it('my Room: 방문자는 자기 방문의 start_seq 이상, active인 동안만 본다', () => {
    const active: VisitScope = { visitorUserId: 'bob', visitorKind: 'human', status: 'active', startSeq: 10 };
    expect(canSeeEvent(ev(9), myRoom('bob', [active]))).toBe(false);
    expect(canSeeEvent(ev(10), myRoom('bob', [active]))).toBe(true);
    expect(canSeeEvent(ev(50), myRoom('bob', [active]))).toBe(true);
    expect(canSeeEvent(ev(50), myRoom('bob', [{ ...active, status: 'ended' }]))).toBe(false);
    expect(canSeeEvent(ev(50), myRoom('bob', [{ ...active, status: 'requested', startSeq: null }]))).toBe(false);
    // 다른 사람의 방문은 해당 없음
    expect(canSeeEvent(ev(50), myRoom('carol', [active]))).toBe(false);
    // Agent 방문은 사람에게 보이는 범위를 열지 않는다
    expect(canSeeEvent(ev(50), myRoom('bob', [{ ...active, visitorKind: 'agent' }]))).toBe(false);
  });

  it('our/dm Room: 구성원만 본다', () => {
    const ctx = (viewerId: string): CanSeeContext => ({
      viewerId,
      roomKind: 'our',
      ownerId: null,
      memberIds: ['alice', 'bob'],
      visits: [],
    });
    expect(canSeeEvent(ev(1), ctx('bob'))).toBe(true);
    expect(canSeeEvent(ev(1), ctx('mom'))).toBe(false);
    expect(canSeeEvent(ev(1, 'private:bob'), ctx('alice'))).toBe(false);
  });
});
