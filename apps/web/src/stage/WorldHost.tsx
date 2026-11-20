import { Component, Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AMBIENCE_STAGES, type AmbienceStage, type WorldRoom } from '@ensemble/shared';
import { useWorld } from '../store/worldStore';
import { useActivity } from '../store/activityStore';
import { useRooms } from '../store/roomStore';
import { collectTripHints, deriveFocusCharacters, deriveLightCharacters, mergeCharacters } from '../world/agents/derive';
import { useSession } from '../store/session';
import { usePath } from '../router';
import { useStage } from './stageStore';
import { setFxSuppressed } from '../fx/fxStore';
import { wsClient } from '../api/ws';

/** 이 세션에서 월드 인트로를 이미 봤는가(탭당 1회). `?intro=1`이면 항상 */
let introDecision: boolean | null = null;
function shouldIntro(): boolean {
  if (introDecision !== null) return introDecision;
  introDecision = decideIntro();
  return introDecision;
}
function decideIntro(): boolean {
  try {
    if (new URLSearchParams(location.search).get('intro') === '1') return true;
    if (new URLSearchParams(location.search).get('intro') === '0') return false;
    if (sessionStorage.getItem('ensemble.intro')) return false;
    sessionStorage.setItem('ensemble.intro', '1');
    return true;
  } catch {
    return false;
  }
}

// three/R3F 번들은 이 lazy 청크에서만 로드된다.
const WorldCanvas = lazy(() => import('../world/WorldCanvas').then((m) => ({ default: m.WorldCanvas })));

class WorldBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(err: unknown) {
    console.warn('[world] 3D 렌더 오류, 2D 폴백으로 전환', err);
    useStage.getState().setWebgl('error');
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** slotEl의 화면 사각형을 추적한다 (리사이즈·스크롤·레이아웃 변화) */
export function useRect(el: HTMLElement | null): { left: number; top: number; width: number; height: number } | null {
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  useEffect(() => {
    if (!el) {
      setRect(null);
      return;
    }
    const update = () => {
      const r = el.getBoundingClientRect();
      setRect((p) =>
        p && p.left === r.left && p.top === r.top && p.width === r.width && p.height === r.height
          ? p
          : { left: r.left, top: r.top, width: r.width, height: r.height },
      );
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    ro.observe(document.documentElement);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [el]);
  return rect;
}

const NO_ROOMS: WorldRoom[] = [];

/** 탭이 숨겨지면 true: 3D 렌더 루프를 멈춘다 */
function useHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  useEffect(() => {
    const on = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return hidden;
}

function useReducedMotion(): boolean {
  const [r, setR] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setR(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return r;
}

/**
 * 앱 루트에 한 번만 마운트되는 3D 월드. 라우트가 바뀌어도 언마운트되지 않는다.
 * 메신저: 전체 화면 조감(뒤에 깔림). Room 화면: 포커스 캡슐이 RoomStage 슬롯 사각형에 보인다.
 */
export function WorldHost() {
  const path = usePath();
  const viewerId = useSession((s) => s.user?.id);
  const loaded = useWorld((s) => s.loaded);
  const rooms = useWorld((s) => s.rooms);
  const order = useWorld((s) => s.roomOrder);
  const users = useWorld((s) => s.users);
  const selected = useWorld((s) => s.selectedRoomId);
  const webgl = useStage((s) => s.webgl);
  const quality = useStage((s) => s.quality);
  const slotEl = useStage((s) => s.slotEl);
  const ambienceOverrides = useStage((s) => s.ambienceOverrides);
  const roomId = path.startsWith('/room/') ? decodeURIComponent(path.slice('/room/'.length)) : null;
  const inRoom = roomId !== null && !!rooms[roomId];
  const slotRect = useRect(slotEl);
  // band: 메신저의 가운데 무대 띠. 월드는 화면 폭 전체에 깔리고 높이만 띠의 아래끝까지(양옆 패널 뒤로 이어진다)
  const rect =
    slotRect && slotEl?.dataset.worldSlot === 'band'
      ? { left: 0, top: 0, width: document.documentElement.clientWidth, height: slotRect.top + slotRect.height }
      : slotRect;

  const hidden = useHidden();
  const intro = useMemo(shouldIntro, []);
  const reducedMotion = useReducedMotion();
  const focusModel = useStage((s) => s.focusModel);
  const activity = useActivity((s) => s.byKey);
  const roomSlices = useRooms((s) => s.rooms);
  const myAgent = useWorld((s) => s.myAgent);
  const tripHints = useMemo(() => collectTripHints(roomSlices), [roomSlices]);
  const focusId = inRoom ? roomId : null;
  const characters = useMemo(() => {
    if (!loaded || !viewerId) return undefined;
    const roomArr = order.map((id) => rooms[id]).filter((r): r is WorldRoom => !!r);
    const focus = focusModel && focusModel.roomId === focusId ? deriveFocusCharacters(focusModel, activity) : [];
    const light = deriveLightCharacters(roomArr, users, viewerId, myAgent, focus.length || (focusModel && focusModel.roomId === focusId) ? focusId : null, tripHints);
    return { characters: mergeCharacters(focus, light), replaying: !!(focusModel && focusModel.roomId === focusId && focusModel.replaying) };
  }, [loaded, viewerId, order, rooms, users, focusModel, focusId, activity, myAgent, tripHints]);

  // 타임라인 재생 중에는 과거 사건이 연출로 터지지 않게 억제한다(8.5)
  const replaying = !!(focusModel && focusModel.roomId === focusId && focusModel.replaying);
  useEffect(() => {
    setFxSuppressed(replaying);
    return () => setFxSuppressed(false);
  }, [replaying]);

  const roomList = useMemo(() => (loaded ? order.map((id) => rooms[id]).filter((r): r is WorldRoom => !!r) : NO_ROOMS), [loaded, order, rooms]);

  if (!loaded || !viewerId || webgl !== 'ok' || quality === 'off' || roomList.length === 0) return null;

  const style: React.CSSProperties = rect
    ? { position: 'fixed', zIndex: 0, left: rect.left, top: rect.top, width: rect.width, height: rect.height, overflow: 'hidden' }
    : { position: 'fixed', zIndex: 0, inset: 0, overflow: 'hidden' };

  const ambience = Object.fromEntries(
    Object.entries(ambienceOverrides).filter(([, s]) => (AMBIENCE_STAGES as readonly string[]).includes(s)),
  ) as Record<string, AmbienceStage>;

  return (
    <div aria-hidden="true" data-testid="world-host" data-focus={inRoom ? roomId : ''} data-selected={selected ?? ""} data-chars={(characters?.characters ?? []).map((c) => `${c.id}@${c.roomId ?? "tube"}:${c.activity}`).join(",")} style={style}>
      <WorldBoundary>
        <Suspense fallback={null}>
          <WorldCanvas
            viewerId={viewerId}
            rooms={roomList}
            users={users}
            selectedRoomId={selected}
            focusRoomId={inRoom ? roomId : null}
            quality={quality}
            characters={characters}
            paused={hidden}
            reducedMotion={reducedMotion}
            intro={intro}
            onCursor={(c) => wsClient.sendCursor(c.x, c.y, c.z, null)}
            ambienceOverrides={Object.keys(ambience).length ? ambience : undefined}
            onSelectRoom={(id) => {
              // 빈 곳 클릭(null)은 무시한다: 메신저는 항상 선택이 있고, Room 화면의 대상은 경로가 정한다.
              if (id && !inRoom && rooms[id]) useWorld.getState().select(id);
            }}
            onHoverRoom={(id) => useStage.getState().setHover(id)}
          />
        </Suspense>
      </WorldBoundary>
    </div>
  );
}
