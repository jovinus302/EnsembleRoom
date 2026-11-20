import { describe, expect, it } from 'vitest';
import type { RoomEvent, WorldRoom } from '@ensemble/shared';
import { deriveFocusCharacters, deriveLightCharacters } from './derive';
import { buildRoomState } from '@ensemble/shared';
import type { RoomModel } from '../../room/useRoomModel';

const users = {
  a: { id: 'a', name: 'Alice', color: '#f00' },
  b: { id: 'b', name: 'Bob', color: '#00f' },
  c: { id: 'c', name: 'Cara', color: '#0f0' },
};

const our = (detail: WorldRoom['preview']['detail'], glass: 'clear' | 'frosted' = 'clear'): WorldRoom =>
  ({ id: 'our1', kind: 'our', ownerId: null, title: 'T', theme: 'cafe', themeVariant: 'meeting', memberIds: ['a', 'b', 'c'], preview: { roomId: 'our1', ambience: 'occupied', glass, detail } }) as WorldRoom;
const detail = (over: Record<string, unknown> = {}) => ({ unread: 0, missedChanges: 0, agents: [], pendingApprovals: 0, presentUserIds: ['a'], ...over }) as WorldRoom['preview']['detail'];

describe('deriveLightCharacters: 자리 비움', () => {
  it('접속 안 한 구성원은 away로, 접속 중은 h:로 그린다', () => {
    const out = deriveLightCharacters([our(detail())], users, 'a', null, null, {});
    const humans = out.filter((c) => c.kind === 'human');
    expect(humans.find((c) => c.id === 'h:a')?.away).toBeFalsy();
    expect(humans.filter((c) => c.away).map((c) => c.id).sort()).toEqual(['ha:b:our1', 'ha:c:our1']);
  });
  it('내가 명시적으로 Leave했으면 나는 그리지 않는다', () => {
    const out = deriveLightCharacters([our(detail({ presentUserIds: ['b'], myLeave: 'plain' }))], users, 'a', null, null, {});
    expect(out.some((c) => c.id.includes(':a:') || c.id === 'h:a')).toBe(false);
    expect(out.some((c) => c.id === 'ha:c:our1')).toBe(true);
  });
  it('대리 중인 구성원(representing 칩)은 그리지 않는다', () => {
    const d = detail({ agents: [{ agentId: 'ag_c', name: 'Cara의 Agent', activity: 'idle', mode: 'representing', location: 'our1' }] });
    const out = deriveLightCharacters([our(d)], users, 'a', null, null, {});
    expect(out.some((c) => c.id === 'ha:c:our1')).toBe(false);
    expect(out.some((c) => c.id === 'ha:b:our1')).toBe(true);
  });
  it('detail이 없는 방(서리 유리)에는 새 정보를 더하지 않는다', () => {
    const out = deriveLightCharacters([our(null, 'frosted')], users, 'a', null, null, {});
    expect(out.filter((c) => c.kind === 'human')).toEqual([]);
  });
  it('presentUserIds를 모르면(구 서버) 자리 비움을 만들지 않는다', () => {
    const out = deriveLightCharacters([our(detail({ presentUserIds: undefined }))], users, 'a', null, null, {});
    expect(out.filter((c) => c.away)).toEqual([]);
  });
  it('방당 사람 상한을 넘기지 않는다', () => {
    const r = { ...our(detail({ presentUserIds: [] })), memberIds: Array.from({ length: 22 }, (_, i) => `m${i}`) } as WorldRoom;
    const out = deriveLightCharacters([r], users, 'a', null, null, {});
    expect(out.filter((c) => c.kind === 'human').length).toBe(6);
  });
});

describe('deriveFocusCharacters: 자리 비움', () => {
  const ev = (seq: number, type: string, extra: Record<string, unknown>) => ({ seq, ts: seq, roomId: 'our1', type, actorKind: 'system', actorId: null, visibility: 'room', turnId: null, ...extra }) as unknown as RoomEvent;
  const events = [
    ev(1, 'member_entered', { userId: 'a', role: 'owner' }),
    ev(2, 'member_entered', { userId: 'b', role: 'member' }),
    ev(3, 'member_entered', { userId: 'c', role: 'member' }),
    ev(4, 'member_left', { userId: 'b', implicit: true }),
    ev(5, 'member_left', { userId: 'c', implicit: false }),
  ];
  const model = { roomId: 'our1', room: our(null), meId: 'a', users, events, allEvents: events, state: buildRoomState('our1', events), agents: [], replaying: false } as unknown as RoomModel;
  it('암묵 퇴장은 자리 비움, 명시적 Leave는 그리지 않는다', () => {
    const out = deriveFocusCharacters(model, {});
    expect(out.map((c) => c.id).sort()).toEqual(['h:a', 'ha:b:our1']);
  });
});

describe('deriveFocusCharacters: 자리 비움 사람과 상호작용', () => {
  const now = Date.now();
  const ev = (seq: number, type: string, extra: Record<string, unknown>, base: Record<string, unknown> = {}) =>
    ({ seq, ts: now - 500, roomId: 'our1', type, actorKind: 'system', actorId: null, visibility: 'room', turnId: null, ...base, ...extra }) as unknown as RoomEvent;
  const AG = { actorKind: 'agent', actorId: 'ag_c' };
  const RA = { actorKind: 'room_agent', actorId: 'ra1' };
  const baseEvents = [
    ev(1, 'member_entered', { userId: 'a', role: 'owner' }),
    ev(2, 'member_entered', { userId: 'b', role: 'member' }),
    ev(3, 'member_entered', { userId: 'c', role: 'member' }),
    ev(4, 'member_left', { userId: 'b', implicit: true }),
  ];
  const st = (target: unknown) => ({ mode: 'accompanied', location: 'our1', activity: 'talking', recalling: false, handoverPending: false, cue: null, target });
  const row = (agentId: string, kind: 'agent' | 'room_agent', ownerId: string | null, target: unknown = null) => ({ agentId, kind, name: agentId, color: '#888', variant: null, ownerId, visiting: false, state: st(target) });
  const make = (events: RoomEvent[], agents: unknown[], replaying = false) =>
    ({ roomId: 'our1', room: our(null), meId: 'a', users, events, allEvents: events, state: buildRoomState('our1', events), agents, replaying }) as unknown as RoomModel;

  it('자리 비움 사람을 향한 target은 ha: id로 해석한다', () => {
    const out = deriveFocusCharacters(make(baseEvents, [row('ag_b', 'agent', 'b', { kind: 'owner_seat', id: 'b' })]), {});
    expect(out.find((c) => c.id === 'ag_b')?.targetCharId).toBe('ha:b:our1');
  });
  it('접속 중인 사람을 향한 target은 h: id, 없는 사람은 null', () => {
    const out = deriveFocusCharacters(make(baseEvents, [row('ag_x', 'agent', 'a', { kind: 'user', id: 'a' }), row('ag_y', 'agent', null, { kind: 'user', id: 'zzz' })]), {});
    expect(out.find((c) => c.id === 'ag_x')?.targetCharId).toBe('h:a');
    expect(out.find((c) => c.id === 'ag_y')?.targetCharId).toBeNull();
  });
  it('A2A ask: 질문자 캐릭터에 수신자로 향하는 보라 링크, 열려 있는 동안 pending', () => {
    const events = [
      ...baseEvents,
      ev(5, 'agent_turn_started', { agentId: 'ra1', trigger: { seq: 4, reason: 'room_agent_call' } }, { ...RA, turnId: 't1' }),
      ev(6, 'message', { text: '묻는다', recipients: ['ag_c'] }, { ...RA, turnId: 't1' }),
    ];
    const out = deriveFocusCharacters(make(events, [row('ra1', 'room_agent', null), row('ag_c', 'agent', 'c')]), {});
    const ra = out.find((c) => c.id === 'ra1')!;
    expect(ra.links).toEqual([expect.objectContaining({ toCharId: 'ag_c', channel: 'a2a', pending: true })]);
  });
  it('A2H 승인: Agent에서 자리 비움 승인자(ha:)로 링크, 승인자 사람에 alert, 해소되면 사라진다', () => {
    const req = ev(5, 'approval_requested', { approvalId: 'ap1', approvers: ['b', 'a'], kind: 'decision', summary: '?' }, { ...AG, turnId: 't1' });
    const agents = [row('ag_c', 'agent', 'c')];
    const out = deriveFocusCharacters(make([...baseEvents, req], agents), {});
    const ag = out.find((c) => c.id === 'ag_c')!;
    expect(ag.links?.map((l) => l.toCharId).sort()).toEqual(['h:a', 'ha:b:our1']);
    expect(ag.links?.every((l) => l.channel === 'a2h' && l.pending)).toBe(true);
    expect(out.find((c) => c.id === 'ha:b:our1')?.alert).toBe('approval');
    expect(out.find((c) => c.id === 'h:a')?.alert).toBe('approval');
    const res = ev(6, 'approval_resolved', { approvalId: 'ap1', outcome: 'approved' });
    const after = deriveFocusCharacters(make([...baseEvents, req, res], agents), {});
    expect(after.find((c) => c.id === 'ag_c')?.links).toBeUndefined();
    expect(after.some((c) => c.alert)).toBe(false);
  });
  it('A2A answer는 reverse 링크, 시간이 지난 일반 링크는 만들지 않는다(재생 중 제외)', () => {
    const events = [
      ...baseEvents,
      ev(5, 'agent_turn_started', { agentId: 'ra1', trigger: { seq: 4, reason: 'room_agent_call' } }, { ...RA, turnId: 't1' }),
      ev(6, 'message', { text: 'q', recipients: ['ag_c'] }, { ...RA, turnId: 't1' }),
      ev(7, 'message', { text: 'a', to: 'ra1', replyTo: 6 }, { ...AG, turnId: 't2' }),
    ];
    const agents = [row('ra1', 'room_agent', null), row('ag_c', 'agent', 'c')];
    const fresh = deriveFocusCharacters(make(events, agents), {});
    // 링크 방향은 항상 질문자 -> 수신자, 답은 reverse(펄스가 수신자 -> 질문자로 흐른다)
    expect(fresh.find((c) => c.id === 'ra1')?.links).toContainEqual(expect.objectContaining({ toCharId: 'ag_c', channel: 'a2a', reverse: true }));
    const old = events.map((e) => ({ ...e, ts: now - 60_000 }) as RoomEvent);
    expect(deriveFocusCharacters(make(old, agents), {}).some((c) => c.links)).toBe(false);
  });
  it('양 끝 중 한쪽이 이 방에 없으면 링크를 만들지 않는다', () => {
    const req = ev(5, 'approval_requested', { approvalId: 'ap1', approvers: ['zzz'], kind: 'decision', summary: '?' }, { ...AG, turnId: 't1' });
    const out = deriveFocusCharacters(make([...baseEvents, req], [row('ag_c', 'agent', 'c')]), {});
    expect(out.find((c) => c.id === 'ag_c')?.links).toBeUndefined();
  });
});

describe('light 캡슐(frost 방 포함)에는 연결선이 없다', () => {
  it('deriveLightCharacters는 links·alert를 만들지 않는다', () => {
    const d = detail({ pendingApprovals: 1, agents: [{ agentId: 'ag_c', name: 'Cara의 Agent', activity: 'awaiting', mode: 'accompanied', location: 'our1' }] });
    const out = deriveLightCharacters([our(d), our(null, 'frosted')], users, 'a', null, null, {});
    expect(out.some((c) => c.links || c.alert)).toBe(false);
  });
});

describe('조망 interaction 연결선 (S8)', () => {
  const ia = { channel: 'a2a' as const, fromId: 'ra1', toIds: ['ag_b'], seq: 7, at: 1000, pending: true };
  const agentsOf = (...ids: string[]) => ids.map((agentId) => ({ agentId, name: agentId === 'ra1' ? 'Room Agent' : '봄의 Agent', activity: 'idle' as const, mode: 'accompanied' as const, location: 'our1' }));
  const withIx = (interaction: typeof ia | null) => our(detail({ agents: agentsOf('ra1', 'ag_b'), interaction }));
  const linksOf = (out: ReturnType<typeof deriveLightCharacters>) => out.flatMap((c) => c.links ?? []);

  it('구성원 방(detail 있음)의 pending 상호작용은 양 끝을 잇는다', () => {
    const out = deriveLightCharacters([withIx(ia)], users, 'a', null, null, {}, 5000);
    expect(linksOf(out)).toEqual([expect.objectContaining({ toCharId: 'ag_b', channel: 'a2a', pending: true })]);
    expect(out.find((c) => c.id === 'ra1')?.linked).toBe(true);
  });
  it('pending이 아니면 20초가 지난 뒤 만들지 않는다', () => {
    const old = { ...ia, pending: false };
    expect(linksOf(deriveLightCharacters([withIx(old)], users, 'a', null, null, {}, 1000 + 5000))).toHaveLength(1);
    expect(linksOf(deriveLightCharacters([withIx(old)], users, 'a', null, null, {}, 1000 + 21000))).toHaveLength(0);
  });
  it('서리 방(detail 없음)·포커스 방·interaction 없음에서는 아무 링크도 없다', () => {
    expect(linksOf(deriveLightCharacters([our(null, 'frosted')], users, 'a', null, null, {}, 5000))).toHaveLength(0);
    expect(linksOf(deriveLightCharacters([withIx(ia)], users, 'a', null, 'our1', {}, 5000))).toHaveLength(0);
    expect(linksOf(deriveLightCharacters([withIx(null)], users, 'a', null, null, {}, 5000))).toHaveLength(0);
  });
});
