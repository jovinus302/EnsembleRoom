import {
  RoomEventSchema,
  canSeeEvent,
  fromStoredRow,
  toStoredRow,
  type NewRoomEvent,
  type RoomEvent,
  type StoredEventRow,
} from '@ensemble/shared';
import type { Db } from '../db/index';
import type { Repo } from '../db/repo';

export interface ListOpts {
  /** 이 seq 초과만 */
  afterSeq?: number;
  /** 이 seq 이하만 (타임라인 재생) */
  upToSeq?: number;
}

type Listener = (event: RoomEvent) => void;

/**
 * 영속 이벤트 로그. 한 Room 안에서 seq는 1부터 단조 증가한다(트랜잭션 안에서 MAX+1).
 * 리스너(hub)는 최외곽 트랜잭션이 커밋된 뒤에만 호출된다.
 */
export class EventStore {
  private listeners = new Set<Listener>();

  constructor(
    private readonly db: Db,
    private readonly repo: Repo,
  ) {}

  onAppended(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** 이벤트 1건 추가. seq·ts는 여기서 부여한다. 스키마 검증에 실패하면 throw. */
  append(input: NewRoomEvent): RoomEvent {
    return this.db.tx(() => {
      const next = this.db.raw
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events WHERE room_id = ?')
        .get(input.roomId) as { n: number };
      const event = RoomEventSchema.parse({
        ...input,
        seq: next.n,
        ts: Date.now(),
        visibility: input.visibility ?? 'room',
        turnId: input.turnId ?? null,
      }) as RoomEvent;
      const row = toStoredRow(event);
      this.db.raw
        .prepare(
          `INSERT INTO events (room_id, seq, ts, actor_kind, actor_id, type, payload_json, visibility, turn_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.roomId,
          row.seq,
          row.ts,
          row.actorKind,
          row.actorId,
          row.type,
          JSON.stringify(row.payload),
          row.visibility,
          row.turnId,
        );
      this.db.afterCommit(() => {
        for (const l of this.listeners) {
          try {
            l(event);
          } catch (err) {
            console.error('[store] listener failed', err);
          }
        }
      });
      return event;
    });
  }

  appendMany(inputs: readonly NewRoomEvent[]): RoomEvent[] {
    return this.db.tx(() => inputs.map((i) => this.append(i)));
  }

  lastSeq(roomId: string): number {
    const r = this.db.raw.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM events WHERE room_id = ?').get(roomId) as {
      n: number;
    };
    return r.n;
  }

  /** 가시성 필터 없이 전부 (서버 내부용: 리듀서, 시드, 테스트). 클라이언트에 그대로 내보내지 않는다. */
  listAll(roomId: string, opts: ListOpts = {}): RoomEvent[] {
    const rows = this.db.raw
      .prepare(
        `SELECT room_id AS roomId, seq, ts, actor_kind AS actorKind, actor_id AS actorId, type,
                payload_json AS payloadJson, visibility, turn_id AS turnId
           FROM events WHERE room_id = ? AND seq > ? AND seq <= ? ORDER BY seq`,
      )
      .all(roomId, opts.afterSeq ?? 0, opts.upToSeq ?? Number.MAX_SAFE_INTEGER) as unknown as (Omit<
      StoredEventRow,
      'payload'
    > & { payloadJson: string })[];
    return rows.map(({ payloadJson, ...r }) => fromStoredRow({ ...r, payload: JSON.parse(payloadJson) }));
  }

  /** viewer에게 보이는 이벤트만. 스냅샷·재생·hub가 같은 canSeeEvent를 쓴다. */
  listVisible(viewerId: string, roomId: string, opts: ListOpts = {}): RoomEvent[] {
    const ctx = this.repo.canSeeContext(roomId, viewerId);
    if (!ctx) return [];
    return this.listAll(roomId, opts).filter((e) => canSeeEvent(e, ctx));
  }
}
