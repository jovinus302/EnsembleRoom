import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context';
import { dispatch } from '../src/domain/actions';
import { enterRoom, leaveRoom } from '../src/domain/presence';
import { previewFor, myAgentStatus } from '../src/domain/rooms';
import { acceptVisit, endVisit, requestHumanVisit, sendAgentVisit } from '../src/domain/visits';
import { SEED, makeCtx } from './helpers';

const { alice, bob, mom, dana } = SEED.users;
const R = SEED.rooms;
const A = SEED.agents;
const mandate = { text: '인사만', allowedActions: ['chat'] as const };

let ctx: AppContext;
beforeEach(() => {
  ctx = makeCtx();
});

const chips = (viewer: string, room: string) => previewFor(ctx, viewer, room)?.detail?.agents ?? [];
const visitingBob = (viewer: string, room: string) => chips(viewer, room).find((c) => c.agentId === A.bob);

describe('방문 Agent가 호스트 preview에 나타난다', () => {
  it('수락 후 Alice My Room preview에 ag_bob(visiting) 칩과 이동 정보, 종료 후 사라진다', () => {
    const v = sendAgentVisit(ctx, bob, R.myAlice, { ...mandate, allowedActions: ['chat'] });
    expect(visitingBob(alice, R.myAlice)).toBeUndefined(); // 요청만으로는 없다
    acceptVisit(ctx, alice, v.visitId, ['chat']);

    const chip = visitingBob(alice, R.myAlice)!;
    expect(chip).toMatchObject({ mode: 'visiting', location: R.myAlice });
    expect(chip.travel).toMatchObject({ fromRoomId: R.myBob, toRoomId: R.myAlice });
    expect(chip.travel!.seq).toBeGreaterThan(0);

    endVisit(ctx, { kind: 'human', userId: alice }, v.visitId);
    expect(visitingBob(alice, R.myAlice)).toBeUndefined();
  });

  it('Bob의 My Room 칩과 myAgent는 목적지·이동 정보를 가진다', () => {
    const v = sendAgentVisit(ctx, bob, R.myAlice, { ...mandate, allowedActions: ['chat'] });
    acceptVisit(ctx, alice, v.visitId, ['chat']);
    const own = visitingBob(bob, R.myBob)!;
    expect(own).toMatchObject({ mode: 'visiting', location: R.myAlice });
    expect(own.travel).toMatchObject({ fromRoomId: R.myBob, toRoomId: R.myAlice });
    expect(myAgentStatus(ctx, bob)).toMatchObject({
      mode: 'visiting',
      location: R.myAlice,
      travel: { fromRoomId: R.myBob, toRoomId: R.myAlice },
    });
  });
});

describe('가시성: 방문 Agent 정보는 당사자에게만', () => {
  it('제3자(Dana, 엄마)에게는 Alice 방의 detail도, 목적지도 새지 않는다', () => {
    const v = sendAgentVisit(ctx, bob, R.myAlice, { ...mandate, allowedActions: ['chat'] });
    acceptVisit(ctx, alice, v.visitId, ['chat']);
    for (const viewer of [dana, mom]) {
      const p = previewFor(ctx, viewer, R.myAlice)!;
      expect(p.detail).toBeNull();
      expect(p.glass).toBe('frosted');
      expect(JSON.stringify(previewFor(ctx, viewer, R.myBob))).not.toContain(R.myAlice);
    }
    // 같은 Our(team)에 있는 Dana: 칩은 보이되 목적지·이동은 가려진다
    const teamChip = chips(dana, R.team).find((c) => c.agentId === A.bob)!;
    expect(teamChip.mode).toBe('visiting');
    expect(teamChip.location ?? null).toBeNull();
    expect(teamChip.travel ?? null).toBeNull();
    expect(JSON.stringify(previewFor(ctx, dana, R.team))).not.toContain(R.myAlice);
    // 당사자는 Our 칩에서도 목적지를 안다
    expect(chips(alice, R.team).find((c) => c.agentId === A.bob)).toMatchObject({ location: R.myAlice });
    expect(chips(bob, R.team).find((c) => c.agentId === A.bob)).toMatchObject({ location: R.myAlice });
  });

  it('수락 없는 사람 방문자는 서리·detail 없음. Agent 방문 소유자는 agent 시야지만 detail은 받지 않는다', () => {
    const v = sendAgentVisit(ctx, bob, R.myAlice, { ...mandate, allowedActions: ['chat'] });
    expect(previewFor(ctx, bob, R.myAlice)).toMatchObject({ glass: 'frosted', detail: null }); // 요청 중
    acceptVisit(ctx, alice, v.visitId, ['chat']);
    expect(previewFor(ctx, bob, R.myAlice)).toMatchObject({ glass: 'agent', detail: null });
    // 호스트는 원래 투명
    expect(previewFor(ctx, alice, R.myAlice)!.glass).toBe('clear');
    // 종료되면 다시 서리
    endVisit(ctx, { kind: 'human', userId: alice }, v.visitId);
    expect(previewFor(ctx, bob, R.myAlice)).toMatchObject({ glass: 'frosted', detail: null });
    requestHumanVisit(ctx, dana, R.myAlice);
    expect(previewFor(ctx, dana, R.myAlice)).toMatchObject({ glass: 'frosted', detail: null });
  });

  it('사람 방문과 Agent 방문이 겹치면 사람 방문 clear가 이기고, 제3자에게는 계속 서리', () => {
    const a = sendAgentVisit(ctx, bob, R.myAlice, { ...mandate, allowedActions: ['chat'] });
    acceptVisit(ctx, alice, a.visitId, ['chat']);
    const { visitId } = requestHumanVisit(ctx, bob, R.myAlice);
    acceptVisit(ctx, alice, visitId, ['chat']);
    expect(previewFor(ctx, bob, R.myAlice)).toMatchObject({ glass: 'clear', detail: null });
    expect(previewFor(ctx, dana, R.myAlice)!.glass).toBe('frosted');
  });

  it('수락된 사람 방문자: 유리는 투명이지만 detail(칩·점유자)은 여전히 없다', () => {
    const { visitId } = requestHumanVisit(ctx, bob, R.myAlice);
    acceptVisit(ctx, alice, visitId, ['chat']);
    expect(previewFor(ctx, bob, R.myAlice)).toMatchObject({ glass: 'clear', detail: null });
  });
});

describe('presentUserIds', () => {
  it('현재 있는 사람만, 명시적 Leave는 제외', () => {
    expect(previewFor(ctx, alice, R.friends)!.detail!.presentUserIds).toEqual([]);
    enterRoom(ctx, alice, R.friends);
    enterRoom(ctx, bob, R.friends);
    expect(previewFor(ctx, alice, R.friends)!.detail!.presentUserIds).toEqual([alice, bob]);
    leaveRoom(ctx, bob, R.friends);
    expect(previewFor(ctx, alice, R.friends)!.detail!.presentUserIds).toEqual([alice]);
  });

  it('수락된 사람 방문자는 호스트 preview 점유자에 들어가고, 남의 방 detail에는 목록이 없다', () => {
    const { visitId } = requestHumanVisit(ctx, bob, R.myAlice);
    acceptVisit(ctx, alice, visitId, ['chat']);
    expect(previewFor(ctx, alice, R.myAlice)!.detail!.presentUserIds).toEqual([bob]);
    expect(previewFor(ctx, dana, R.myAlice)!.detail).toBeNull();
  });
});

describe('S8: 조망 interaction은 구성원에게만', () => {
  afterEach(() => ctx.agents.stop());
  const run = async () => {
    ctx.agents.start();
    dispatch(ctx, { kind: 'human', userId: alice }, { type: 'enter_room', roomId: R.family });
    dispatch(ctx, { kind: 'human', userId: alice }, { type: 'send_message', roomId: R.family, text: '토요일 점심 12시 반 어때? 메뉴도 정하자' });
    await ctx.agents.drain();
  };

  it('구성원(Alice)에게는 미해소 승인이 pending A2H로 오고, 내용 텍스트는 없다', async () => {
    await run();
    const it = previewFor(ctx, alice, R.family)!.detail!.interaction!;
    expect(it).toMatchObject({ channel: 'a2h', pending: true });
    expect(Object.keys(it).sort()).toEqual(['at', 'channel', 'fromId', 'pending', 'seq', 'toIds']);
    expect(it.toIds).toContain(alice);
  });

  it('비구성원(Dana)의 preview에는 detail 자체가 없고, 어떤 흔적도 새지 않는다', async () => {
    await run();
    const p = previewFor(ctx, dana, R.family);
    expect(p?.detail ?? null).toBeNull();
    expect(JSON.stringify(p)).not.toMatch(/interaction|a2a|a2h/);
  });

  it('상호작용이 없으면 interaction은 null이다', () => {
    expect(previewFor(ctx, alice, R.family)!.detail!.interaction ?? null).toBeNull();
  });
});
