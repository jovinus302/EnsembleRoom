import { describe, expect, it } from 'vitest';
import {
  buildAgentState,
  buildAgentStates,
  initialAgentState,
  reduceAgentState,
  type AgentRef,
  type EventPayload,
  type RoomEvent,
} from '../src';
import { makeLog, type LogOpts } from './helpers';

const alice: AgentRef = { agentId: 'agent-alice', ownerUserId: 'alice', homeRoomId: 'room-alice' };
const roomAgent: AgentRef = { agentId: 'ra-friends', ownerUserId: null, homeRoomId: 'room-friends' };

/** 이벤트 목록을 차례로 먹여 마지막 상태를 돌려준다 */
function run(ref: AgentRef, steps: [EventPayload, LogOpts?][]) {
  const { events, push } = makeLog(ref.homeRoomId ?? 'r');
  let state = initialAgentState(ref);
  const history = [state];
  for (const [p, o] of steps) {
    const e = push(p, o);
    state = reduceAgentState(ref, state, e);
    history.push(state);
  }
  return { state, history, events };
}

const turnStart: EventPayload = {
  type: 'agent_turn_started',
  agentId: 'agent-alice',
  turnId: 't1',
  trigger: { seq: 1, reason: 'mention' },
};
const agentActor: LogOpts = { actorKind: 'agent', actorId: 'agent-alice', turnId: 't1' };

describe('agentState (8.5 표 1:1)', () => {
  it('(기본) idle, 캡슐 안에 머묾', () => {
    const s = initialAgentState(alice);
    expect(s).toMatchObject({
      activity: 'idle',
      mode: 'accompanied',
      location: 'room-alice',
      target: null,
      handoverPending: false,
    });
  });

  it('다른 행위자의 room 이벤트: idle + 그쪽을 본다', () => {
    const { state } = run(alice, [[{ type: 'message', text: '안녕' }, { actorId: 'bob' }]]);
    expect(state.activity).toBe('idle');
    expect(state.target).toEqual({ kind: 'user', id: 'bob' });

    const { state: s2 } = run(alice, [
      [{ type: 'message', text: 'hi', to: 'agent-alice' }, { actorKind: 'agent', actorId: 'agent-bob' }],
    ]);
    expect(s2.target).toEqual({ kind: 'agent', id: 'agent-bob' });
  });

  it('자기 자신의 이벤트와 system 이벤트에는 반응하지 않는다', () => {
    const { state } = run(alice, [
      [{ type: 'message', text: 'x' }, { actorKind: 'agent', actorId: 'agent-alice' }],
      [{ type: 'card_created', cardId: 'c', title: 't', body: '', ownerTag: 'ours' }, { actorKind: 'system', actorId: null }],
    ]);
    expect(state.target).toBeNull();
  });

  it('thinking 중에는 다른 사람 이벤트로 시선을 옮기지 않는다', () => {
    const { state } = run(alice, [
      [turnStart, agentActor],
      [{ type: 'message', text: 'x' }, { actorId: 'bob' }],
    ]);
    expect(state.activity).toBe('thinking');
    expect(state.target).toBeNull();
  });

  it('agent_turn_started: thinking', () => {
    const { state } = run(alice, [[turnStart, agentActor]]);
    expect(state).toMatchObject({ activity: 'thinking', recalling: false, turnId: 't1' });
  });

  it('다른 Agent의 턴은 이 Agent 상태를 바꾸지 않는다', () => {
    const { state } = run(alice, [
      [{ ...turnStart, agentId: 'agent-bob' } as EventPayload, { actorKind: 'agent', actorId: 'agent-bob' }],
    ]);
    expect(state.activity).toBe('idle');
  });

  it('agent_step recalling: thinking + recalling', () => {
    const { state } = run(alice, [
      [turnStart, agentActor],
      [{ type: 'agent_step', agentId: 'agent-alice', turnId: 't1', kind: 'recalling' }, agentActor],
    ]);
    expect(state).toMatchObject({ activity: 'thinking', recalling: true });
  });

  it('agent_step drafting: drafting (recalling 해제)', () => {
    const { state } = run(alice, [
      [turnStart, agentActor],
      [{ type: 'agent_step', agentId: 'agent-alice', turnId: 't1', kind: 'recalling' }, agentActor],
      [{ type: 'agent_step', agentId: 'agent-alice', turnId: 't1', kind: 'drafting' }, agentActor],
    ]);
    expect(state).toMatchObject({ activity: 'drafting', recalling: false });
  });

  it('agent_step talking{target}: talking + 대상 Agent', () => {
    const { state } = run(alice, [
      [turnStart, agentActor],
      [{ type: 'agent_step', agentId: 'agent-alice', turnId: 't1', kind: 'talking', target: 'agent-bob' }, agentActor],
    ]);
    expect(state).toMatchObject({ activity: 'talking', target: { kind: 'agent', id: 'agent-bob' } });
  });

  it('approval_requested: awaiting + 승인자 좌석을 봄, 턴이 끝나도 유지, resolved에서 idle', () => {
    const { history, state } = run(alice, [
      [turnStart, agentActor],
      [
        { type: 'approval_requested', approvalId: 'a1', approvers: ['alice'], kind: 'decision', summary: 's' },
        agentActor,
      ],
      [{ type: 'agent_turn_ended', agentId: 'agent-alice', turnId: 't1', result: 'acted' }, agentActor],
      [{ type: 'approval_resolved', approvalId: 'a1', outcome: 'approved' }, { actorKind: 'system', actorId: null }],
    ]);
    expect(history[2]).toMatchObject({ activity: 'awaiting', approvalId: 'a1', target: { kind: 'user', id: 'alice' } });
    expect(history[3]).toMatchObject({ activity: 'awaiting', approvalId: 'a1' });
    expect(state).toMatchObject({ activity: 'idle', approvalId: null, target: null });
  });

  it('다른 Agent가 낸 승인 요청에는 awaiting 되지 않는다', () => {
    const { state } = run(alice, [
      [
        { type: 'approval_requested', approvalId: 'a1', approvers: ['bob'], kind: 'decision', summary: 's' },
        { actorKind: 'room_agent', actorId: 'ra-friends' },
      ],
    ]);
    expect(state.activity).toBe('idle');
  });

  it('agent_turn_ended pass: idle + 끄덕임 (acted는 cue 없음, error는 scatter)', () => {
    const pass = run(alice, [
      [turnStart, agentActor],
      [{ type: 'agent_turn_ended', agentId: 'agent-alice', turnId: 't1', result: 'pass', passReason: 'not_addressed' }, agentActor],
    ]);
    expect(pass.state).toMatchObject({ activity: 'idle', turnId: null, cue: { kind: 'nod', seq: 2 } });

    const acted = run(alice, [
      [turnStart, agentActor],
      [{ type: 'agent_turn_ended', agentId: 'agent-alice', turnId: 't1', result: 'acted' }, agentActor],
    ]);
    expect(acted.state).toMatchObject({ activity: 'idle', cue: null });

    const error = run(alice, [
      [turnStart, agentActor],
      [{ type: 'agent_turn_ended', agentId: 'agent-alice', turnId: 't1', result: 'error' }, agentActor],
    ]);
    expect(error.state.cue).toEqual({ kind: 'scatter', seq: 2 });
  });

  it('agent_paused: paused, 사람 이벤트가 오면 해제된다', () => {
    const paused = run(alice, [[{ type: 'agent_paused', agentId: 'agent-alice', reason: 'chain_limit' }, { actorKind: 'system', actorId: null }]]);
    expect(paused.state.activity).toBe('paused');

    const woke = run(alice, [
      [{ type: 'agent_paused', agentId: 'agent-alice', reason: 'chain_limit' }, { actorKind: 'system', actorId: null }],
      [{ type: 'message', text: '계속' }, { actorId: 'bob' }],
    ]);
    expect(woke.state.activity).toBe('idle');
    expect(woke.state.target).toEqual({ kind: 'user', id: 'bob' });
  });

  it('member_left(소유자, mandate 있음): representing + 소유자 좌석으로', () => {
    const { state } = run(alice, [
      [
        {
          type: 'member_left',
          userId: 'alice',
          implicit: false,
          agentId: 'agent-alice',
          mandate: { text: 'm', allowedActions: ['chat'] },
        },
      ],
    ]);
    expect(state).toMatchObject({ mode: 'representing', ownerAway: true, target: { kind: 'owner_seat', id: 'alice' } });
  });

  it('member_left(mandate 없음)와 다른 사람의 member_left는 representing이 아니다', () => {
    const noMandate = run(alice, [[{ type: 'member_left', userId: 'alice', implicit: true }]]);
    expect(noMandate.state).toMatchObject({ mode: 'accompanied', ownerAway: true });
    const other = run(alice, [[{ type: 'member_left', userId: 'bob', implicit: false, mandate: { text: 'm', allowedActions: [] }, agentId: 'agent-bob' }]]);
    expect(other.state).toMatchObject({ mode: 'accompanied', ownerAway: false });
  });

  const leave: [EventPayload, LogOpts?] = [
    {
      type: 'member_left',
      userId: 'alice',
      implicit: false,
      agentId: 'agent-alice',
      mandate: { text: 'm', allowedActions: ['chat'] },
    },
  ];

  it('agent_departed: traveling, 위치 없음, 문 쪽으로, 분해', () => {
    const { state } = run(alice, [
      leave,
      [{ type: 'agent_departed', agentId: 'agent-alice', visitId: 'v2', toRoomId: 'room-bob' }, agentActor],
    ]);
    expect(state).toMatchObject({
      mode: 'traveling',
      location: null,
      target: { kind: 'door', id: null },
      cue: { kind: 'dissolve', seq: 2 },
    });
  });

  it('agent_arrived: visiting, 호스트 캡슐 안 문 앞에서 재조립', () => {
    const { state } = run(alice, [
      leave,
      [{ type: 'agent_departed', agentId: 'agent-alice', visitId: 'v2', toRoomId: 'room-bob' }, agentActor],
      [{ type: 'agent_arrived', agentId: 'agent-alice', visitId: 'v2', fromRoomId: 'room-alice' }, { ...agentActor, actorId: 'agent-alice' }],
    ]);
    // 도착 이벤트는 호스트 Room 로그에 있으므로 makeLog의 roomId('room-alice')가 아니라 e.roomId를 위치로 쓴다
    expect(state).toMatchObject({ mode: 'visiting', location: 'room-alice', target: { kind: 'door', id: null }, cue: { kind: 'reassemble' } });
  });

  it('호스트 Room 로그에서 도착하면 위치가 그 Room이 된다', () => {
    const host = makeLog('room-bob');
    let s = initialAgentState(alice);
    s = reduceAgentState(alice, s, host.push({ type: 'agent_arrived', agentId: 'agent-alice', visitId: 'v2', fromRoomId: 'room-alice' }, agentActor));
    expect(s).toMatchObject({ mode: 'visiting', location: 'room-bob' });
  });

  it('visit_takeout: 방문 중 작은 카드를 품에 안음', () => {
    const { state } = run(alice, [
      [{ type: 'agent_arrived', agentId: 'agent-alice', visitId: 'v2', fromRoomId: 'room-x' }, agentActor],
      [{ type: 'visit_takeout', visitId: 'v2', text: '토요일' }, agentActor],
    ]);
    expect(state.cue).toEqual({ kind: 'hold_card', seq: 2 });
  });

  it('agent_returned: 인계 대기, 카드 묶음을 내밂, 소유자가 자리를 비웠으면 representing으로 복귀', () => {
    const { state } = run(alice, [
      leave,
      [{ type: 'agent_departed', agentId: 'agent-alice', visitId: 'v2', toRoomId: 'room-bob' }, agentActor],
      [{ type: 'agent_arrived', agentId: 'agent-alice', visitId: 'v2', fromRoomId: 'room-alice' }, agentActor],
      [{ type: 'agent_returned', agentId: 'agent-alice', visitId: 'v2' }, agentActor],
    ]);
    expect(state).toMatchObject({
      mode: 'representing',
      handoverPending: true,
      location: 'room-alice',
      cue: { kind: 'present_cards', seq: 4 },
    });
  });

  it('visit_ended: 호스트 로그에서 방문 중이던 Agent는 떠나는 중(traveling)이 된다', () => {
    const { state } = run(alice, [
      [{ type: 'agent_arrived', agentId: 'agent-alice', visitId: 'v2', fromRoomId: 'room-x' }, agentActor],
      [{ type: 'visit_ended', visitId: 'v2', reason: 'host_ended' } as EventPayload],
    ]);
    expect(state).toMatchObject({ mode: 'traveling', location: null, cue: { kind: 'dissolve', seq: 2 } });
  });

  it('agent_returned: 소유자가 있으면 accompanied로 복귀', () => {
    const { state } = run(alice, [
      [{ type: 'agent_departed', agentId: 'agent-alice', visitId: 'v2', toRoomId: 'room-bob' }, agentActor],
      [{ type: 'agent_returned', agentId: 'agent-alice', visitId: 'v2' }, agentActor],
    ]);
    expect(state).toMatchObject({ mode: 'accompanied', handoverPending: true });
  });

  it('member_rejoined(missed>0): 인계 대기, accompanied, 소유자에게 흘러 들어감', () => {
    const { state } = run(alice, [leave, [{ type: 'member_rejoined', userId: 'alice', missedCount: 4 }]]);
    expect(state).toMatchObject({
      mode: 'accompanied',
      ownerAway: false,
      handoverPending: true,
      target: null,
      cue: { kind: 'flow_to_owner', seq: 2 },
    });
  });

  it('member_rejoined(missed=0): 인계 없음', () => {
    const { state } = run(alice, [leave, [{ type: 'member_rejoined', userId: 'alice', missedCount: 0 }]]);
    expect(state).toMatchObject({ mode: 'accompanied', handoverPending: false });
    expect(state.cue).toBeNull();
  });

  it('digest_viewed: 인계 해제 + 점프', () => {
    const { state } = run(alice, [
      leave,
      [{ type: 'member_rejoined', userId: 'alice', missedCount: 4 }],
      [{ type: 'digest_viewed', userId: 'alice' }],
    ]);
    expect(state).toMatchObject({ handoverPending: false, cue: { kind: 'jump', seq: 3 } });
  });

  it('digest_viewed: 인계 대기가 없으면 아무 일도 없다', () => {
    const { state } = run(alice, [[{ type: 'digest_viewed', userId: 'alice' }]]);
    expect(state.cue).toBeNull();
  });

  it('agreement_formed: 구성원 Agent와 Room Agent가 모여 점프, 구성원이 아니면 반응 없음', () => {
    const payload: EventPayload = { type: 'agreement_formed', cardId: 'c1', memberIds: ['alice', 'bob'] };
    const sys: LogOpts = { actorKind: 'system', actorId: null };
    expect(run(alice, [[payload, sys]]).state.cue).toEqual({ kind: 'agreement', seq: 1 });
    expect(run(roomAgent, [[payload, sys]]).state.cue).toEqual({ kind: 'agreement', seq: 1 });
    const mom: AgentRef = { agentId: 'agent-mom', ownerUserId: 'mom', homeRoomId: 'room-alice' };
    expect(run(mom, [[payload, sys]]).state.cue).toBeNull();
  });

  it('방문 중인 Agent는 agreement 연출에서 빠진다', () => {
    const { state } = run(alice, [
      [{ type: 'agent_arrived', agentId: 'agent-alice', visitId: 'v2', fromRoomId: 'x' }, agentActor],
      [{ type: 'agreement_formed', cardId: 'c1', memberIds: ['alice'] }, { actorKind: 'system', actorId: null }],
    ]);
    expect(state.cue?.kind).toBe('reassemble');
  });

  it('buildAgentState(upToSeq)는 과거 상태를 재구성한다 (타임라인 재생)', () => {
    const { events } = run(alice, [
      [turnStart, agentActor],
      [{ type: 'agent_step', agentId: 'agent-alice', turnId: 't1', kind: 'drafting' }, agentActor],
      [{ type: 'agent_turn_ended', agentId: 'agent-alice', turnId: 't1', result: 'acted' }, agentActor],
    ]);
    expect(buildAgentState(alice, events, 1).activity).toBe('thinking');
    expect(buildAgentState(alice, events, 2).activity).toBe('drafting');
    expect(buildAgentState(alice, events).activity).toBe('idle');
    expect(buildAgentState(alice, events, 0)).toEqual(initialAgentState(alice));
  });

  it('buildAgentStates는 Agent별로 독립이다', () => {
    const { events } = run(alice, [[turnStart, agentActor]]);
    const states = buildAgentStates([alice, roomAgent], events as RoomEvent[]);
    expect(states['agent-alice']!.activity).toBe('thinking');
    expect(states['ra-friends']!.activity).toBe('idle');
  });

  it('리듀서는 입력 상태를 변경하지 않는다', () => {
    const { events } = makeLog();
    const e = { ...turnStart, roomId: 'r', seq: 1, ts: 0, actorKind: 'agent', actorId: 'agent-alice', visibility: 'room', turnId: 't1' } as RoomEvent;
    const before = initialAgentState(alice);
    const frozen = Object.freeze({ ...before });
    reduceAgentState(alice, frozen, e);
    expect(frozen).toEqual(before);
    expect(events).toHaveLength(0);
  });
});

describe('board_tool_created cue', () => {
  const created: EventPayload = {
    type: 'board_tool_created',
    toolId: 't_1',
    title: '사다리',
    ownerTag: 'ours',
    init: { kind: 'ladder', participants: ['A', 'B'], outcomes: ['x', '꽝'] },
  };
  it('이 Agent가 올리면 hold_card + card 타깃, 다른 행위자면 변화 없음', () => {
    const mine = run(alice, [[created, { actorKind: 'agent', actorId: 'agent-alice' }]]).state;
    expect(mine.cue).toEqual({ kind: 'hold_card', seq: 1 });
    expect(mine.target).toEqual({ kind: 'card', id: 't_1' });
    const other = run(alice, [[created, { actorKind: 'human', actorId: 'bob' }]]).state;
    expect(other.cue).toBeNull();
    const ra = run(roomAgent, [[created, { actorKind: 'room_agent', actorId: 'ra-friends' }]]).state;
    expect(ra.cue).toEqual({ kind: 'hold_card', seq: 1 });
  });
});
