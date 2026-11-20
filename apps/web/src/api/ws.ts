import { ServerWsMessageSchema, type ClientWsMessage, type RoomEvent } from '@ensemble/shared';
import { api, ApiError, getToken } from './client';
import { useRooms } from '../store/roomStore';
import { useWorld } from '../store/worldStore';
import { useActivity } from '../store/activityStore';
import { refreshApprovalInbox } from '../store/approvalStore';
import { useSession } from '../store/session';
import { emit as fxEmit, setRemoteCursor, clearRemoteCursors } from '../fx/fxStore';
import { fxFromPreviewChange, fxFromRoomEvent } from '../fx/fxBridge';

/**
 * WS 연결·재연결·구독 복원. 스토어는 이 모듈을 모르고, 이 모듈이 스토어를 갱신한다.
 * 클라이언트 순서: WS subscribe 먼저 → snapshot REST → seq로 중복 제거(roomStore.mergeEvents).
 */

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;

class WsClient {
  private socket: WebSocket | null = null;
  private subs = new Set<string>();
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wanted = false;
  private everOpened = false;

  connect(): void {
    this.wanted = true;
    if (this.socket) return;
    this.open();
  }

  disconnect(): void {
    this.wanted = false;
    this.everOpened = false;
    this.attempt = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.subs.clear();
    const s = this.socket;
    this.socket = null;
    s?.close(1000);
    useActivity.getState().reset();
    clearRemoteCursors();
    useWorld.getState().setWsStatus('idle');
  }

  /** 휘발성 cursor 채널(20Hz 상한은 호출자가 지킨다). 소켓이 닫혀 있으면 버린다 */
  sendCursor(x: number, y: number, z: number, roomId: string | null): void {
    this.send({ type: 'cursor', x, y, z, roomId });
  }

  private open(): void {
    const token = getToken();
    if (!token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // HOSTING: 외부 배포 시 API 호스트로 바꾼다.
    const socket = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    this.socket = socket;
    useWorld.getState().setWsStatus(this.everOpened ? 'reconnecting' : 'connecting');

    socket.onopen = () => {
      if (this.socket !== socket) return;
      const reconnected = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      useWorld.getState().setWsStatus('open');
      this.send({ type: 'subscribe_world' });
      for (const roomId of this.subs) this.send({ type: 'subscribe', roomId });
      if (reconnected) {
        useActivity.getState().reset(); // 끊긴 동안 final을 놓쳤을 수 있다
        // 끊긴 동안 놓친 변화를 따라잡는다.
        void useWorld.getState().load().catch(() => undefined);
        refreshApprovalInbox();
        for (const roomId of this.subs) void loadSnapshot(roomId);
      }
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      let json: unknown;
      try {
        json = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const msg = ServerWsMessageSchema.safeParse(json);
      if (!msg.success) return;
      const m = msg.data;
      switch (m.type) {
        case 'event': {
          useRooms.getState().applyEvent(m.event);
          const e = m.event;
          refetchIfUnknownAgent(e);
          fxFromRoomEvent(e);
          // 영속 이벤트로도 활동 표시를 시작/해제한다(첫 activity 전의 "생각 중", 늦게 온 final 보완).
          if (e.type === 'agent_turn_started') useActivity.getState().begin(e.roomId, e.agentId, e.turnId);
          else if (e.type === 'agent_step' && e.kind === 'recalling')
            useActivity.getState().setPhase(e.roomId, e.agentId, e.turnId, 'recalling');
          else if (e.type === 'agent_turn_ended') useActivity.getState().endTurn(e.roomId, e.agentId, e.turnId);
          else if (e.type === 'visit_accepted' || e.type === 'agent_arrived') {
            // 방문 Agent(이름·색)는 snapshot.agents에 들어온다: 구독 중인 Room이면 다시 가져와 갱신한다.
            if (this.subs.has(e.roomId)) void loadSnapshot(e.roomId);
          } else if (e.type === 'approval_requested' || e.type === 'approval_voted' || e.type === 'approval_resolved')
            refreshApprovalInbox();
          break;
        }
        case 'activity':
          useActivity.getState().apply(m);
          break;
        case 'ack':
          useRooms.getState().ack(m.clientId, m.seq);
          break;
        case 'world_preview': {
          const prevPreview = useWorld.getState().rooms[m.preview.roomId]?.preview;
          const prev = prevPreview?.detail?.pendingApprovals ?? 0;
          useWorld.getState().applyPreview(m.preview, m.myAgent);
          fxFromPreviewChange(prevPreview, m.preview);
          if ((m.preview.detail?.pendingApprovals ?? 0) !== prev) refreshApprovalInbox();
          break;
        }
        case 'presence':
          useRooms.getState().setPresence(m.roomId, m.userIds);
          break;
        case 'cursor':
          if (m.userId !== useSession.getState().user?.id) setRemoteCursor({ userId: m.userId, x: m.x, y: m.y, z: m.z, roomId: m.roomId });
          break;
        default:
          break;
      }
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.wanted || ev.code === 4401) {
        useWorld.getState().setWsStatus('idle');
        return;
      }
      useWorld.getState().setWsStatus('reconnecting');
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempt++);
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.wanted && !this.socket) this.open();
      }, delay);
    };
    socket.onerror = () => {
      /* onclose에서 재연결 */
    };
  }

  private send(msg: ClientWsMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  subscribe(roomId: string): void {
    this.subs.add(roomId);
    this.send({ type: 'subscribe', roomId });
  }

  unsubscribe(roomId: string): void {
    if (this.subs.delete(roomId)) this.send({ type: 'unsubscribe', roomId });
  }
}

export const wsClient = new WsClient();

export type SnapshotResult = 'ok' | 'forbidden' | 'error';

async function loadSnapshot(roomId: string): Promise<SnapshotResult> {
  try {
    const snap = await api.snapshot(roomId);
    useRooms.getState().applySnapshot(roomId, snap);
    return 'ok';
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return e.status === 403 ? 'forbidden' : 'error';
  }
}

/**
 * 스냅샷 이후에 처음 말하는 Agent(시드 인물의 Agent 등)는 agents에 없어 이름이 "Agent"로 보인다.
 * 모르는 Agent id의 이벤트가 오면 스냅샷을 한 번만 다시 가져온다(Room·Agent별 중복 요청 방지).
 */
const refetchedAgents = new Set<string>();
function refetchIfUnknownAgent(e: RoomEvent): void {
  if ((e.actorKind !== 'agent' && e.actorKind !== 'room_agent') || !e.actorId) return;
  const slice = useRooms.getState().rooms[e.roomId];
  if (!slice?.snapshotLoaded || slice.agents.some((a) => a.id === e.actorId)) return;
  const key = `${e.roomId}:${e.actorId}`;
  if (refetchedAgents.has(key)) return;
  refetchedAgents.add(key);
  void loadSnapshot(e.roomId);
}

/** Room 열기: subscribe 먼저, 그다음 snapshot. 이벤트 중복은 seq로 제거된다. */
export async function openRoom(roomId: string): Promise<SnapshotResult> {
  wsClient.subscribe(roomId);
  return loadSnapshot(roomId);
}

export function closeRoom(roomId: string): void {
  wsClient.unsubscribe(roomId);
  useActivity.getState().clearRoom(roomId);
}

/** 낙관적 전송: 즉시 pending(보냄)을 올리고, REST 응답/ack/이벤트로 확정한다. */
export async function sendMessage(roomId: string, text: string, existingClientId?: string, to?: string): Promise<void> {
  const rooms = useRooms.getState();
  const clientId = existingClientId ?? crypto.randomUUID();
  fxEmit('send_local', { roomId, actorId: useSession.getState().user ? `h:${useSession.getState().user!.id}` : null, key: clientId, mine: true, color: useSession.getState().user ? useWorld.getState().users[useSession.getState().user!.id]?.color : undefined });
  if (existingClientId) rooms.updatePending(clientId, { status: 'sending', error: undefined });
  else rooms.addPending({ clientId, roomId, text, to, status: 'sending', createdAt: Date.now() });
  try {
    const r = await api.sendMessage(roomId, to ? { text, clientId, to } : { text, clientId });
    useRooms.getState().ack(clientId, r.seq);
  } catch (e) {
    useRooms
      .getState()
      .updatePending(clientId, { status: 'failed', error: e instanceof ApiError ? e.message : '전송 실패' });
  }
}

/** 읽음 처리: 서버 커서와 로컬 배지를 함께 갱신한다. */
export async function markSeen(roomId: string, seq: number): Promise<void> {
  useWorld.getState().clearUnread(roomId);
  try {
    await api.seen(roomId, seq);
  } catch {
    /* 다음 이벤트 때 다시 시도 */
  }
}
