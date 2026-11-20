/**
 * 피드백 레이어의 단일 진입점 (계획 8.7 "인과 궤적", S19a).
 * 영속 이벤트(ws 브리지)와 UI 행동(호버·클릭·전송)이 모두 `emit(kind, payload)`를 거친다.
 * 3D(world/fx)와 DOM(stage/FxOverlay)은 `onFx`로 구독해 같은 사건에 각자 반응한다.
 * three를 끌어오지 않는 순수 모듈이다(메인 번들에서 써도 안전).
 *
 * 과함 방지(8.7): 우선순위 L1 승인 > L2 Agent 행동 > L3 분위기·커서.
 *  - L1이 활성이면 L3 강도 30%, 블룸 낮춤. L2는 동시 2개까지 250ms 간격으로 순차 재생하고 L3 50%.
 *  - 타임라인 재생 중(`setFxSuppressed(true)`)에는 과거 이벤트를 전부 버린다.
 */

export type FxKind =
  // L1: 승인 (결과가 큰 순간)
  | 'approval_requested'
  | 'approval_resolved'
  | 'agreement'
  // L2: Agent 행동과 관계 변화
  | 'message'
  | 'send_local'
  | 'agent_called'
  | 'memory'
  | 'visit_request'
  | 'visit_accept'
  | 'visit_end'
  | 'leave'
  | 'rejoin'
  | 'agent_depart'
  | 'agent_arrive'
  | 'agent_return'
  | 'agent_paused'
  | 'error'
  // L3: 분위기·커서
  | 'hover'
  | 'click'
  | 'drag';

export type FxPriority = 1 | 2 | 3;

export const FX_PRIORITY: Readonly<Record<FxKind, FxPriority>> = {
  approval_requested: 1,
  approval_resolved: 1,
  agreement: 1,
  message: 2,
  send_local: 2,
  agent_called: 2,
  memory: 2,
  visit_request: 2,
  visit_accept: 2,
  visit_end: 2,
  leave: 2,
  rejoin: 2,
  agent_depart: 2,
  agent_arrive: 2,
  agent_return: 2,
  agent_paused: 2,
  error: 2,
  hover: 3,
  click: 3,
  drag: 3,
};

export interface FxPayload {
  /** 사건이 일어난 캡슐 */
  roomId?: string | null;
  /** 캡슐 사이를 오가는 연출(튜브 경로)의 양 끝 */
  fromRoomId?: string | null;
  toRoomId?: string | null;
  /** 행위자 캐릭터 id (사람은 `h:<userId>`, Agent는 agentId) */
  actorId?: string | null;
  /** 수신·대상 캐릭터 id */
  targetId?: string | null;
  /** 내가 일으킨 사건인가(카메라 미세 이동 조건) */
  mine?: boolean;
  /** 내가 승인자인가 등: 나와 관련 있는가 */
  involvesMe?: boolean;
  color?: string;
  colors?: string[];
  /** 같은 key는 4초 안에 한 번만 재생한다(낙관적 입력과 원격 이벤트의 중복 방지) */
  key?: string;
  outcome?: string;
  text?: string;
  count?: number;
  /** click/drag: 화면 좌표(px) */
  screen?: [number, number];
}

export interface FxEvent extends FxPayload {
  id: number;
  kind: FxKind;
  priority: FxPriority;
  /** 발생 시각(performance.now) */
  t: number;
  /** 발생 시점의 L3 강도(1, 0.5, 0.3). L1·L2는 항상 1 */
  gain: number;
}

const L1_MS = 2600;
const L2_MS = 1500;
const L2_GAP_MS = 250;
const L2_MAX = 2;
const KEY_TTL_MS = 4000;
const QUEUE_MAX = 8;

let seq = 1;
let suppressed = false;
let l1Until = 0;
let lastL2At = -1e9;
let l2Ends: number[] = [];
let queue: FxEvent[] = [];
let pumpTimer: ReturnType<typeof setTimeout> | null = null;
const seen = new Map<string, number>();
const listeners = new Set<(e: FxEvent) => void>();
const stats: Record<string, number> = {};

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** 타임라인 재생 중에는 휘발성 연출(과거 이벤트의 폭죽)을 끈다 */
export function setFxSuppressed(v: boolean): void {
  suppressed = v;
  if (v) {
    queue = [];
    l1Until = 0;
    l2Ends = [];
  }
}
export const isFxSuppressed = () => suppressed;

export interface FxLevel {
  l1: boolean;
  l2: number;
  /** L3(커서·분위기) 강도 배율 */
  l3Gain: number;
  /** 블룸 배율 */
  bloom: number;
}

export function fxLevel(): FxLevel {
  const t = nowMs();
  const l1 = t < l1Until;
  const l2 = l2Ends.filter((e) => e > t).length;
  return { l1, l2, l3Gain: l1 ? 0.3 : l2 > 0 ? 0.5 : 1, bloom: l1 ? 0.55 : 1 };
}

function dispatch(ev: FxEvent): void {
  const t = nowMs();
  ev.t = t;
  ev.gain = ev.priority === 3 ? fxLevel().l3Gain : 1;
  if (ev.priority === 1) l1Until = Math.max(l1Until, t + L1_MS);
  else if (ev.priority === 2) {
    l2Ends.push(t + L2_MS);
    lastL2At = t;
  }
  stats[ev.kind] = (stats[ev.kind] ?? 0) + 1;
  for (const l of listeners) {
    try {
      l(ev);
    } catch (err) {
      console.warn('[fx] listener error', err);
    }
  }
}

function pump(): void {
  pumpTimer = null;
  const t = nowMs();
  l2Ends = l2Ends.filter((e) => e > t);
  while (queue.length && l2Ends.length < L2_MAX && t - lastL2At >= L2_GAP_MS) {
    dispatch(queue.shift()!);
  }
  if (queue.length) {
    const wait = Math.max(30, L2_GAP_MS - (nowMs() - lastL2At), l2Ends.length >= L2_MAX ? Math.min(...l2Ends) - nowMs() : 0);
    pumpTimer = setTimeout(pump, wait);
  }
}

/** 단일 진입점. 재생이 억제됐거나 중복이면 false */
export function emit(kind: FxKind, payload: FxPayload = {}): boolean {
  if (suppressed) return false;
  const t = nowMs();
  if (payload.key) {
    const k = `${kind}|${payload.key}`;
    const prev = seen.get(k);
    if (prev !== undefined && t - prev < KEY_TTL_MS) return false;
    seen.set(k, t);
    if (seen.size > 200) for (const [kk, v] of seen) if (t - v > KEY_TTL_MS) seen.delete(kk);
  }
  const priority = FX_PRIORITY[kind];
  // 숨은 탭에서는 쌓이지 않게 L1만 남긴다
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && priority !== 1) return false;
  const ev: FxEvent = { ...payload, id: seq++, kind, priority, t, gain: 1 };
  if (priority === 2) {
    queue.push(ev);
    if (queue.length > QUEUE_MAX) queue.shift();
    if (!pumpTimer) pump();
    return true;
  }
  dispatch(ev);
  return true;
}

export function onFx(fn: (e: FxEvent) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 검증용: 종류별 재생 횟수 */
export function fxStats(): Readonly<Record<string, number>> {
  return stats;
}

/* ---------------- 상대 커서(휘발성 cursor 채널) ---------------- */

export interface RemoteCursor {
  userId: string;
  /** 인코딩된 값 그대로(world/fx/cursorCodec가 해석한다) */
  x: number;
  y: number;
  z: number;
  roomId: string | null;
  at: number;
}
const cursors = new Map<string, RemoteCursor>();
export function setRemoteCursor(c: Omit<RemoteCursor, 'at'>): void {
  cursors.set(c.userId, { ...c, at: nowMs() });
}
export function getRemoteCursors(maxAgeMs = 1800): RemoteCursor[] {
  const t = nowMs();
  const out: RemoteCursor[] = [];
  for (const [id, c] of cursors) {
    if (t - c.at > maxAgeMs) {
      if (t - c.at > 20000) cursors.delete(id);
      continue;
    }
    out.push(c);
  }
  return out;
}
export function clearRemoteCursors(): void {
  cursors.clear();
}

/* ---------------- 포인터 ---------------- */

/** window 수준 포인터 좌표: 캔버스가 DOM 패널 뒤에 있어도 좌표를 놓치지 않는다 */
export const pointer = { x: -1, y: -1, seen: false, down: false, dragging: false, downX: 0, downY: 0, moved: 0, lastMove: 0 };

let tracking = 0;
let detach: (() => void) | null = null;
export function startPointerTracking(): () => void {
  tracking++;
  if (tracking === 1) {
    const move = (e: PointerEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.seen = true;
      pointer.lastMove = nowMs();
      if (pointer.down && Math.hypot(e.clientX - pointer.downX, e.clientY - pointer.downY) > 6 && !pointer.dragging) {
        pointer.dragging = true;
        emit('drag', { screen: [e.clientX, e.clientY] });
      }
    };
    const down = (e: PointerEvent) => {
      pointer.down = true;
      pointer.dragging = false;
      pointer.downX = e.clientX;
      pointer.downY = e.clientY;
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.seen = true;
    };
    const up = (e: PointerEvent) => {
      if (pointer.down && !pointer.dragging) emit('click', { screen: [e.clientX, e.clientY] });
      pointer.down = false;
      pointer.dragging = false;
    };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerdown', down, { passive: true });
    window.addEventListener('pointerup', up, { passive: true });
    window.addEventListener('pointercancel', up, { passive: true });
    detach = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }
  return () => {
    tracking--;
    if (tracking === 0) {
      detach?.();
      detach = null;
    }
  };
}

declare global {
  interface Window {
    __fx?: { emit: typeof emit; stats: typeof fxStats; level: typeof fxLevel };
  }
}
if (typeof window !== 'undefined') window.__fx = { emit, stats: fxStats, level: fxLevel };
