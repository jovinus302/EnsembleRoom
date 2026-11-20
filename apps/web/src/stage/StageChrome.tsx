import { useEffect, useState } from 'react';
import { AMBIENCE_LABEL, titleOf } from '../messenger/labels';
import { useSession } from '../store/session';
import { useWorld } from '../store/worldStore';
import { useRect } from './WorldHost';
import { useOrbit } from '../world/cameraOrbit';
import { QUALITY_SETTINGS, useStage, type QualitySetting } from './stageStore';

const LABEL: Record<QualitySetting, string> = { auto: '자동', high: '높음', mid: '중간', low: '낮음', off: '2D' };

/** 화면 구석의 작은 3D 품질 토글 (auto/high/mid/low, 2D = 3D 끄기). 설정은 localStorage에 저장된다. */
export function QualityToggle() {
  const quality = useStage((s) => s.quality);
  const webgl = useStage((s) => s.webgl);
  const orbitDirty = useOrbit((s) => s.dirty);
  const slotRect = useRect(useStage((s) => s.slotEl));
  // 아주 좁은 3D 창(범례 pill과 한 줄을 나눈다)에서는 "3D" 표시와 버튼 글자를 줄인다
  const narrow = !!slotRect && slotRect.width < 480;
  // 3D 창(슬롯)의 오른쪽 아래에 붙는다. 슬롯이 없으면 화면 왼쪽 아래
  const pos: React.CSSProperties = slotRect
    ? { left: slotRect.left + slotRect.width - 8, top: slotRect.top + slotRect.height - 8, transform: 'translate(-100%, -100%)' }
    : { left: 8, bottom: 8 };
  return (
    <div
      role="group"
      aria-label="3D 품질"
      data-testid="quality-toggle"
      className="tg-seg tg-solid tg-over-seg pointer-events-auto fixed z-30 items-center"
      style={pos}
    >
      {webgl === 'ok' && quality !== 'off' ? (
        <button
          type="button"
          data-testid="view-reset"
          disabled={!orbitDirty}
          title="드래그로 각도, 휠로 줌. 더블클릭하면 초기화돼요"
          aria-label="시점 초기화"
          onClick={() => useOrbit.getState().reset()}
          className="tg-over-reset"
        >
          {narrow ? '↺' : '시점 초기화'}
        </button>
      ) : null}
      {!(narrow && webgl === 'ok') && <span className="tg-mono px-1.5">{webgl === 'ok' ? '3D' : webgl === 'error' ? '3D 오류' : 'WebGL2 없음'}</span>}
      {QUALITY_SETTINGS.map((q) => (
        <button
          key={q}
          type="button"
          data-testid={`quality-${q}`}
          aria-pressed={quality === q}
          onClick={() => useStage.getState().setQuality(q)}
        >
          {LABEL[q]}
        </button>
      ))}
    </div>
  );
}

/** 3D 캡슐 호버 미리보기: 이름, 조명 단계, 승인 대기. 포인터를 따라다닌다. */
export function HoverTip() {
  const hoverId = useStage((s) => s.hoverRoomId);
  const room = useWorld((s) => (hoverId ? s.rooms[hoverId] : undefined));
  const users = useWorld((s) => s.users);
  const meId = useSession((s) => s.user?.id);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (!hoverId) return;
    const on = (e: PointerEvent) => setPos({ x: e.clientX, y: e.clientY });
    window.addEventListener('pointermove', on);
    return () => window.removeEventListener('pointermove', on);
  }, [hoverId]);
  if (!room || !meId) return null;
  const pending = room.preview.detail?.pendingApprovals ?? 0;
  // 화면 위쪽 가장자리에서는 툴팁을 포인터 아래로 뒤집는다(꼬리는 숨김)
  const below = pos.y < 90;
  return (
    <div
      role="tooltip"
      data-testid="world-hover-tip"
      className={`tg-tip tg-solid pointer-events-none fixed z-30${below ? ' below' : ''}`}
      style={below ? { left: pos.x - 25, top: pos.y + 18 } : { left: pos.x - 25, top: pos.y - 14, transform: 'translateY(-100%)' }}
    >
      <div className="font-semibold">{titleOf(room, meId, users)}</div>
      <div className="tg-aux">
        조명 {AMBIENCE_LABEL[room.preview.ambience] ?? room.preview.ambience} · {room.preview.glass === 'clear' ? '유리 투명' : room.preview.glass === 'agent' ? '유리 Agent 시야' : '유리 서리'}
        {pending > 0 ? ` · 승인 대기 ${pending}` : ''}
        {room.preview.detail ? ` · 놓친 변화 ${room.preview.detail.missedChanges}` : ''}
      </div>
    </div>
  );
}
