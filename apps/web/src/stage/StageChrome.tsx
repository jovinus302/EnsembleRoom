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
  // 3D 창(슬롯)의 오른쪽 아래에 붙는다. 슬롯이 없으면 화면 왼쪽 아래
  const pos: React.CSSProperties = slotRect
    ? { left: slotRect.left + slotRect.width - 8, top: slotRect.top + slotRect.height - 8, transform: 'translate(-100%, -100%)' }
    : { left: 8, bottom: 8 };
  return (
    <div
      role="group"
      aria-label="3D 품질"
      data-testid="quality-toggle"
      className="fixed z-30 flex items-center gap-0.5 rounded-full border border-line bg-panel px-1.5 py-1 text-[10px] text-muted backdrop-blur"
      style={pos}
    >
      {webgl === 'ok' && quality !== 'off' ? (
        <button
          type="button"
          data-testid="view-reset"
          disabled={!orbitDirty}
          title="드래그로 각도, 휠로 줌. 더블클릭하면 초기화돼요"
          onClick={() => useOrbit.getState().reset()}
          className={`rounded-full px-1.5 py-0.5 ${orbitDirty ? 'bg-[var(--focus)] text-[var(--accent-fg)]' : 'opacity-40'}`}
        >
          시점 초기화
        </button>
      ) : null}
      <span className="px-1">{webgl === 'ok' ? '3D' : webgl === 'error' ? '3D 오류' : 'WebGL2 없음'}</span>
      {QUALITY_SETTINGS.map((q) => (
        <button
          key={q}
          type="button"
          data-testid={`quality-${q}`}
          aria-pressed={quality === q}
          onClick={() => useStage.getState().setQuality(q)}
          className={`rounded-full px-1.5 py-0.5 ${quality === q ? 'bg-accent text-[var(--on-accent-strong)]' : 'hover:text-fg'}`}
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
  return (
    <div
      role="tooltip"
      data-testid="world-hover-tip"
      className="pointer-events-none fixed z-30 rounded-md border border-line bg-panel px-2.5 py-1.5 text-xs backdrop-blur"
      style={{ left: pos.x + 14, top: pos.y + 14 }}
    >
      <div className="font-semibold">{titleOf(room, meId, users)}</div>
      <div className="text-muted">
        조명 {AMBIENCE_LABEL[room.preview.ambience] ?? room.preview.ambience} · {room.preview.glass === 'clear' ? '유리 투명' : room.preview.glass === 'agent' ? '유리 Agent 시야' : '유리 서리'}
        {pending > 0 ? ` · 승인 대기 ${pending}` : ''}
        {room.preview.detail ? ` · 놓친 변화 ${room.preview.detail.missedChanges}` : ''}
      </div>
    </div>
  );
}
