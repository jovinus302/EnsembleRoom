import {
  ClientWsMessageSchema,
  canSeeEvent,
  type ActivityMessage,
  type CanSeeContext,
  type RoomEvent,
  type ServerWsMessage,
  type UserDto,
} from '@ensemble/shared';
import type { AppContext } from '../context';
import type { PresenceListener } from '../domain/presence';
import { canAccessRoom, lastLeaveOf, myAgentStatus, previewFor, roomStateOf } from '../domain/rooms';

// HOSTING: 메모리 → Redis pub/sub. 이 클래스는 단일 프로세스의 소켓 집합만 안다.
// 여러 프로세스가 되면 store 리스너와 publishActivity/cursor를 pub/sub 채널로 바꾸고, 각 프로세스가 자기 소켓에만 보낸다.

/** @fastify/websocket의 소켓에서 hub가 쓰는 부분만 */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', cb: (data: { toString(): string }) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
}

const WS_OPEN = 1;

/** 이 이벤트가 나면 월드 미리보기를 전 Room 다시 보낸다(방문 Agent 칩이 여러 Room에 걸친다) */
const VISIT_PREVIEW_EVENTS = new Set<string>([
  'visit_accepted',
  'visit_ended',
  'agent_departed',
  'agent_arrived',
  'agent_returned',
]);

interface Client {
  socket: WsLike;
  user: UserDto;
  rooms: Set<string>;
  world: boolean;
}

export class Hub {
  private clients = new Set<Client>();
  private presenceListener: PresenceListener | null = null;

  constructor(private readonly ctx: AppContext) {
    // 커밋된 이벤트마다 구독자별 가시성 필터를 적용해 내보낸다.
    ctx.store.onAppended((e) => this.broadcastEvent(e));
  }

  /** 영속 presence(domain/presence.ts)에 구독 변화를 알린다. */
  setPresenceListener(l: PresenceListener | null): void {
    this.presenceListener = l;
  }

  private notify(fn: (l: PresenceListener) => void): void {
    if (!this.presenceListener) return;
    try {
      fn(this.presenceListener);
    } catch (err) {
      console.error('[hub] presence listener failed', err);
    }
  }

  /** 인증된 소켓을 등록한다. */
  register(socket: WsLike, user: UserDto): void {
    const client: Client = { socket, user, rooms: new Set(), world: false };
    this.clients.add(client);
    socket.on('message', (raw) => this.onMessage(client, raw.toString()));
    socket.on('close', () => this.drop(client));
    socket.on('error', () => this.drop(client));
  }

  /* ---------------- 수신 ---------------- */

  private onMessage(client: Client, raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const msg = ClientWsMessageSchema.safeParse(json);
    if (!msg.success) return;
    const m = msg.data;
    switch (m.type) {
      case 'subscribe': {
        // 접근 권한은 서버 진실로 판정한다. 권한이 없으면 조용히 무시한다.
        if (!canAccessRoom(this.ctx, client.user.id, m.roomId)) return;
        if (client.rooms.has(m.roomId)) return;
        const wasConnected = this.connectedUserIds(m.roomId).includes(client.user.id);
        client.rooms.add(m.roomId);
        this.broadcastPresence(m.roomId);
        if (!wasConnected) this.notify((l) => l.onJoin(client.user.id, m.roomId));
        return;
      }
      case 'unsubscribe': {
        if (client.rooms.delete(m.roomId)) {
          this.broadcastPresence(m.roomId);
          this.afterUnsubscribe(client.user.id, m.roomId);
        }
        return;
      }
      case 'subscribe_world': {
        client.world = true;
        const myAgent = myAgentStatus(this.ctx, client.user.id);
        for (const room of this.ctx.repo.listRooms()) {
          const preview = previewFor(this.ctx, client.user.id, room.id);
          if (preview) this.send(client, { type: 'world_preview', preview, myAgent });
        }
        return;
      }
      case 'cursor': {
        const out: ServerWsMessage = { ...m, userId: client.user.id };
        if (m.roomId === null) {
          for (const c of this.clients) if (c !== client && c.world) this.send(c, out);
        } else {
          if (!client.rooms.has(m.roomId)) return;
          for (const c of this.clients) if (c !== client && c.rooms.has(m.roomId)) this.send(c, out);
        }
        return;
      }
    }
  }

  private drop(client: Client): void {
    if (!this.clients.delete(client)) return;
    for (const roomId of client.rooms) {
      this.broadcastPresence(roomId);
      this.afterUnsubscribe(client.user.id, roomId);
    }
  }

  /** 이 사용자의 마지막 구독이 사라졌을 때만 presence에 알린다(다른 창이 열려 있으면 아직 있는 것이다). */
  private afterUnsubscribe(userId: string, roomId: string): void {
    if (!this.connectedUserIds(roomId).includes(userId)) this.notify((l) => l.onLeave(userId, roomId));
  }

  /* ---------------- 송신 ---------------- */

  private send(client: Client, msg: ServerWsMessage): void {
    if (client.socket.readyState !== WS_OPEN) return;
    try {
      client.socket.send(JSON.stringify(msg));
    } catch (err) {
      console.error('[hub] send failed', err);
    }
  }

  private subscribers(roomId: string): Client[] {
    return [...this.clients].filter((c) => c.rooms.has(roomId));
  }

  /** 영속 이벤트를 구독자별 가시성 필터로 걸러 보낸다. 그 뒤 월드 구독자에게 새 미리보기를 보낸다. */
  broadcastEvent(event: RoomEvent): void {
    const ctxCache = new Map<string, CanSeeContext | null>();
    for (const c of this.subscribers(event.roomId)) {
      if (!ctxCache.has(c.user.id)) ctxCache.set(c.user.id, this.ctx.repo.canSeeContext(event.roomId, c.user.id));
      const see = ctxCache.get(c.user.id);
      if (see && canSeeEvent(event, see)) this.send(c, { type: 'event', event });
    }
    if (event.type === 'member_left' || event.type === 'member_rejoined' || event.type === 'member_entered') {
      this.broadcastPresence(event.roomId);
    }
    // 방문 이벤트는 호스트·출발 Room뿐 아니라 그 Agent의 칩이 있는 Our Room 미리보기도 바꾼다 → 모든 Room을 다시 보낸다.
    const roomIds = VISIT_PREVIEW_EVENTS.has(event.type) ? this.ctx.repo.listRooms().map((r) => r.id) : [event.roomId];
    const done = new Set<string>();
    for (const c of this.clients) {
      if (!c.world || done.has(c.user.id)) continue;
      done.add(c.user.id);
      // 방문·presence 변화는 내 Agent의 위치·상태도 바꾼다
      const myAgent = myAgentStatus(this.ctx, c.user.id);
      for (const roomId of roomIds) {
        const preview = previewFor(this.ctx, c.user.id, roomId);
        if (!preview) continue;
        for (const c2 of this.clients) if (c2.world && c2.user.id === c.user.id) this.send(c2, { type: 'world_preview', preview, myAgent });
      }
    }
  }

  /** 휘발성 activity(Agent 스트리밍). room 가시성으로 걸러 보낸다. 영속하지 않는다. */
  publishActivity(msg: ActivityMessage): void {
    for (const c of this.subscribers(msg.roomId)) {
      const see = this.ctx.repo.canSeeContext(msg.roomId, c.user.id);
      if (see && canSeeEvent({ seq: Number.MAX_SAFE_INTEGER, visibility: 'room' }, see)) this.send(c, msg);
    }
  }

  /** REST로 보낸 메시지의 확정(seq)을 보낸 사람의 모든 소켓에 알린다. */
  ack(userId: string, clientId: string, seq: number): void {
    for (const c of this.clients) if (c.user.id === userId) this.send(c, { type: 'ack', clientId, seq });
  }

  /** 지금 이 Room을 구독 중인(소켓이 열려 있는) 사람들. 영속 presence(S6)와는 별개다. */
  connectedUserIds(roomId: string): string[] {
    return [...new Set(this.subscribers(roomId).map((c) => c.user.id))];
  }

  /**
   * 클라이언트에 알리는 접속자: 구독 중이면서 명시적 Leave 상태가 아닌 사람.
   * 명시적 Leave한 사용자는 구독이 살아 있어도 제외한다(Rejoin하면 복귀). 방문자·DM 등 구성원 상태가 없는 사람은 그대로 둔다.
   */
  presentUserIds(roomId: string): string[] {
    const connected = this.connectedUserIds(roomId);
    if (connected.length === 0) return connected;
    const members = roomStateOf(this.ctx, roomId).members;
    return connected.filter((id) => {
      const m = members[id];
      if (!m || m.present) return true;
      return lastLeaveOf(this.ctx, roomId, id)?.implicit === true;
    });
  }

  private broadcastPresence(roomId: string): void {
    const userIds = this.presentUserIds(roomId);
    for (const c of this.subscribers(roomId)) this.send(c, { type: 'presence', roomId, userIds });
  }

  /** 테스트·종료용 */
  closeAll(): void {
    this.presenceListener?.dispose();
    for (const c of this.clients) c.socket.close(1001, 'server shutting down');
    this.clients.clear();
  }
}
