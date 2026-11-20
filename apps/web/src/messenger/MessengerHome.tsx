import { useStage } from '../stage/stageStore';
import { useSession } from '../store/session';
import { useWorld } from '../store/worldStore';
import { ConversationView } from './ConversationView';
import { RoomPreviewPanel } from './RoomPreviewPanel';
import { TourHost } from '../onboarding/Tour';
import { Sidebar } from './Sidebar';

/**
 * 데스크톱 3단: 좌 사이드바 / 가운데 대화 / 우 Room 미리보기.
 * 뒤에 App 루트의 WorldCanvas(해변 조감)가 깔리고, 각 패널 배경은 --panel-opacity(index.css)로만 제어한다.
 * 컨테이너는 pointer-events-none, 패널만 auto: 투명 창(world-strip)을 통해 3D 캡슐을 클릭·호버할 수 있다.
 */
export function MessengerHome() {
  const loaded = useWorld((s) => s.loaded);
  const selected = useWorld((s) => s.selectedRoomId);
  const meId = useSession((s) => s.user?.id);
  // 3D에서 남의 서리 낀 캡슐을 고르면 대화(스냅샷)는 403이므로 열지 않고 안내만 보여 준다.
  const lockedRoom = useWorld((s) => {
    const r = s.selectedRoomId ? s.rooms[s.selectedRoomId] : undefined;
    return r && r.kind === 'my' && r.ownerId !== meId && r.preview.glass !== 'clear' ? r : undefined;
  });

  return (
    <div className="pointer-events-none flex h-full min-w-[1000px]">
      <Sidebar />
      <main className="pointer-events-none flex min-w-0 flex-1 flex-col">
        {/* 뒤의 3D 월드(해변 조감)가 그대로 보이고 캡슐을 클릭·호버할 수 있는 투명 창 */}
        <div
          data-world-slot="band"
          data-testid="world-strip"
          className="pointer-events-none min-h-[200px] flex-1"
          ref={(el) => {
            useStage.getState().setSlotEl(el);
            return () => useStage.getState().setSlotEl(null);
          }}
        />
        <div className="pointer-events-auto flex h-[46%] min-h-[320px] shrink-0">
          {!loaded && <p className="m-auto text-sm text-muted">불러오는 중…</p>}
          {loaded && selected && lockedRoom && (
            <p className="m-auto px-6 text-center text-sm text-muted" data-testid="locked-room">
              이 Room은 유리가 서리 낀 상태예요. 방문이 수락되면 안을 볼 수 있어요. 오른쪽에서 방문을 요청하세요.
            </p>
          )}
          {loaded && selected && !lockedRoom && <ConversationView key={selected} roomId={selected} />}
          {loaded && !selected && <p className="m-auto text-sm text-muted">대화를 선택하세요.</p>}
        </div>
      </main>
      {loaded && selected && <RoomPreviewPanel roomId={selected} />}
      <TourHost id="home" ready={loaded && !!selected} />
    </div>
  );
}
