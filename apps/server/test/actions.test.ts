import { describe, expect, it } from 'vitest';
import { dispatch, type Action } from '../src/domain/actions';
import type { ActorCtx } from '../src/domain/rooms';
import { DomainError } from '../src/errors';
import { SEED, auth, insertVisit, loginAs, makeApp, makeCtx } from './helpers';

const { alice, bob, mom } = SEED.users;
const human = (userId: string): ActorCtx => ({ kind: 'human', userId });
const agent = (agentId: string): ActorCtx => ({ kind: 'agent', agentId });

function status(fn: () => unknown): { status: number; code: string } | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof DomainError) return { status: e.status, code: e.code };
    throw e;
  }
}

const say = (roomId: string, text = 'hi'): Action => ({ type: 'send_message', roomId, text });
const newCard = (roomId: string): Action => ({ type: 'create_card', roomId, title: 't', body: 'b' });

describe('dispatch 권한 (403)', () => {
  it('구성원이 아니면 어떤 쓰기도 403', () => {
    const ctx = makeCtx();
    expect(status(() => dispatch(ctx, human(bob), say(SEED.rooms.myAlice)))).toEqual({ status: 403, code: 'not_in_room' });
    expect(status(() => dispatch(ctx, human(bob), say(SEED.rooms.family)))).toEqual({ status: 403, code: 'not_in_room' });
    expect(status(() => dispatch(ctx, human(mom), say(SEED.rooms.dmAliceBob)))?.status).toBe(403);
  });

  it('DM 구성원은 chat만 가능하다', () => {
    const ctx = makeCtx();
    expect(status(() => dispatch(ctx, human(alice), say(SEED.rooms.dmAliceBob)))).toBeNull();
    expect(status(() => dispatch(ctx, human(alice), newCard(SEED.rooms.dmAliceBob)))).toEqual({
      status: 403,
      code: 'missing_capability',
    });
  });

  it('방문자는 수락 때 받은 grant 안에서만, 방문이 끝나면 아무것도 못 한다', () => {
    const ctx = makeCtx();
    const room = SEED.rooms.myAlice;
    const start = ctx.store.lastSeq(room) + 1;
    const visitId = insertVisit(ctx, { hostRoomId: room, visitorUserId: bob, permissions: ['comment'], startSeq: start });
    const card = dispatch(ctx, human(alice), newCard(room));
    const cardId = card.data.cardId as string;

    expect(status(() => dispatch(ctx, human(bob), say(room)))?.code).toBe('missing_capability');
    expect(status(() => dispatch(ctx, human(bob), newCard(room)))?.code).toBe('missing_capability');
    expect(
      status(() => dispatch(ctx, human(bob), { type: 'update_card', roomId: room, cardId, patch: { title: 'x' }, baseVersion: 1 }))
        ?.code,
    ).toBe('missing_capability');
    expect(status(() => dispatch(ctx, human(bob), { type: 'add_comment', roomId: room, cardId, text: 'nice' }))).toBeNull();

    ctx.db.raw.prepare("UPDATE visits SET status = 'ended' WHERE id = ?").run(visitId);
    expect(status(() => dispatch(ctx, human(bob), { type: 'add_comment', roomId: room, cardId, text: 'again' }))?.status).toBe(403);
  });

  it('Agent: 소유자 My Room 동행은 edit_board 가능, Our 구성원 Agent는 불가, 남의 Room은 403', () => {
    const ctx = makeCtx();
    expect(status(() => dispatch(ctx, agent(SEED.agents.alice), newCard(SEED.rooms.myAlice)))).toBeNull();
    expect(status(() => dispatch(ctx, agent(SEED.agents.alice), newCard(SEED.rooms.friends)))?.code).toBe('missing_capability');
    expect(status(() => dispatch(ctx, agent(SEED.agents.alice), say(SEED.rooms.friends)))).toBeNull();
    expect(status(() => dispatch(ctx, agent(SEED.agents.bob), say(SEED.rooms.myAlice)))?.code).toBe('not_in_room');
    expect(status(() => dispatch(ctx, agent(SEED.agents.alice), say(SEED.rooms.dmAliceBob)))?.code).toBe('not_in_room');
  });

  it('방문 Agent: grant ∩ mandate, edit_board는 grant에 있어도 불가', () => {
    const ctx = makeCtx();
    const room = SEED.rooms.myBob;
    insertVisit(ctx, {
      hostRoomId: room,
      visitorUserId: alice,
      visitorKind: 'agent',
      visitorAgentId: SEED.agents.alice,
      permissions: ['chat', 'comment', 'edit_board'],
      mandate: { text: '대화만', allowedActions: ['chat', 'edit_board'] },
      startSeq: 1,
    });
    expect(status(() => dispatch(ctx, agent(SEED.agents.alice), say(room)))).toBeNull();
    expect(status(() => dispatch(ctx, agent(SEED.agents.alice), newCard(room)))?.code).toBe('missing_capability');
    const card = dispatch(ctx, human(SEED.users.bob), newCard(room)).data.cardId as string;
    expect(
      status(() => dispatch(ctx, agent(SEED.agents.alice), { type: 'add_comment', roomId: room, cardId: card, text: 'c' }))?.code,
    ).toBe('missing_capability');
  });

  it('Room Agent는 자기 Room에서만, 카드 편집은 불가', () => {
    const ctx = makeCtx();
    const ra: ActorCtx = { kind: 'room_agent', roomAgentId: SEED.roomAgents.family };
    expect(status(() => dispatch(ctx, ra, say(SEED.rooms.family)))).toBeNull();
    expect(status(() => dispatch(ctx, ra, say(SEED.rooms.team)))?.code).toBe('not_in_room');
    expect(status(() => dispatch(ctx, ra, newCard(SEED.rooms.family)))?.code).toBe('missing_capability');
  });

  it('권한 검사는 서버 진실로 매번 다시 계산한다(방문이 끝난 직후의 쓰기는 거부)', () => {
    const ctx = makeCtx();
    const room = SEED.rooms.myAlice;
    const id = insertVisit(ctx, { hostRoomId: room, visitorUserId: bob, permissions: ['chat'], startSeq: 1 });
    expect(status(() => dispatch(ctx, human(bob), say(room)))).toBeNull();
    ctx.db.raw.prepare("UPDATE visits SET status = 'ended' WHERE id = ?").run(id);
    expect(status(() => dispatch(ctx, human(bob), say(room)))?.status).toBe(403);
  });

  it('위반한 쓰기는 이벤트를 남기지 않는다', () => {
    const ctx = makeCtx();
    const before = ctx.store.lastSeq(SEED.rooms.myAlice);
    status(() => dispatch(ctx, human(bob), say(SEED.rooms.myAlice)));
    expect(ctx.store.lastSeq(SEED.rooms.myAlice)).toBe(before);
  });
});

describe('dispatch 도메인 규칙', () => {
  it('존재하지 않는 수신자·카드·Agent는 400/404', () => {
    const ctx = makeCtx();
    const r = SEED.rooms.friends;
    expect(status(() => dispatch(ctx, human(alice), { type: 'send_message', roomId: r, text: 'x', to: 'nobody' }))?.status).toBe(400);
    expect(status(() => dispatch(ctx, human(alice), { type: 'add_comment', roomId: r, cardId: 'nope', text: 'x' }))?.status).toBe(404);
    const card = dispatch(ctx, human(alice), newCard(r)).data.cardId as string;
    expect(status(() => dispatch(ctx, human(alice), { type: 'point_card', roomId: r, cardId: card, agentId: 'nobody' }))?.status).toBe(400);
    expect(status(() => dispatch(ctx, human(alice), { type: 'point_card', roomId: r, cardId: card, agentId: SEED.agents.bob }))).toBeNull();
    expect(status(() => dispatch(ctx, human(alice), say('nope')))?.status).toBe(404);
  });

  it('카드 수정은 baseVersion이 낡으면 409, 성공하면 version이 오른다', () => {
    const ctx = makeCtx();
    const r = SEED.rooms.friends;
    const cardId = dispatch(ctx, human(alice), newCard(r)).data.cardId as string;
    const ok = dispatch(ctx, human(bob), { type: 'update_card', roomId: r, cardId, patch: { title: 'B' }, baseVersion: 1 });
    expect(ok.data.version).toBe(2);
    expect(status(() => dispatch(ctx, human(alice), { type: 'update_card', roomId: r, cardId, patch: { title: 'A' }, baseVersion: 1 }))).toEqual({
      status: 409,
      code: 'version_conflict',
    });
    expect(ctx.repo.getCard(r, cardId)?.title).toBe('B');
  });

  it("남의 이름·'ours' 오용 ownerTag는 거부, Our Room 기본은 ours", () => {
    const ctx = makeCtx();
    const our = SEED.rooms.friends;
    const id = dispatch(ctx, human(alice), newCard(our)).data.cardId as string;
    expect(ctx.repo.getCard(our, id)?.ownerTag).toBe('ours');
    expect(status(() => dispatch(ctx, human(alice), { ...newCard(our), ownerTag: `user:${bob}` } as Action))?.status).toBe(403);
    expect(status(() => dispatch(ctx, human(alice), { ...newCard(SEED.rooms.myAlice), ownerTag: 'ours' } as Action))?.status).toBe(400);
    const mine = dispatch(ctx, human(alice), newCard(SEED.rooms.myAlice)).data.cardId as string;
    expect(ctx.repo.getCard(SEED.rooms.myAlice, mine)?.ownerTag).toBe(`user:${alice}`);
  });

  it('합의된 카드는 직접 수정할 수 없다', () => {
    const ctx = makeCtx();
    const r = SEED.rooms.friends;
    const cardId = dispatch(ctx, human(alice), newCard(r)).data.cardId as string;
    ctx.db.raw.prepare('UPDATE board_cards SET agreed = 1 WHERE card_id = ?').run(cardId);
    expect(status(() => dispatch(ctx, human(alice), { type: 'update_card', roomId: r, cardId, patch: { body: 'z' }, baseVersion: 1 }))?.code).toBe(
      'needs_decision_approval',
    );
  });

  it('mark_seen은 사람만, 줄어들지 않는다', () => {
    const ctx = makeCtx();
    const r = SEED.rooms.friends;
    dispatch(ctx, human(alice), say(r));
    const last = ctx.store.lastSeq(r);
    dispatch(ctx, human(alice), { type: 'mark_seen', roomId: r, seq: last });
    dispatch(ctx, human(alice), { type: 'mark_seen', roomId: r, seq: 1 });
    expect(ctx.repo.getCursor(alice, r).lastSeenSeq).toBe(last);
    expect(status(() => dispatch(ctx, agent(SEED.agents.alice), { type: 'mark_seen', roomId: r, seq: 1 }))?.status).toBe(403);
  });
});

describe('HTTP 403/401', () => {
  it('토큰이 없으면 401, 권한 위반은 403 + code', async () => {
    const { app } = await makeApp();
    const noAuth = await app.inject({ method: 'GET', url: '/api/world' });
    expect(noAuth.statusCode).toBe(401);

    const token = await loginAs(app, 'Bob');
    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/rooms/${SEED.rooms.myAlice}/messages`,
      headers: auth(token),
      payload: { text: 'hi', clientId: 'c1' },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'not_in_room' });

    const snap = await app.inject({ method: 'GET', url: `/api/rooms/${SEED.rooms.family}/snapshot`, headers: auth(token) });
    expect(snap.statusCode).toBe(403);

    const bad = await app.inject({ method: 'POST', url: `/api/rooms/${SEED.rooms.friends}/messages`, headers: auth(token), payload: { text: '' } });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
