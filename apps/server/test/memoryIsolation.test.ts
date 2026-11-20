import { beforeEach, describe, expect, it } from 'vitest';
import type { MemoryListResponse } from '@ensemble/shared';
import { MockProvider } from '../src/agent/mock';
import type { AgentProvider, TurnInput } from '../src/agent/types';
import { dispatch } from '../src/domain/actions';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/context';
import { validateUsedMemoryIds } from '../src/memory/gateway';
import { SEED, auth, loginAs, makeApp } from './helpers';

const { alice, bob } = SEED.users;
const R = SEED.rooms;
const A = SEED.agents;

let ctx: AppContext;
let app: FastifyInstance;
let tk: Record<string, string>;

const post = (name: string, url: string, payload: object = {}) =>
  app.inject({ method: 'POST', url, headers: auth(tk[name]!), payload });
const get = (name: string, url: string) => app.inject({ method: 'GET', url, headers: auth(tk[name]!) });
const send = (method: 'PATCH' | 'DELETE', name: string, url: string, payload?: object) =>
  app.inject({ method, url, headers: auth(tk[name]!), payload });
const ids = (items: { id: string }[]) => items.map((i) => i.id);

beforeEach(async () => {
  ({ ctx, app } = await makeApp());
  tk = { Alice: await loginAs(app, 'Alice'), Bob: await loginAs(app, 'Bob') };
});

describe('메모리 격리 (gateway가 유일한 통로)', () => {
  it('가족 Room의 항목은 팀 Room 턴의 recall에 없다 (Room Agent·개인 Agent 모두)', () => {
    const roomAgent = ctx.memory.recallForTurn(SEED.roomAgents.team, R.team);
    expect(roomAgent.namespaces).toEqual([`room:${R.team}`]);
    expect(ids(roomAgent.items).sort()).toEqual(['mem_seed_team_1', 'mem_seed_team_2']);

    const personal = ctx.memory.recallForTurn(A.alice, R.team);
    const got = ids(personal.items);
    expect(got).toEqual(expect.arrayContaining(['mem_seed_team_1', 'mem_seed_team_2']));
    for (const forbidden of ['mem_seed_family_1', 'mem_seed_family_2', 'mem_seed_alice_for_family', 'mem_seed_alice_private']) {
      expect(got).not.toContain(forbidden);
    }
    // 반대로 가족 Room에서는 가족 항목과 가족에 공유한 개인 항목만
    const family = ids(ctx.memory.recallForTurn(A.alice, R.family).items);
    expect(family).toEqual(expect.arrayContaining(['mem_seed_family_1', 'mem_seed_alice_for_family']));
    expect(family).not.toContain('mem_seed_team_1');
    expect(family).not.toContain('mem_seed_alice_private');
  });

  it('My Room에 방문자가 있으면 private 항목이 recall에 없다 (혼자일 때는 있다)', async () => {
    await post('Alice', `/api/rooms/${R.myAlice}/enter`);
    const alone = ctx.memory.recallForTurn(A.alice, R.myAlice);
    expect(ids(alone.items)).toContain('mem_seed_alice_private');
    expect(alone.namespaces).toContain(`agent:${A.alice}:private`);

    const visitId = ((await post('Bob', `/api/rooms/${R.myAlice}/visits`, { kind: 'human' })).json() as { visitId: string }).visitId;
    await post('Alice', `/api/visits/${visitId}/accept`, { permissions: ['chat', 'comment'] });
    const withVisitor = ctx.memory.recallForTurn(A.alice, R.myAlice);
    expect(withVisitor.namespaces).not.toContain(`agent:${A.alice}:private`);
    expect(ids(withVisitor.items)).not.toContain('mem_seed_alice_private');

    // 방문자가 나가면 다시 열린다
    await post('Bob', `/api/visits/${visitId}/end`);
    expect(ids(ctx.memory.recallForTurn(A.alice, R.myAlice).items)).toContain('mem_seed_alice_private');
  });

  it('방문 중인 Agent의 recall에는 개인 ns가 없다', async () => {
    const mandate = { text: '인사만', allowedActions: ['chat'] };
    const visitId = ((await post('Alice', `/api/rooms/${R.myBob}/visits/agent`, { mandate })).json() as { visitId: string }).visitId;
    await post('Bob', `/api/visits/${visitId}/accept`, { permissions: ['chat'] });

    const atHost = ctx.memory.recallForTurn(A.alice, R.myBob);
    expect(atHost.namespaces).toEqual([`visit:${visitId}`]);
    expect(atHost.items).toEqual([]);
    // 어느 Room에서든 개인·가족 항목이 새지 않는다
    for (const room of [R.myAlice, R.family, R.myBob]) {
      const r = ctx.memory.recallForTurn(A.alice, room);
      expect(r.namespaces.some((n) => n.startsWith(`agent:${A.alice}`))).toBe(false);
      expect(ids(r.items)).not.toContain('mem_seed_alice_private');
      expect(ids(r.items)).not.toContain('mem_seed_alice_for_family');
    }
    // 방문 Agent는 기억을 저장하지 못한다
    expect(() => ctx.memory.retainFromAgent(A.alice, R.myBob, { kind: 'fact', text: '훔친 정보' })).toThrow();
  });

  it('제공되지 않은 used_memory_ids는 거부된다 (shared isSubsetOfProvided)', () => {
    const { providedIds } = ctx.memory.recallForTurn(SEED.roomAgents.team, R.team);
    expect(() => validateUsedMemoryIds([providedIds[0]!], providedIds)).not.toThrow();
    expect(() => validateUsedMemoryIds([], providedIds)).not.toThrow();
    expect(() => validateUsedMemoryIds(['mem_seed_family_1'], providedIds)).toThrow(/제공되지 않은/);
    expect(() => validateUsedMemoryIds([providedIds[0]!, 'mem_seed_alice_private'], providedIds)).toThrow();
  });
});

describe('retainFromAgent: ns는 서버가 정한다', () => {
  it('My Room에 혼자 있으면 private, Our Room이면 room ns, 이벤트 가시성도 그에 맞는다', async () => {
    await post('Alice', `/api/rooms/${R.myAlice}/enter`);
    const p = ctx.memory.retainFromAgent(A.alice, R.myAlice, { kind: 'preference', text: '아침형 인간이다.' });
    expect(p.ns).toBe(`agent:${A.alice}:private`);
    const ev = ctx.store.listAll(R.myAlice).filter((e) => e.type === 'memory_retained').pop()!;
    expect(ev.visibility).toBe(`private:${alice}`);
    expect(ctx.store.listVisible(bob, R.myAlice).some((e) => e.type === 'memory_retained')).toBe(false);

    const r = ctx.memory.retainFromAgent(A.alice, R.friends, { kind: 'agreement', text: '다음 모임은 토요일.' });
    expect(r.ns).toBe(`room:${R.friends}`);
    const ev2 = ctx.store.listAll(R.friends).filter((e) => e.type === 'memory_retained').pop()!;
    expect(ev2.visibility).toBe('room');

    // DM에서는 저장 불가
    expect(() => ctx.memory.retainFromAgent(A.alice, R.dmAliceBob, { kind: 'fact', text: 'x' })).toThrow();
    // 저장한 것이 다음 recall에 보인다
    expect(ids(ctx.memory.recallForTurn(A.bob, R.friends).items)).toContain(r.itemId);
  });
});

describe('메모리 REST', () => {
  it('내 기억 조회·추가·공유 대상 변경·삭제', async () => {
    const list = (await get('Alice', '/api/memory')).json() as MemoryListResponse;
    // 소유자 본인 것만(A2A 데모 시드 포함): 다른 사람의 기억 id가 섞이지 않는다
    expect(ids(list.items)).toEqual(expect.arrayContaining(['mem_seed_alice_for_family', 'mem_seed_alice_private']));
    expect(ids(list.items).every((i) => i.startsWith('mem_seed_alice_'))).toBe(true);
    const bobIds = ids(((await get('Bob', '/api/memory')).json() as MemoryListResponse).items);
    expect(bobIds).toContain('mem_seed_bob_for_team');
    expect(bobIds.every((i) => i.startsWith('mem_seed_bob_'))).toBe(true);

    const created = await post('Alice', '/api/memory', { ns: `agent:${A.alice}:private`, kind: 'fact', text: '고양이를 키운다.' });
    expect(created.statusCode).toBe(200);
    const id = (created.json() as { id: string }).id;
    expect(ctx.store.listAll(R.myAlice).some((e) => e.type === 'memory_retained' && e.visibility === `private:${alice}`)).toBe(true);

    // 친구들 Room에 공유 지정 → 그 Room recall에만 나타난다
    const share = await send('PATCH', 'Alice', `/api/memory/${id}`, { ns: `agent:${A.alice}:for:${R.friends}` });
    expect(share.statusCode).toBe(200);
    expect(ids(ctx.memory.recallForTurn(A.alice, R.friends).items)).toContain(id);
    expect(ids(ctx.memory.recallForTurn(A.alice, R.team).items)).not.toContain(id);
    // 해제하면 다시 private
    await send('PATCH', 'Alice', `/api/memory/${id}`, { ns: `agent:${A.alice}:private` });
    expect(ids(ctx.memory.recallForTurn(A.alice, R.friends).items)).not.toContain(id);

    // 남의 ns·내가 속하지 않은 Room·room ns로는 쓰거나 옮길 수 없다
    expect((await post('Alice', '/api/memory', { ns: `agent:${A.bob}:private`, kind: 'fact', text: 'x' })).statusCode).toBe(403);
    expect((await post('Alice', '/api/memory', { ns: `room:${R.family}`, kind: 'fact', text: 'x' })).statusCode).toBe(400);
    expect((await send('PATCH', 'Alice', `/api/memory/${id}`, { ns: `agent:${A.alice}:for:${R.myBob}` })).statusCode).toBe(403);
    // 남의 항목은 수정·삭제 불가
    expect((await send('DELETE', 'Bob', `/api/memory/${id}`)).statusCode).toBe(403);
    expect((await send('PATCH', 'Bob', `/api/memory/${id}`, { ns: `agent:${A.bob}:private` })).statusCode).toBe(403);

    expect((await send('DELETE', 'Alice', `/api/memory/${id}`)).statusCode).toBe(200);
    expect((await send('DELETE', 'Alice', `/api/memory/${id}`)).statusCode).toBe(404);
    expect(ids(((await get('Alice', '/api/memory')).json() as MemoryListResponse).items)).not.toContain(id);
  });

  it('GET /api/rooms/:id/memory는 구성원에게 그 Room의 기억만 보여 준다', async () => {
    const fam = (await get('Alice', `/api/rooms/${R.family}/memory`)).json() as MemoryListResponse;
    expect(ids(fam.items)).toEqual(expect.arrayContaining(['mem_seed_alice_for_family', 'mem_seed_family_1', 'mem_seed_family_2']));
    // 가족 Room 기억에는 Alice 본인의 가족 공유분과 방 기억만: 엄마·아빠 개인 기억, Alice 비공개·다른 Room 공유분은 없다
    expect(ids(fam.items).every((i) => /^mem_seed_(family_|alice_.*family)/.test(i))).toBe(true);
    // 팀 Room 기억에 가족 것이 섞이지 않는다
    const team = (await get('Alice', `/api/rooms/${R.team}/memory`)).json() as MemoryListResponse;
    expect(ids(team.items)).toEqual(expect.arrayContaining(['mem_seed_team_1', 'mem_seed_team_2']));
    expect(ids(team.items).every((i) => /^mem_seed_(team_|alice_fri_team)/.test(i))).toBe(true);
    // 구성원이 아니거나 방문자는 403
    expect((await get('Bob', `/api/rooms/${R.family}/memory`)).statusCode).toBe(403);
    expect((await get('Bob', `/api/rooms/${R.myAlice}/memory`)).statusCode).toBe(403);
  });
});

describe('기본 일정·취향 시드 기억의 격리', () => {
  it('각 Agent는 자기 기억을 공유된 Room에서만 쓰고, 남의 기억·비공개 기억은 보지 못한다', () => {
    const seedIds = (agentId: string, roomId: string) => ids(ctx.memory.recallForTurn(agentId, roomId).items).filter((i) => i.startsWith('mem_seed_'));
    // 아빠·엄마는 가족 방에서만, 팀·친구들 방에는 기억이 새지 않는다
    expect(seedIds(A.dad, R.family).length).toBeGreaterThanOrEqual(7);
    expect(seedIds(A.dad, R.team).every((i) => !i.includes('_dad_'))).toBe(true);
    expect(seedIds(A.mom, R.family).every((i) => !i.includes('_dad_') && !i.includes('_alice_'))).toBe(true);
    // Bob: 친구들 기억은 친구들에서, 팀 기억은 팀에서만
    expect(seedIds(A.bob, R.friends).every((i) => !i.endsWith('_team'))).toBe(true);
    expect(seedIds(A.bob, R.team).every((i) => !i.endsWith('_friends'))).toBe(true);
    // Alice의 비공개 기억(My Room 전용)은 어느 Our Room에서도 나오지 않는다
    for (const room of [R.friends, R.family, R.team]) {
      expect(seedIds(A.alice, room).some((i) => /^mem_seed_alice_(sat|todo_retro|todo_movie|todo_settle|food)$/.test(i) || i === 'mem_seed_alice_private')).toBe(false);
    }
    // 다른 사람의 Agent는 Alice의 My Room 기억을 보지 못한다
    expect(seedIds(A.bob, R.friends).some((i) => i.startsWith('mem_seed_alice_'))).toBe(false);
  });
});

describe('소유자 전용 현황·답변 카드의 격리', () => {
  it('방문자가 있으면 [내 Room 현황]과 blocks 스키마가 없고, 혼자일 때만 있다', async () => {
    const inputs: TurnInput[] = [];
    const base = new MockProvider();
    const p: AgentProvider = { name: 'spy', stream: (input, signal) => (inputs.push(input), base.stream(input, signal)) };
    ctx.agents.start();
    ctx.agents.setProvider(p);
    try {
      const say = (text: string) => dispatch(ctx, { kind: 'human', userId: alice }, { type: 'send_message', roomId: R.myAlice, text, to: A.alice });
      await post('Alice', `/api/rooms/${R.myAlice}/enter`);
      say('이번 주 일정 알려줘');
      await ctx.agents.drain();
      const alone = inputs.at(-1)!;
      expect(alone.allowBlocks).toBe(true);
      expect(alone.prompt).toContain('[내 Room 현황]');

      const visitId = ((await post('Bob', `/api/rooms/${R.myAlice}/visits`, { kind: 'human' })).json() as { visitId: string }).visitId;
      await post('Alice', `/api/visits/${visitId}/accept`, { permissions: ['chat', 'comment'] });
      say('이번 주 일정 알려줘');
      await ctx.agents.drain();
      const withVisitor = inputs.filter((i) => i.agent.id === A.alice).at(-1)!;
      expect(withVisitor.allowBlocks).toBe(false);
      expect(withVisitor.digest).toBeNull();
      expect(withVisitor.prompt).not.toContain('[내 Room 현황]');
      expect(withVisitor.system).not.toContain('[답변 카드]');
      expect(JSON.stringify(withVisitor.tools.find((t) => t.name === 'say'))).not.toContain('"blocks"');
      const last = ctx.store.listAll(R.myAlice).filter((e) => e.type === 'message' && e.actorKind === 'agent').at(-1);
      expect(last && last.type === 'message' ? last.blocks : undefined).toBeUndefined();
    } finally {
      ctx.agents.stop();
    }
  });

  it('현황에는 다른 구성원의 for 기억 문장(Bob의 16시 미팅, 엄마의 장보기)이 없다', async () => {
    const { buildOwnerDigest } = await import('../src/agent/ownerDigest');
    const text = buildOwnerDigest(ctx, alice).lines.join('\n');
    expect(text).not.toContain('16시에 고객 미팅');
    expect(text).not.toContain('장을 본다');
    expect(text).not.toContain('등산');
  });
});
