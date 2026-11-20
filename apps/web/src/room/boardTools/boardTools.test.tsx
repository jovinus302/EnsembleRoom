import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ladderResult, ladderRungs, type CustomTool, type LadderTool, type SettlementTool, type ToolBase, type TripTool } from '@ensemble/shared';
import { useBoardToolUi } from '../../store/boardToolStore';
import { CustomPanel } from './CustomPanel';
import { ToolCover } from './common';
import { LadderPanel, ladderLayout, ladderPathPoints } from './LadderPanel';
import { SettlementPanel, parseAmount } from './SettlementPanel';
import { TripPanel, itemsOfDay, tripDayLabel } from './TripPanel';

const base = (toolId: string): ToolBase => ({
  toolId,
  title: '테스트',
  ownerTag: 'ours',
  createdBy: { kind: 'room_agent', id: 'ra1' },
  createdSeq: 1,
  updatedSeq: 1,
  removed: false,
  cover: null,
  rev: 0,
});

const names = ['Alice', 'Bob', 'Dana'];
const ladder = (ran: boolean): LadderTool => {
  const rungs = ladderRungs(12345, 3, 8);
  return {
    ...base('t_l'),
    kind: 'ladder',
    participants: names,
    outcomes: ['커피 사기', '꽝', '꽝'],
    run: ran ? { seed: 12345, seq: 9, by: { kind: 'human', id: 'u1' }, rungs, result: ladderResult(3, rungs, 8) } : null,
  };
};

describe('boardToolStore', () => {
  it('open/close', () => {
    useBoardToolUi.getState().open('t_1');
    expect(useBoardToolUi.getState().openToolId).toBe('t_1');
    useBoardToolUi.getState().close();
    expect(useBoardToolUi.getState().openToolId).toBeNull();
  });
});

describe('ladder geometry', () => {
  it('경로의 끝 x는 결과 열의 x', () => {
    const t = ladder(true);
    const lay = ladderLayout(3, 8);
    const result = t.run!.result;
    for (let i = 0; i < 3; i++) {
      const pts = ladderPathPoints(3, t.run!.rungs, 8, i).split(' ');
      expect(pts[pts.length - 1]!.split(',')[0]).toBe(String(lay.x(result[i]!)));
    }
  });
});

describe('LadderPanel', () => {
  it('실행 전: 가로줄 없음, 방문자는 실행 버튼 비활성', () => {
    const html = renderToStaticMarkup(<LadderPanel tool={ladder(false)} roomId="r" canEdit={false} reducedMotion />);
    expect(html).toContain('data-ran="false"');
    expect(html).not.toContain('ladder-rung');
    expect(html).toMatch(/data-testid="ladder-run"[^>]*\sdisabled=""/);
    expect(html).not.toContain('ladder-edit');
  });
  it('실행 전 편집 가능: 실행 버튼 활성 + 편집 폼', () => {
    const html = renderToStaticMarkup(<LadderPanel tool={ladder(false)} roomId="r" canEdit reducedMotion />);
    expect(html).not.toMatch(/data-testid="ladder-run"[^>]*\sdisabled=""/);
    expect(html).toContain('ladder-edit');
  });
  it('실행 후: run.rungs 그대로 그리고 결과 목록·다시 하기', () => {
    const t = ladder(true);
    const html = renderToStaticMarkup(<LadderPanel tool={t} roomId="r" canEdit reducedMotion />);
    expect((html.match(/data-testid="ladder-rung"/g) ?? []).length).toBe(t.run!.rungs.length);
    expect((html.match(/data-testid="ladder-path"/g) ?? []).length).toBe(3);
    expect(html).toContain('ladder-results');
    expect(html).toContain('ladder-reset');
    expect(html).not.toContain('data-testid="ladder-run"');
  });
});

describe('SettlementPanel', () => {
  const tool: SettlementTool = {
    ...base('t_s'),
    kind: 'settlement',
    participants: ['Alice', 'Bob'],
    expenses: [
      { expenseId: 'e_1', label: '영화표', payer: 'Alice', amount: 24000, splitAmong: ['Alice', 'Bob'] },
      { expenseId: 'e_2', label: '팝콘', payer: 'Bob', amount: 12000, splitAmong: ['Alice', 'Bob'] },
    ],
  };
  it('정산 결과 Bob → Alice 6,000원', () => {
    const html = renderToStaticMarkup(<SettlementPanel tool={tool} roomId="r" canEdit />);
    expect(html).toContain('6,000원');
    expect(html).toMatch(/Bob<\/span> <span[^>]*>→<\/span> <span[^>]*>Alice/);
    expect(html).toContain('expense-form');
  });
  it('방문자: 폼·삭제 없음, 결과는 보임', () => {
    const html = renderToStaticMarkup(<SettlementPanel tool={tool} roomId="r" canEdit={false} />);
    expect(html).not.toContain('expense-form');
    expect(html).not.toContain('삭제');
    expect(html).toContain('settle-transfers');
  });
  it('parseAmount', () => {
    expect(parseAmount('24,000')).toBe(24000);
    expect(parseAmount('1.5')).toBeNull();
    expect(parseAmount('0')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });
});

describe('TripPanel', () => {
  const tool: TripTool = {
    ...base('t_t'),
    kind: 'trip',
    days: 2,
    startDate: '2026-05-02',
    items: [
      { itemId: 'i_1', day: 1, place: '메모 없음' },
      { itemId: 'i_2', day: 1, time: '13:00', place: '점심' },
      { itemId: 'i_3', day: 1, time: '11:00', place: '장보기' },
      { itemId: 'i_4', day: 2, time: '09:00', place: '산책' },
    ],
    checklist: [
      { checkId: 'k_1', text: '장바구니', done: true },
      { checkId: 'k_2', text: '디저트 예약', done: false },
    ],
  };
  it('시간순 정렬(시간 없는 항목은 뒤)', () => {
    expect(itemsOfDay(tool.items, 1).map((i) => i.itemId)).toEqual(['i_3', 'i_2', 'i_1']);
  });
  it('날짜 라벨', () => {
    expect(tripDayLabel(null, 2)).toBe('2일차');
    expect(tripDayLabel('2026-05-02', 2)).toBe('2일차 · 5/3(일)');
  });
  it('방문자는 체크박스 비활성, 편집자는 활성', () => {
    const v = renderToStaticMarkup(<TripPanel tool={tool} roomId="r" canEdit={false} />);
    expect(v).toContain('1/2');
    expect(v).not.toContain('trip-item-form');
    expect((v.match(/type="checkbox"[^>]*\sdisabled=""/g) ?? []).length).toBe(2);
    const e = renderToStaticMarkup(<TripPanel tool={tool} roomId="r" canEdit />);
    expect(e).toContain('trip-item-form');
    expect((e.match(/type="checkbox"[^>]*\sdisabled=""/g) ?? []).length).toBe(0);
  });
});

describe('CustomPanel', () => {
  const evil = '<img src=x onerror=alert(1)> <script>alert(2)</script>';
  const tool: CustomTool = {
    ...base('t_c'),
    kind: 'custom',
    blocks: [
      { type: 'text', blockId: 'b_1', text: evil },
      { type: 'checklist', blockId: 'b_2', title: '할 일', items: [{ checkId: 'k_1', text: '장보기', done: true }, { checkId: 'k_2', text: '예약', done: false }] },
      {
        type: 'vote',
        blockId: 'b_3',
        question: '뭐 먹지?',
        options: [{ optionId: 'o_1', text: '라멘' }, { optionId: 'o_2', text: '국밥' }],
        votes: { me: 'o_2', u2: 'o_2', u3: 'o_1' },
      },
      { type: 'counter', blockId: 'b_4', label: '커피 잔 수', min: 0, max: 3, value: 3 },
    ],
  };

  it('블록 4종을 그리고, 사용자 문자열은 텍스트로만 이스케이프된다(HTML 주입 없음)', () => {
    const html = renderToStaticMarkup(<CustomPanel tool={tool} roomId="r" canEdit meId="me" />);
    expect((html.match(/data-testid="custom-block"/g) ?? []).length).toBe(4);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('1/2');
  });

  it('투표: 집계·내 표 표시, 카운터는 최댓값에서 + 비활성', () => {
    const html = renderToStaticMarkup(<CustomPanel tool={tool} roomId="r" canEdit meId="me" />);
    expect(html).toMatch(/data-option-id="o_2" data-selected="true"/);
    expect(html).toMatch(/data-option-id="o_1" data-selected="false"/);
    expect(html).toContain('2표');
    expect(html).toContain('3표 ·');
    expect(html).toMatch(/data-testid="counter-inc"[^>]*\sdisabled=""/);
    expect(html).not.toMatch(/data-testid="counter-dec"[^>]*\sdisabled=""/);
    expect(html).toContain('custom-add-form');
  });

  it('방문자(canEdit=false): 체크박스·투표·카운터 버튼 비활성, 편집 폼·삭제 없음', () => {
    const html = renderToStaticMarkup(<CustomPanel tool={tool} roomId="r" canEdit={false} meId="v" />);
    expect((html.match(/type="checkbox"[^>]*\sdisabled=""/g) ?? []).length).toBe(2);
    expect((html.match(/data-testid="vote-option"[^>]*\sdisabled=""/g) ?? []).length).toBe(2);
    expect(html).toMatch(/data-testid="counter-dec"[^>]*\sdisabled=""/);
    expect(html).not.toContain('custom-add-form');
    expect(html).not.toContain('custom-block-remove');
    expect(html).toContain('보기만');
  });

  it('선택지 없는 투표: 안내 문구와 추가 입력', () => {
    const empty: CustomTool = { ...tool, blocks: [{ type: 'vote', blockId: 'b_9', question: '점심?', options: [], votes: {} }] };
    const html = renderToStaticMarkup(<CustomPanel tool={empty} roomId="r" canEdit meId="me" />);
    expect(html).toContain('아직 선택지가 없어요');
    expect(html).toContain('선택지 추가');
  });
});

describe('ToolCover', () => {
  const trip = (cover: TripTool['cover']): TripTool => ({ ...base('t_c'), kind: 'trip', days: 1, startDate: null, items: [], checklist: [], cover });
  it('커버 없음·실패: 기본 일러스트(생성 중 표시 없음), 생성 중: 은은한 표시, 사다리는 렌더하지 않음', () => {
    const none = renderToStaticMarkup(<ToolCover tool={trip(null)} />);
    expect(none).toContain('data-cover-state="default"');
    expect(none).not.toContain('tool-cover-pending');
    expect(renderToStaticMarkup(<ToolCover tool={trip({ status: 'failed', assetId: null })} />)).toContain('data-cover-state="default"');
    const pending = renderToStaticMarkup(<ToolCover tool={trip({ status: 'pending', assetId: null })} />);
    expect(pending).toContain('data-cover-state="pending"');
    expect(pending).toContain('이미지 생성 중');
    expect(renderToStaticMarkup(<ToolCover tool={ladder(false)} />)).toBe('');
  });
});
