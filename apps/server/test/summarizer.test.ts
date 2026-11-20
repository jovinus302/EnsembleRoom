import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DigestResponse } from '@ensemble/shared';
import type { FastifyInstance } from 'fastify';
import type { AgentProvider, ProviderEvent, ToolCall, TurnInput } from '../src/agent/types';
import type { Config } from '../src/config';
import type { AppContext } from '../src/context';
import { dispatch } from '../src/domain/actions';
import { acceptVisit, sendAgentVisit } from '../src/domain/visits';
import { ClaudeSummaryProvider, MockSummaryProvider, createSummaryProvider, type SummaryClient } from '../src/memory/summarizer';
import { SEED, auth, loginAs, makeApp } from './helpers';

const { alice, bob } = SEED.users;
const A = SEED.agents;
const R = SEED.rooms;

let ctx: AppContext;
let app: FastifyInstance;
let tk: Record<string, string>;

const setup = async (config: Partial<Config> = {}) => {
  ({ ctx, app } = await makeApp(config));
  tk = { Alice: await loginAs(app, 'Alice'), Bob: await loginAs(app, 'Bob') };
};
afterEach(() => ctx?.agents.stop());

const human = (userId: string) => ({ kind: 'human' as const, userId });
const say = (userId: string, roomId: string, text: string, to?: string) =>
  dispatch(ctx, human(userId), { type: 'send_message', roomId, text, to });
const types = (roomId: string, ...t: string[]) => ctx.store.listAll(roomId).filter((e) => t.includes(e.type));
const digest = async (name: string, roomId: string) => app.inject({ method: 'GET', url: `/api/rooms/${roomId}/digest`, headers: auth(tk[name]!) });

function scripted(fn: (input: TurnInput) => ToolCall): AgentProvider {
  return {
    name: 'scripted',
    async *stream(input): AsyncGenerator<ProviderEvent> {
      yield { type: 'tool_call', call: fn(input) };
    },
  };
}

describe('요약기: Room 요약 갱신', () => {
  beforeEach(() => setup({ summaryEveryEvents: 3 }));

  it('변화 이벤트가 N개 쌓이면 room_summaries가 갱신되고 다음 턴 프롬프트에 들어간다 (private 내용은 제외)', async () => {
    ctx.agents.start();
    expect(ctx.repo.getRoomSummary(R.friends)).toBeUndefined();
    // 한 사람에게만 보이는 이벤트는 요약 대상이 아니다
    ctx.store.append({
      roomId: R.friends,
      actorKind: 'agent',
      actorId: A.bob,
      visibility: `private:${bob}`,
      type: 'agent_owner_note',
      agentId: A.bob,
      note: 'SECRET-NOTE',
    });
    say(alice, R.friends, '이번 주말에 뭐 할까');
    say(bob, R.friends, '보드게임 어때');
    expect(ctx.repo.getRoomSummary(R.friends)).toBeUndefined(); // 2개 < 3
    say(alice, R.friends, '좋아, 토요일로 하자');
    await ctx.agents.drain();

    const sum = ctx.repo.getRoomSummary(R.friends)!;
    expect(sum.uptoSeq).toBeGreaterThanOrEqual(4);
    expect(sum.text).toContain('친구들 요약');
    expect(sum.text).toContain('대화 3건');
    expect(sum.text).not.toContain('SECRET-NOTE');

    // 프롬프트: 방문 중이 아닌 Agent의 TurnInput.roomSummary로 들어간다
    let seen: string | null | undefined;
    ctx.agents.setProvider(scripted((input) => ((seen = input.roomSummary), { name: 'pass', input: { reason: 'nothing_to_add' } })));
    say(alice, R.myAlice, '안녕', A.alice); // 내 Room: 아직 요약 없음
    await ctx.agents.drain();
    expect(seen).toBeNull();
    say(alice, R.friends, '정리해 줄래?');
    await ctx.agents.drain();
    expect(seen).toContain('친구들 요약');
  });

  it('Rejoin 시점에는 임계값 미만이어도 요약을 갱신한다', async () => {
    ctx.agents.start();
    dispatch(ctx, human(alice), { type: 'enter_room', roomId: R.friends });
    dispatch(ctx, human(alice), { type: 'leave_room', roomId: R.friends });
    say(bob, R.friends, '나 먼저 시작했어');
    expect(ctx.repo.getRoomSummary(R.friends)).toBeUndefined();
    dispatch(ctx, human(alice), { type: 'rejoin_room', roomId: R.friends });
    await ctx.agents.drain();
    expect(ctx.repo.getRoomSummary(R.friends)?.text).toContain('대화 1건');
  });

  it('mock 요약은 결정적이다', async () => {
    const p = new MockSummaryProvider();
    const req = { kind: 'room' as const, title: 'T', previous: null, lines: ['#1 A: 안녕', '#2 B가 카드 만듦 [c] "x": y'] };
    expect(await p.summarize(req)).toBe(await p.summarize(req));
    expect(createSummaryProvider({ agentMode: 'mock' }).name).toBe('mock');
  });

  it('claude 요약은 경량 모델로, 이벤트 줄만 담아 호출한다', async () => {
    const calls: Record<string, unknown>[] = [];
    const client: SummaryClient = {
      messages: {
        async create(params) {
          calls.push(params);
          return { content: [{ type: 'text', text: '  요약 결과  ' }] };
        },
      },
    };
    const p = new ClaudeSummaryProvider({ client, lightModel: 'light-model-x' });
    expect(await p.summarize({ kind: 'room', title: '친구들', previous: '이전 요약', lines: ['#1 A: 안녕'] })).toBe('요약 결과');
    expect(calls[0]).toMatchObject({ model: 'light-model-x' });
    expect(JSON.stringify(calls[0])).toContain('#1 A: 안녕');
    // 빈 응답은 실패로 본다(요약을 덮어쓰지 않는다)
    const empty = new ClaudeSummaryProvider({ client: { messages: { create: async () => ({ content: [] }) } }, lightModel: 'm' });
    await expect(empty.summarize({ kind: 'digest', title: 't', previous: null, lines: [] })).rejects.toThrow();
  });
});

describe('Rejoin 다이제스트', () => {
  beforeEach(() => setup());

  it('left_at_seq 이후 변화 요약 + 보드 변화 + 대기 승인, 남의 private 이벤트는 제외', async () => {
    // 자리를 비운 적이 없으면 비어 있다
    const idle = (await digest('Alice', R.friends)).json() as DigestResponse;
    expect(idle).toMatchObject({ leftAtSeq: null, missedCount: 0, summary: null, boardChanges: [] });

    dispatch(ctx, human(alice), { type: 'enter_room', roomId: R.friends });
    dispatch(ctx, human(alice), { type: 'leave_room', roomId: R.friends });
    const leftAt = ctx.repo.getCursor(alice, R.friends).leftAtSeq!;
    expect(leftAt).toBeGreaterThan(0);

    say(bob, R.friends, '금요일 저녁 어때?');
    const cardId = dispatch(ctx, human(bob), { type: 'create_card', roomId: R.friends, title: '금요일 저녁', body: '7시' }).data.cardId as string;
    ctx.store.append({
      roomId: R.friends,
      actorKind: 'agent',
      actorId: A.bob,
      visibility: `private:${bob}`,
      type: 'agent_owner_note',
      agentId: A.bob,
      note: 'BOB-ONLY-NOTE',
    });
    // Alice가 승인해야 하는 요청 (Room Agent의 decision)
    dispatch(ctx, { kind: 'room_agent', roomAgentId: SEED.roomAgents.friends }, {
      type: 'request_approval',
      roomId: R.friends,
      question: '저녁 메뉴는?',
      options: ['한식', '양식'],
    });

    const res = await digest('Alice', R.friends);
    expect(res.statusCode).toBe(200);
    const d = res.json() as DigestResponse;
    expect(d.leftAtSeq).toBe(leftAt);
    expect(d.missedCount).toBe(3); // 메시지, 카드, 승인 요청 (private 메모는 Alice에게 안 보인다)
    expect(d.summary).toContain('대화 1건');
    expect(d.summary).not.toContain('BOB-ONLY-NOTE');
    expect(JSON.stringify(d)).not.toContain('BOB-ONLY-NOTE');
    expect(d.boardChanges).toEqual([{ cardId, title: '금요일 저녁', change: 'created' }]);
    expect(d.pendingApprovals).toHaveLength(1);
    expect(d.pendingApprovals[0]).toMatchObject({ kind: 'decision', summary: '저녁 메뉴는?', options: ['한식', '양식'] });

    // 아무 변화도 없는 사람에게는 "달라진 점 없음"
    dispatch(ctx, human(bob), { type: 'enter_room', roomId: R.friends });
    dispatch(ctx, human(bob), { type: 'leave_room', roomId: R.friends });
    const d2 = (await digest('Bob', R.friends)).json() as DigestResponse;
    expect(d2.missedCount).toBe(0);
    expect(d2.summary).toContain('달라진 점이 없어요');
  });

  it('본인에게만 보이는 이벤트는 본인 다이제스트에만 들어간다 (소유자 메모)', async () => {
    dispatch(ctx, human(bob), { type: 'enter_room', roomId: R.friends });
    dispatch(ctx, human(bob), { type: 'leave_room', roomId: R.friends });
    ctx.store.append({
      roomId: R.friends,
      actorKind: 'agent',
      actorId: A.bob,
      visibility: `private:${bob}`,
      type: 'agent_owner_note',
      agentId: A.bob,
      note: 'BOB-ONLY-NOTE',
    });
    const d = (await digest('Bob', R.friends)).json() as DigestResponse;
    expect(d.missedCount).toBe(1);
    expect(d.summary).toBeTruthy();
  });

  it('접근할 수 없는 Room은 403', async () => {
    expect((await digest('Bob', R.myAlice)).statusCode).toBe(403);
  });
});

describe('owner_note 저장', () => {
  beforeEach(() => setup());

  it('동행 중 Agent의 owner_note는 같은 Room에 private:소유자로 저장된다', async () => {
    ctx.agents.setProvider(
      scripted(() => ({ name: 'say', input: { text: '네, 확인했어요.', owner_note: '소유자만 볼 메모: 예산 주의' } })),
    );
    ctx.agents.start();
    say(alice, R.myAlice, '안녕', A.alice);
    await ctx.agents.drain();
    const notes = types(R.myAlice, 'agent_owner_note');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ visibility: `private:${alice}`, note: '소유자만 볼 메모: 예산 주의', actorKind: 'agent', actorId: A.alice });
    expect(notes[0]!.turnId).toBeTruthy();
    expect(ctx.store.listVisible(alice, R.myAlice).some((e) => e.type === 'agent_owner_note')).toBe(true);
    expect(ctx.store.listVisible(bob, R.myAlice).some((e) => e.type === 'agent_owner_note')).toBe(false);
  });

  it('방문 중 Agent의 owner_note는 소유자가 볼 수 있는 출발 Room에 둔다(호스트 Room에는 없다)', async () => {
    ctx.agents.setProvider(
      scripted(() => ({ name: 'say', input: { text: '안녕하세요', owner_note: 'Bob은 친절하다' } })),
    );
    ctx.agents.start();
    const mandate = { text: '인사만', allowedActions: ['chat' as const] };
    const { visitId } = sendAgentVisit(ctx, alice, R.myBob, mandate);
    acceptVisit(ctx, bob, visitId, ['chat']);
    await ctx.agents.drain();
    expect(types(R.myBob, 'agent_owner_note')).toHaveLength(0);
    const notes = types(R.myAlice, 'agent_owner_note');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ visibility: `private:${alice}`, note: 'Bob은 친절하다' });
  });

  it('도구가 실패하면 메모도 남지 않는다', async () => {
    ctx.agents.setProvider(scripted(() => ({ name: 'say', input: { text: '', owner_note: '남으면 안 됨' } })));
    ctx.agents.start();
    say(alice, R.myAlice, '안녕', A.alice);
    await ctx.agents.drain();
    expect(types(R.myAlice, 'agent_owner_note')).toHaveLength(0);
  });
});

describe('AbortSignal', () => {
  beforeEach(() => setup());

  it('서버 종료(stop)가 진행 중인 턴의 provider 호출에 AbortSignal을 전달해 중단한다', async () => {
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    let sawSignal: AbortSignal | undefined;
    ctx.agents.setProvider({
      name: 'hang',
      async *stream(_input, signal): AsyncGenerator<ProviderEvent> {
        sawSignal = signal;
        started();
        await new Promise<void>((res) => signal?.addEventListener('abort', () => res()));
        yield { type: 'phase', phase: 'thinking' };
      },
    });
    ctx.agents.start();
    say(alice, R.myAlice, '안녕', A.alice);
    await ready;
    expect(sawSignal).toBeDefined();
    expect(sawSignal!.aborted).toBe(false);

    ctx.agents.stop();
    await ctx.agents.drain();
    expect(sawSignal!.aborted).toBe(true);
    const out = ctx.agents.outcomes.at(-1)!;
    expect(out).toMatchObject({ result: 'error', errorCode: 'aborted', errorStatus: 499 });
    // 턴 종료는 기록된다
    expect(types(R.myAlice, 'agent_turn_ended').at(-1)).toMatchObject({ result: 'error' });
  });

  it('Agent를 일시정지(abortAgent)하면 그 Agent의 턴만 중단된다', async () => {
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    ctx.agents.setProvider({
      name: 'hang',
      async *stream(_input, signal): AsyncGenerator<ProviderEvent> {
        started();
        await new Promise<void>((res) => signal?.addEventListener('abort', () => res()));
        yield { type: 'phase', phase: 'thinking' };
      },
    });
    ctx.agents.start();
    say(alice, R.myAlice, '안녕', A.alice);
    await ready;
    ctx.agents.scheduler.abortAgent(A.bob); // 다른 Agent: 영향 없음
    ctx.agents.scheduler.abortAgent(A.alice);
    await ctx.agents.drain();
    expect(ctx.agents.outcomes.at(-1)).toMatchObject({ errorCode: 'aborted' });
  });
});
