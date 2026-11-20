import { describe, expect, it } from 'vitest';
import { ACTIVITY_PHASES, ANSWER_BLOCK_TYPES, AnswerBlockSchema, EventPayloadSchema, MAX_BLOCKS_PER_MESSAGE } from '../src';

const src = [{ kind: 'memory', label: '취향 메모' }];
const valid: Record<string, unknown> = {
  schedule: { type: 'schedule', days: [{ label: '토', items: [{ start: '14:00', title: '점심', status: 'fixed', sources: src }] }], verdict: '가능' },
  profile: { type: 'profile', title: '민수', groups: [{ label: '음식', chips: [{ text: '매운 것', tone: 'like' }] }] },
  compare: { type: 'compare', question: '어디로?', options: [{ label: 'A', people: [{ name: '민수', ok: 'yes' }] }, { label: 'B', recommended: true }] },
  checklist: { type: 'checklist', title: '준비', items: [{ text: '예약', done: false }] },
  money: { type: 'money', title: '정산', total: 30000, lines: [{ label: '식사', amount: 30000, from: 'a', to: 'b' }] },
  status: { type: 'status', rooms: [{ room: '우리방', items: [{ text: '장소', state: 'decided' }] }] },
};

describe('answer blocks', () => {
  it('모든 블록 타입의 유효 샘플을 통과시킨다', () => {
    expect(Object.keys(valid).sort()).toEqual([...ANSWER_BLOCK_TYPES].sort());
    for (const b of Object.values(valid)) expect(AnswerBlockSchema.safeParse(b).success).toBe(true);
  });

  it('무효 값을 거부한다', () => {
    const bad = [
      { type: 'schedule', days: [{ label: '토', items: [{ title: 'x', status: 'bogus' }] }] },
      { type: 'schedule', days: [{ label: '토', items: [{ start: '25:00', title: 'x', status: 'fixed' }] }] },
      { type: 'profile', title: 't', groups: [{ label: 'g', chips: [{ text: 'x', tone: 'meh' }] }] },
      { type: 'compare', question: 'q', options: [{ label: 'A' }] },
      { type: 'money', title: 't', total: 1.5, lines: [] },
      { type: 'unknown' },
    ];
    for (const b of bad) expect(AnswerBlockSchema.safeParse(b).success).toBe(false);
  });

  it('상한 초과를 거부한다', () => {
    const items = (n: number) => Array.from({ length: n }, () => ({ title: 't', status: 'fixed' }));
    expect(AnswerBlockSchema.safeParse({ type: 'schedule', days: [{ label: 'd', items: items(9) }] }).success).toBe(false);
    expect(AnswerBlockSchema.safeParse({ type: 'schedule', days: Array.from({ length: 8 }, () => ({ label: 'd', items: [] })) }).success).toBe(false);
    expect(AnswerBlockSchema.safeParse({ type: 'compare', question: 'q', options: Array.from({ length: 5 }, () => ({ label: 'o' })) }).success).toBe(false);
    expect(AnswerBlockSchema.safeParse({ type: 'checklist', title: 't', items: [{ text: 'x'.repeat(61) }] }).success).toBe(false);
    const manySources = Array.from({ length: 5 }, () => src[0]);
    expect(AnswerBlockSchema.safeParse({ type: 'checklist', title: 't', items: [{ text: 'x', sources: manySources }] }).success).toBe(false);
  });

  it('message 이벤트: blocks 없이도 유효, 2개까지만 허용', () => {
    expect(MAX_BLOCKS_PER_MESSAGE).toBe(2);
    expect(EventPayloadSchema.safeParse({ type: 'message', text: 'hi' }).success).toBe(true);
    const b = valid.status;
    expect(EventPayloadSchema.safeParse({ type: 'message', text: 'hi', blocks: [b, b] }).success).toBe(true);
    expect(EventPayloadSchema.safeParse({ type: 'message', text: 'hi', blocks: [b, b, b] }).success).toBe(false);
  });

  it('ACTIVITY_PHASES 에 composing 포함', () => {
    expect(ACTIVITY_PHASES).toContain('composing');
  });
});
