import type { AnswerBlock } from '@ensemble/shared';

/** 시각 확인(/lab/answer-blocks)과 테스트용 샘플. 서버가 실제 blocks 를 내기 전에도 6종을 볼 수 있다. */
export const SAMPLE_BLOCKS: Record<string, AnswerBlock> = {
  schedule: {
    type: 'schedule',
    title: '이번 주말 가족 일정',
    days: [
      {
        label: '토 11/22',
        items: [
          { start: '10:00', end: '12:00', title: '할머니 댁 방문', with: '엄마 · 아빠', status: 'fixed', sources: [{ kind: 'memory', label: '내 기억' }] },
          { start: '14:00', end: '16:00', title: '', status: 'free' },
          { start: '16:30', end: '18:00', title: '치과 예약', status: 'conflict', room: '우리 가족' },
        ],
      },
      {
        label: '일 11/23',
        items: [
          { start: '12:00', title: '가족 점심', with: 'Dana', status: 'tentative', sources: [{ kind: 'room', label: '우리 가족 · 카드' }] },
          { when: '저녁', title: '장보기', status: 'pending' },
        ],
      },
    ],
    verdict: '토요일 오후 2시가 가장 여유로워요',
  },
  profile: {
    type: 'profile',
    title: 'Dana의 취향',
    groups: [
      { label: '음식', chips: [{ text: '파스타', tone: 'like' }, { text: '한식', tone: 'like', sources: [{ kind: 'memory', label: '내 기억' }] }, { text: '오이', tone: 'dislike' }] },
      { label: '참고', chips: [{ text: '토요일 오후 선호', tone: 'note' }, { text: '매운 음식 못 먹음', tone: 'dislike' }] },
    ],
  },
  compare: {
    type: 'compare',
    question: '가족 모임 장소는 어디가 좋을까요?',
    options: [
      { label: '할머니 댁', pros: ['이동 거리 짧음'], cons: ['주차 어려움'], people: [{ name: '엄마', ok: 'yes' }, { name: '아빠', ok: 'maybe', note: '일정 확인' }, { name: 'Dana', ok: 'yes' }], recommended: true },
      { label: '식당 예약', pros: ['준비 편함'], cons: ['비용 발생', '대기 가능'], people: [{ name: '엄마', ok: 'yes' }, { name: '아빠', ok: 'no' }, { name: 'Dana', ok: 'yes' }] },
      { label: '야외 공원', pros: ['아이들 좋아함'], people: [{ name: '엄마', ok: 'maybe' }, { name: '아빠', ok: 'yes' }, { name: 'Dana', ok: 'no' }] },
    ],
    recommendation: '할머니 댁이 모두에게 무난해요',
  },
  checklist: {
    type: 'checklist',
    title: '모임 전 준비',
    items: [
      { text: '장소 예약 확인', due: '금요일까지', done: true },
      { text: '케이크 주문', due: '토요일 오전', room: '우리 가족', sources: [{ kind: 'room', label: '우리 가족 · 카드' }] },
      { text: '선물 포장' },
    ],
  },
  money: {
    type: 'money',
    title: '이번 달 정산',
    total: 128000,
    lines: [
      { label: '식비', amount: 84000, from: '아빠', to: '엄마' },
      { label: '교통비', amount: 32000, from: 'Dana', to: '아빠' },
      { label: '환급', amount: -8000 },
      { label: '기타', amount: 20000 },
    ],
    note: '카드 결제 기준이에요',
  },
  status: {
    type: 'status',
    rooms: [
      { room: '우리 가족', items: [{ text: '토요일 오후 2시 모임', state: 'decided' }, { text: '장소 변경', state: 'pending_approval', sources: [{ kind: 'event', label: '승인 요청' }] }] },
      { room: '친구 모임', items: [{ text: '일정 조율', state: 'waiting' }, { text: '장소 투표', state: 'todo' }] },
    ],
  },
};
