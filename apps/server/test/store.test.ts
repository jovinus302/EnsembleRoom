import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { privateTo } from '@ensemble/shared';
import { createContext } from '../src/context';
import { openDb } from '../src/db/index';
import { seedDatabase } from '../src/db/seed';
import { SEED, insertVisit, makeCtx } from './helpers';

const msg = (roomId: string, text: string, extra: object = {}) =>
  ({ roomId, actorKind: 'human', actorId: SEED.users.alice, type: 'message', text, ...extra }) as const;

describe('EventStore seq', () => {
  it('Room별로 1부터 단조 증가하고 Room끼리 독립이다', () => {
    const ctx = makeCtx();
    const base = ctx.store.lastSeq(SEED.rooms.friends);
    const seqs = [1, 2, 3].map((i) => ctx.store.append(msg(SEED.rooms.friends, `m${i}`)).seq);
    expect(seqs).toEqual([base + 1, base + 2, base + 3]);
    const other = ctx.store.append(msg(SEED.rooms.team, 'x')).seq;
    expect(other).toBe(ctx.store.lastSeq(SEED.rooms.team));
    expect(ctx.store.listAll(SEED.rooms.friends).map((e) => e.seq)).toEqual(
      Array.from({ length: base + 3 }, (_, i) => i + 1),
    );
  });

  it('Promise.all 동시 append도 빈틈·중복 없이 부여한다', async () => {
    const ctx = makeCtx();
    const base = ctx.store.lastSeq(SEED.rooms.friends);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => Promise.resolve().then(() => ctx.store.append(msg(SEED.rooms.friends, `c${i}`)))),
    );
    const seqs = results.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => base + i + 1));
  });

  it('같은 DB 파일을 여는 연결 두 개가 번갈아 append해도 seq가 겹치지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ensemble-store-'));
    const file = join(dir, 't.db');
    try {
      const a = createContext(openDb(file));
      seedDatabase(a);
      const b = createContext(openDb(file));
      const base = a.store.lastSeq(SEED.rooms.friends);
      for (let i = 0; i < 20; i++) {
        (i % 2 ? a : b).store.append(msg(SEED.rooms.friends, `f${i}`));
      }
      expect(a.store.listAll(SEED.rooms.friends).map((e) => e.seq)).toEqual(
        Array.from({ length: base + 20 }, (_, i) => i + 1),
      );
      a.db.close();
      b.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('트랜잭션이 롤백되면 이벤트도 리스너 호출도 없다', () => {
    const ctx = makeCtx();
    const seen: number[] = [];
    ctx.store.onAppended((e) => seen.push(e.seq));
    const before = ctx.store.lastSeq(SEED.rooms.friends);
    expect(() =>
      ctx.db.tx(() => {
        ctx.store.append(msg(SEED.rooms.friends, 'will roll back'));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(ctx.store.lastSeq(SEED.rooms.friends)).toBe(before);
    expect(seen).toEqual([]);
    ctx.store.append(msg(SEED.rooms.friends, 'ok'));
    expect(seen).toEqual([before + 1]);
  });

  it('잘못된 이벤트는 스키마 검증에서 거부된다', () => {
    const ctx = makeCtx();
    expect(() => ctx.store.append({ ...msg(SEED.rooms.friends, 'x'), text: 42 } as never)).toThrow();
  });
});

describe('listVisible 가시성', () => {
  it('private:X 이벤트는 X만 본다', () => {
    const ctx = makeCtx();
    ctx.store.append(msg(SEED.rooms.friends, 'secret', { visibility: privateTo(SEED.users.alice) }));
    const texts = (u: string) =>
      ctx.store
        .listVisible(u, SEED.rooms.friends)
        .filter((e) => e.type === 'message')
        .map((e) => (e as { text: string }).text);
    expect(texts(SEED.users.alice)).toContain('secret');
    expect(texts(SEED.users.bob)).not.toContain('secret');
  });

  it('my Room: 소유자는 전부, 방문자는 활성인 동안 start_seq 이상만, 남은 아무것도 못 본다', () => {
    const ctx = makeCtx();
    const room = SEED.rooms.myAlice;
    const e1 = ctx.store.append(msg(room, 'before'));
    const e2 = ctx.store.append(msg(room, 'start'));
    const e3 = ctx.store.append(msg(room, 'after'));
    const bob = SEED.users.bob;
    const owner = ctx.store.listVisible(SEED.users.alice, room).map((e) => e.seq);
    expect(owner).toContain(e1.seq);

    expect(ctx.store.listVisible(bob, room)).toEqual([]);

    const visitId = insertVisit(ctx, { hostRoomId: room, visitorUserId: bob, status: 'requested', startSeq: null });
    expect(ctx.store.listVisible(bob, room)).toEqual([]);

    ctx.db.raw.prepare("UPDATE visits SET status = 'active', start_seq = ? WHERE id = ?").run(e2.seq, visitId);
    expect(ctx.store.listVisible(bob, room).map((e) => e.seq)).toEqual([e2.seq, e3.seq]);

    // Agent 방문자는 사람처럼 안쪽을 보지 못한다
    ctx.db.raw.prepare("UPDATE visits SET visitor_kind = 'agent' WHERE id = ?").run(visitId);
    expect(ctx.store.listVisible(bob, room)).toEqual([]);

    ctx.db.raw.prepare("UPDATE visits SET visitor_kind = 'human', status = 'ended' WHERE id = ?").run(visitId);
    expect(ctx.store.listVisible(bob, room)).toEqual([]);
  });

  it('our/dm Room: 구성원만 본다', () => {
    const ctx = makeCtx();
    const { alice, bob, mom, dana } = SEED.users;
    expect(ctx.store.listVisible(alice, SEED.rooms.family).length).toBeGreaterThan(0);
    expect(ctx.store.listVisible(mom, SEED.rooms.family).length).toBeGreaterThan(0);
    expect(ctx.store.listVisible(bob, SEED.rooms.family)).toEqual([]);
    expect(ctx.store.listVisible(dana, SEED.rooms.friends)).toEqual([]);
    expect(ctx.store.listVisible(dana, SEED.rooms.team).length).toBeGreaterThan(0);
    expect(ctx.store.listVisible(mom, SEED.rooms.dmAliceBob)).toEqual([]);
    expect(ctx.store.listVisible(bob, SEED.rooms.dmAliceBob).length).toBeGreaterThan(0);
  });
});
