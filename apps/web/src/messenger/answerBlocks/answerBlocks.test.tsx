import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDto, AnswerBlock, RoomEvent, UserDto } from '@ensemble/shared';
import { MessageList } from '../MessageList';
import { useRooms } from '../../store/roomStore';
import { useWorld } from '../../store/worldStore';
import { AnswerBlocks } from './AnswerBlocks';
import { SAMPLE_BLOCKS } from './samples';

vi.mock('zustand', async (orig) => {
  const actual = await orig<typeof import('zustand')>();
  return {
    ...actual,
    create: ((init: import('zustand').StateCreator<unknown, [], []>) => {
      const store = actual.createStore<unknown>(init);
      const hook = (sel: (s: unknown) => unknown = (x) => x) => sel(store.getState());
      return Object.assign(hook, store);
    }) as unknown as typeof actual.create,
  };
});

const html = (b: AnswerBlock) => renderToStaticMarkup(<AnswerBlocks blocks={[b]} />);

describe('AnswerBlocks', () => {
  it('schedule: 상태 표시와 verdict', () => {
    const h = html(SAMPLE_BLOCKS.schedule!);
    expect(h).toContain('data-testid="ab-schedule"');
    expect(h).toContain('data-status="conflict"');
    expect(h).toContain('겹침');
    expect(h).toContain('비어 있음');
    expect(h).toContain('토요일 오후 2시가 가장 여유로워요');
  });
  it('schedule: 4일 이상이면 세로 타임라인', () => {
    const b = SAMPLE_BLOCKS.schedule as Extract<AnswerBlock, { type: 'schedule' }>;
    const days = ['월', '화', '수', '목'].map((label) => ({ label, items: b.days[0]!.items.slice(0, 1) }));
    const h = html({ ...b, days });
    expect(h).toContain('ab-timeline');
    expect(html(b)).toContain('ab-strip');
  });
  it('profile: 좋아함/싫어함 칩', () => {
    const h = html(SAMPLE_BLOCKS.profile!);
    expect(h).toContain('data-tone="like"');
    expect(h).toContain('data-tone="dislike"');
    expect(h).toContain('✦ 내 기억');
  });
  it('compare: 추천 열 하나와 ○ × △', () => {
    const h = html(SAMPLE_BLOCKS.compare!);
    expect(h.match(/data-testid="ab-rec"/g)).toHaveLength(1);
    expect(h).toContain('○');
    expect(h).toContain('×');
    expect(h).toContain('△');
  });
  it('checklist: 읽기 전용(버튼·입력 없음)', () => {
    const h = html(SAMPLE_BLOCKS.checklist!);
    expect(h).toContain('data-testid="ab-checklist"');
    expect(h).not.toMatch(/<button|<input/);
  });
  it('money: 천 단위 구분과 합계', () => {
    const h = html(SAMPLE_BLOCKS.money!);
    expect(h).toContain('84,000원');
    expect(h).toContain('data-testid="ab-total"');
    expect(h).toContain('128,000원');
    expect(h).toContain('아빠 → 엄마');
  });
  it('status: 방별 섹션과 상태 알약', () => {
    const h = html(SAMPLE_BLOCKS.status!);
    expect(h).toContain('우리 가족');
    expect(h).toContain('data-state="pending_approval"');
    expect(h).toContain('★ 결정');
  });
  it('모르는 type은 무시하고, 빈 blocks면 아무것도 그리지 않는다', () => {
    const unknown = { type: 'hologram', x: 1 } as unknown as AnswerBlock;
    expect(renderToStaticMarkup(<AnswerBlocks blocks={[unknown]} />)).toBe('');
    expect(renderToStaticMarkup(<AnswerBlocks blocks={[]} />)).toBe('');
    expect(renderToStaticMarkup(<AnswerBlocks />)).toBe('');
    const mixed = renderToStaticMarkup(<AnswerBlocks blocks={[unknown, SAMPLE_BLOCKS.money!]} />);
    expect(mixed).toContain('ab-money');
    expect(mixed).not.toContain('hologram');
  });
});

describe('메시지 행의 답변 카드', () => {
  const users: Record<string, UserDto> = { alice: { id: 'alice', name: 'Alice', color: '#ff7a90', kind: 'person' } };
  const agents: AgentDto[] = [{ id: 'ag_alice', name: 'Alice의 Agent', ownerId: 'alice', kind: 'personal', personaPublic: '', variant: null }];
  const msg = (blocks?: AnswerBlock[]): RoomEvent =>
    ({
      type: 'message',
      text: '정리했어요',
      roomId: 'r1',
      seq: 1,
      ts: 1_700_000_000_000,
      visibility: 'room',
      turnId: 't1',
      actorKind: 'agent',
      actorId: 'ag_alice',
      ...(blocks ? { blocks } : {}),
    }) as RoomEvent;
  const render = (e: RoomEvent) => {
    useRooms.setState({ rooms: { r1: { events: [e], agents, lastSeq: 1, snapshotLoaded: true, presence: [] } }, pending: [] });
    useWorld.setState({ users, rooms: {} });
    return renderToStaticMarkup(<MessageList roomId="r1" meId="alice" users={users} />);
  };
  it('blocks가 있으면 말풍선 아래에 카드가 뜬다', () => {
    const h = render(msg([SAMPLE_BLOCKS.money!]));
    expect(h).toContain('data-testid="answer-blocks"');
    expect(h.indexOf('agent-bubble')).toBeLessThan(h.indexOf('answer-blocks'));
  });
  it('blocks가 없으면 카드가 없다', () => {
    expect(render(msg())).not.toContain('answer-blocks');
  });
});
