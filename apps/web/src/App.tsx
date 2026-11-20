import { useEffect } from 'react';
import { wsClient } from './api/ws';
import { navigate, usePath } from './router';
import { useSession } from './store/session';
import { useWorld } from './store/worldStore';
import { useRooms } from './store/roomStore';
import { Login } from './pages/Login';
import { MetricsPage } from './pages/Metrics';
import { MessengerHome } from './messenger/MessengerHome';
import { RejoinDigest } from './room/RejoinDigest';
import { RoomView } from './room/RoomView';
import { useApprovalInbox } from './store/approvalStore';
import { WorldHost } from './stage/WorldHost';
import { HoverTip, QualityToggle } from './stage/StageChrome';
import { FxOverlay, WorldLegend } from './stage/FxOverlay';
import { useWorldActive } from './stage/stageStore';
import { usePerf } from './world/quality';

function Placeholder({ title, step }: { title: string; step: string }) {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-3 text-muted">
      <h1 className="text-xl text-fg">{title}</h1>
      <p className="text-sm">{step}에서 구현됩니다.</p>
      <button type="button" className="rounded-md border border-line px-3 py-1.5 text-sm text-fg" onClick={() => navigate('/')}>
        메신저로 돌아가기
      </button>
    </main>
  );
}

export function App() {
  const path = usePath();
  const status = useSession((s) => s.status);
  const worldActive = useWorldActive();
  const tier = usePerf((s) => s.tier);

  useEffect(() => {
    void useSession.getState().init();
  }, []);

  // 로그인 상태에 맞춰 월드 로드와 WS 연결을 켜고 끈다.
  useEffect(() => {
    if (status === 'authed') {
      void useWorld.getState().load();
      wsClient.connect();
      return () => {
        wsClient.disconnect();
        useWorld.getState().reset();
        useRooms.getState().reset();
        useApprovalInbox.getState().reset();
      };
    }
  }, [status]);

  // 품질 단계를 <html data-quality>로 내보낸다(tide.css가 패널 blur를 단계별로 조절).
  // Sheet 등은 body로 portal되므로 App의 div가 아니라 html에 건다.
  useEffect(() => {
    const el = document.documentElement;
    el.dataset.quality = worldActive ? tier : 'off';
    return () => {
      delete el.dataset.quality;
    };
  }, [worldActive, tier]);

  // 인증 가드
  useEffect(() => {
    if (status === 'anonymous' && path !== '/login') navigate('/login', true);
    if (status === 'authed' && path === '/login') navigate('/', true);
  }, [status, path]);

  if (status === 'init') {
    return <main className="flex h-full items-center justify-center text-muted">불러오는 중…</main>;
  }
  if (status === 'anonymous') return <Login />;

  if (path === '/lab') return <Placeholder title="Scene Lab" step="S18" />;
  if (path === '/metrics') return <MetricsPage />;
  const roomId = path.startsWith('/room/') ? decodeURIComponent(path.slice('/room/'.length)) : null;
  // WorldCanvas는 여기 한 번만 마운트된다(라우트가 바뀌어도 유지). DOM 패널은 z-10으로 그 위에 겹친다.
  // 패널 투명도는 화면별 --panel-opacity(index.css)로만 조절한다.
  return (
    <>
      <WorldHost />
      <div className="pointer-events-none relative z-10 h-full" data-screen={roomId ? 'room' : 'messenger'} data-world={worldActive ? 'on' : 'off'}>
        {roomId ? <RoomView key={roomId} roomId={roomId} /> : <MessengerHome />}
        <div className="pointer-events-auto">
          <RejoinDigest />
        </div>
      </div>
      <HoverTip />
      <QualityToggle />
      <WorldLegend />
      <FxOverlay />
    </>
  );
}
