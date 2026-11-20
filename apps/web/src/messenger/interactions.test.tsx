import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDto, EventPayload, RoomEvent, UserDto } from '@ensemble/shared';
import { InteractionStrip } from '../room/InteractionStrip';
import { ApprovalCard, approvalViewFromEvents } from './ApprovalCards';
import { A2AThread, ChannelBadge, DirectionChip, InteractionLegend } from './InteractionChips';
import { MessageList } from './MessageList';
import { useRooms } from '../store/roomStore';
import { useSession } from '../store/session';
import { useWorld } from '../store/worldStore';

// zustand v5는 서버 렌더에서 초기 상태만 읽는다. 테스트에서는 setState한 현재 상태를 그대로 읽게 한다.
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

const ROOM = 'room1';
const user = (id: string, name: string, color: string): UserDto => ({ id, name, color, kind: 'person' });
const users: Record<string, UserDto> = {
  alice: user('alice', 'Alice', '#ff7a90'),
  bob: user('bob', 'Bob', '#5ab0ff'),
  dana: user('dana', 'Dana', '#6ee7a0'),
};
const agent = (id: string, name: string, ownerId: string | null, kind: 'personal' | 'room'): AgentDto => ({
  id,
  name,
  ownerId,
  kind,
  personaPublic: '',
  variant: null,
});
const agents: AgentDto[] = [
  agent('ra_team', '팀 Room Agent', null, 'room'),
  agent('ag_alice', 'Alice의 Agent', 'alice', 'personal'),
  agent('ag_bob', 'Bob의 Agent', 'bob', 'personal'),
  agent('ag_dana', 'Dana의 Agent', 'dana', 'personal'),
];
const agentIds = agents.map((a) => a.id);
const nameOf = (id: string) => users[id]?.name ?? agents.find((a) => a.id === id)?.name ?? id;

type Who = { actorKind: RoomEvent['actorKind']; actorId: string | null; turnId?: string | null };
const HUMAN: Who = { actorKind: 'human', actorId: 'alice' };
const RA: Who = { actorKind: 'room_agent', actorId: 'ra_team' };
const AG = (id: string): Who => ({ actorKind: 'agent', actorId: id });
const SYS: Who = { actorKind: 'system', actorId: null };

function makeLog() {
  const events: RoomEvent[] = [];
  const push = (payload: EventPayload, who: Who = HUMAN) => {
    events.push({
      ...payload,
      roomId: ROOM,
      seq: events.length + 1,
      ts: 1_700_000_000_000 + events.length * 1000,
      visibility: 'room',
      turnId: null,
      ...who,
    } as RoomEvent);
  };
  return { events, push };
}

const started = (agentId: string, turnId: string, seq: number, reason: string): EventPayload => ({
  type: 'agent_turn_started',
  agentId,
  turnId,
  trigger: { seq, reason },
});
const ended = (agentId: string, turnId: string): EventPayload => ({ type: 'agent_turn_ended', agentId, turnId, result: 'acted' });

/** 사람 질문 -> Room Agent ask([bob, dana]) -> 두 답 -> 정리 -> 승인 요청(Alice, Bob) */
function teamLog(opts: { danaAnswers?: boolean; extraThread?: boolean } = {}) {
  const { danaAnswers = true, extraThread = false } = opts;
  const { events, push } = makeLog();
  push({ type: 'message', text: '금요일 회고 당겨도 될까?' });
  push(started('ra_team', 't1', 1, 'room_agent_call'), { ...RA, turnId: 't1' });
  push({ type: 'message', text: '일정 괜찮을까요?', recipients: ['ag_bob', 'ag_dana'] }, { ...RA, turnId: 't1' }); // 3
  push(ended('ra_team', 't1'), { ...RA, turnId: 't1' });
  push(started('ag_bob', 't2', 3, 'a2a_ask'), { ...AG('ag_bob'), turnId: 't2' });
  push({ type: 'message', text: '오히려 좋아요', to: 'ra_team', replyTo: 3 }, { ...AG('ag_bob'), turnId: 't2' }); // 6
  push(ended('ag_bob', 't2'), { ...AG('ag_bob'), turnId: 't2' });
  push(started('ag_dana', 't3', 3, 'a2a_ask'), { ...AG('ag_dana'), turnId: 't3' });
  if (danaAnswers) {
    push({ type: 'message', text: '괜찮아요', to: 'ra_team', replyTo: 3 }, { ...AG('ag_dana'), turnId: 't3' });
    push(ended('ag_dana', 't3'), { ...AG('ag_dana'), turnId: 't3' });
    push(started('ra_team', 't4', 3, 'a2a_collect'), { ...RA, turnId: 't4' });
    push({ type: 'message', text: '정리하면 가능해요', replyTo: 3 }, { ...RA, turnId: 't4' });
    push(
      { type: 'approval_requested', approvalId: 'ap1', approvers: ['alice', 'bob'], kind: 'edit', summary: '14시 반으로 수정할까요?' },
      { ...RA, turnId: 't4' },
    );
  }
  if (extraThread) {
    push({ type: 'message', text: '메뉴는 어때?' });
    push(started('ra_team', 't5', events.length, 'room_agent_call'), { ...RA, turnId: 't5' });
    push({ type: 'message', text: '메뉴 의견 주세요', recipients: ['ag_bob'] }, { ...RA, turnId: 't5' });
    push(started('ag_bob', 't6', events.length, 'a2a_ask'), { ...AG('ag_bob'), turnId: 't6' });
    push({ type: 'message', text: '국밥이요', to: 'ra_team', replyTo: events.length - 1 }, { ...AG('ag_bob'), turnId: 't6' });
    push(ended('ag_bob', 't6'), { ...AG('ag_bob'), turnId: 't6' });
  }
  return events;
}

function renderList(events: RoomEvent[]) {
  useRooms.setState({ rooms: { [ROOM]: { events, agents, lastSeq: events.length, snapshotLoaded: true, presence: [] } }, pending: [] });
  useWorld.setState({ users, rooms: {} });
  return renderToStaticMarkup(<MessageList roomId={ROOM} meId="alice" users={users} />);
}

describe('ChannelBadge / DirectionChip / 범례', () => {
  it('약어 배지와 한국어 툴팁', () => {
    const a2a = renderToStaticMarkup(<ChannelBadge channel="a2a" />);
    expect(a2a).toContain('>A2A<');
    expect(a2a).toContain('A2A — Agent끼리 주고받음');
    const a2h = renderToStaticMarkup(<ChannelBadge channel="a2h" />);
    expect(a2h).toContain('A2H — Agent가 사람에게 묻거나 알림');
  });

  it('방향 칩은 받는 이마다 색을 쓰고, 받는 이가 없으면 그리지 않는다', () => {
    const html = renderToStaticMarkup(
      <DirectionChip from={{ name: 'Room', color: '#a3e635' }} to={[{ name: 'Bob', color: '#5ab0ff' }, { name: 'Dana', color: '#6ee7a0' }]} />,
    );
    expect(html).toMatch(/Room.*→.*Bob.*Dana/);
    expect(html).toContain('#5ab0ff var(--ink-pct)');
    expect(html).toContain('#6ee7a0 var(--ink-pct)');
    expect(renderToStaticMarkup(<DirectionChip to={[]} />)).toBe('');
  });

  it('범례에 세 채널이 모두 있다', () => {
    const html = renderToStaticMarkup(<InteractionLegend />);
    expect(html).toContain('Agent끼리');
    expect(html).toContain('Agent→사람');
    expect(html).toContain('사람→Agent');
  });
});

describe('A2AThread 컴포넌트', () => {
  const props = {
    threadSeq: 3,
    from: { name: 'Room', color: '#a3e635' },
    to: [{ name: 'Bob의 Agent', color: '#5ab0ff' }],
    answered: 1,
    total: 2,
    preview: '↩ Bob: 좋아요',
  };
  it('펼침: 본문이 보이고 미리보기는 없다', () => {
    const html = renderToStaticMarkup(
      <A2AThread {...props} open expanded>
        <li>본문행</li>
      </A2AThread>,
    );
    expect(html).toContain('data-expanded="true"');
    expect(html).toContain('본문행');
    expect(html).toContain('답 1/2 대기 중');
    expect(html).not.toContain('a2a-thread-preview');
  });
  it('접힘: 헤더와 한 줄 미리보기만 보인다', () => {
    const html = renderToStaticMarkup(
      <A2AThread {...props} open={false} expanded={false}>
        <li>본문행</li>
      </A2AThread>,
    );
    expect(html).toContain('data-expanded="false"');
    expect(html).not.toContain('본문행');
    expect(html).toContain('↩ Bob: 좋아요');
    expect(html).toContain('답 1/2');
  });
});

describe('MessageList 통합', () => {
  beforeEach(() => {
    useSession.setState({ agent: null });
  });

  it('A2A 스레드: 질문과 답이 한 묶음, 답은 ↩, 결과는 스레드 밖에 칩과 함께', () => {
    const html = renderList(teamLog());
    expect(html.match(/data-testid="a2a-thread"/g)).toHaveLength(1);
    expect(html).toContain('data-expanded="true"'); // 가장 최근 스레드는 펼침
    expect(html).toContain('일정 괜찮을까요?');
    expect(html).toContain('오히려 좋아요');
    expect(html.match(/data-testid="reply-mark"/g)).toHaveLength(2);
    // 방향 칩: 질문은 두 수신자
    expect(html).toMatch(/Bob의 Agent.*Dana의 Agent/);
    // 정리(a2a_result)는 스레드 밖, "↳ A2A 결과"
    const bodyEnd = html.indexOf('</ul>', html.indexOf('data-testid="a2a-thread-body"'));
    const resultAt = html.indexOf('정리하면 가능해요');
    expect(resultAt).toBeGreaterThan(bodyEnd);
    expect(html).toContain('↳ A2A 결과');
    expect(html).toContain('data-seq="3"');
  });

  it('A2H 승인 카드: 헤더와 A2A 대화 링크', () => {
    const html = renderList(teamLog());
    expect(html).toContain('data-testid="a2h-header"');
    expect(html).toContain('A2H — Agent가 사람에게 묻거나 알림');
    expect(html).toContain('팀 Room Agent');
    expect(html).toContain('승인 요청');
    expect(html).toContain('↳ A2A 대화에서');
  });

  it('A2H 헤더는 승인자 이름을 쓴다(나는 "나")', () => {
    const events = teamLog();
    const e = events.find((x) => x.type === 'approval_requested') as Extract<RoomEvent, { type: 'approval_requested' }>;
    const view = { ...approvalViewFromEvents(ROOM, e, undefined, '팀 Room Agent'), a2h: { threadSeq: null } };
    const html = renderToStaticMarkup(<ApprovalCard view={view} meId="alice" users={users} />);
    expect(html).toMatch(/data-testid="a2h-approvers"[^>]*>나, Bob</);
    expect(html).not.toContain('↳ A2A 대화에서');
    // A2H가 아닌 승인 카드에는 헤더가 없다
    const plain = renderToStaticMarkup(<ApprovalCard view={{ ...view, a2h: undefined }} meId="alice" users={users} />);
    expect(plain).not.toContain('a2h-header');
  });

  it('접기 정책: 닫힌 이전 스레드는 접고, 열린/최근 스레드는 펼친다', () => {
    const html = renderList(teamLog({ extraThread: true }));
    const threads = html.split('data-testid="a2a-thread"').slice(1);
    expect(threads).toHaveLength(2);
    expect(threads[0]).toContain('data-expanded="false"'); // 이전(닫힘)
    expect(threads[0]).toContain('data-testid="a2a-thread-preview"');
    expect(threads[1]).toContain('data-expanded="true"'); // 최근
    expect(html).not.toContain('일정 괜찮을까요?'); // 접힌 스레드의 질문 말풍선은 숨김
  });

  it('열린 스레드(답 대기)는 이전 스레드여도 펼치고 대기 수를 보인다', () => {
    const html = renderList(teamLog({ danaAnswers: false }));
    expect(html).toContain('data-open="true"');
    expect(html).toContain('답 1/2 대기 중');
    expect(html).toContain('data-expanded="true"');
  });

  it('레거시 to=Agent 메시지는 스레드 없이 A2A 배지 + 방향 칩', () => {
    const { events, push } = makeLog();
    push({ type: 'message', text: 'ping' }, { ...AG('ag_alice'), turnId: null });
    events[0] = { ...events[0]!, to: 'ag_bob' } as RoomEvent;
    const html = renderList(events);
    expect(html).not.toContain('a2a-thread');
    expect(html).toContain('data-channel="a2a"');
    expect(html).toMatch(/data-testid="to-chip"[^>]*>.*Bob의 Agent/);
  });

  it('일반 발화(to 없음)에는 배지가 없고, Agent가 사람에게 말하면 A2H 배지', () => {
    const { events, push } = makeLog();
    push({ type: 'message', text: '그냥 말' }, { ...AG('ag_alice') });
    push({ type: 'message', text: '확인 부탁해요', to: 'bob' }, { ...AG('ag_alice') });
    const html = renderList(events);
    expect(html.match(/data-testid="channel-badge"/g)).toHaveLength(1);
    expect(html).toContain('data-channel="a2h"');
  });

  it('사람이 Agent에게 직접 말하면 H→A 배지', () => {
    const { events, push } = makeLog();
    push({ type: 'message', text: '맞춰 줘', to: 'ag_alice' });
    const html = renderList(events);
    expect(html).toContain('data-channel="h2a"');
    expect(html).toContain('H→A');
  });
});

describe('InteractionStrip', () => {
  const render = (events: RoomEvent[]) => renderToStaticMarkup(<InteractionStrip events={events} agentIds={agentIds} nameOf={nameOf} />);

  it('단계 순서: 사람 → (A2A) → (A2H) 순, pending은 맥동', () => {
    const { events, push } = makeLog();
    push({ type: 'message', text: '맞춰 줘', to: 'ra_team' });
    push(started('ra_team', 't1', 1, 'room_agent_call'), { ...RA, turnId: 't1' });
    push({ type: 'message', text: '일정?', recipients: ['ag_bob', 'ag_dana'] }, { ...RA, turnId: 't1' });
    push({ type: 'approval_requested', approvalId: 'ap1', approvers: ['alice', 'bob'], kind: 'edit', summary: 's' }, { ...RA, turnId: 't1' });
    const html = render(events);
    let pos = -1;
    for (const part of ['Alice', '─H→A▶', '팀 Room Agent', '═A2A⇄', 'Bob의 Agent, Dana의 Agent', '─A2H▶', 'Alice, Bob', '승인 대기']) {
      const at = html.indexOf(part, pos + 1);
      expect(at, part).toBeGreaterThan(pos);
      pos = at;
    }
    expect(html).toContain('animate-pulse');
    expect(html).toContain('data-testid="interaction-legend"');
    expect(html.match(/data-testid="flow-step"/g)).toHaveLength(3);
  });

  it('답과 정리(a2a_answer/a2a_result)는 단계로 나오지 않는다', () => {
    const html = render(teamLog());
    // 사람 -> (room_agent_call, h2a 아님) 이므로 단계는 ask, approval 둘
    expect(html.match(/data-testid="flow-step"/g)).toHaveLength(2);
  });

  it('상호작용이 없으면 띠를 숨긴다', () => {
    const { events, push } = makeLog();
    push({ type: 'message', text: '안녕' });
    push({ type: 'message', text: '안녕하세요' }, { ...AG('ag_alice') });
    expect(render(events)).toBe('');
    expect(render([])).toBe('');
    void SYS;
  });

  it('replay: 잘린 이벤트만 반영한다', () => {
    const events = teamLog();
    const html = render(events.filter((e) => e.seq <= 3));
    expect(html).toContain('답 대기');
    expect(html).not.toContain('─A2H▶');
  });
});
