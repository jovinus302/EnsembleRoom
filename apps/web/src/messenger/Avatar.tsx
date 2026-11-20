import { useState } from 'react';
import { portraitDataUrl } from '../avatar/portrait';
import { ink } from '../theme';

/**
 * 사람 아바타: 원형 프로필 초상(이름 시드의 절차 생성 일러스트, avatar/portrait.ts). 이미지 실패 시 이니셜.
 * shape="agent"(각진 이니셜)는 알 수 없는 작성자 폴백용. Agent는 AgentAvatar(각진/육각 프레임 + ✦ 표식)를 쓴다.
 */
export function Avatar({
  name,
  color,
  size = 32,
  shape = 'circle',
}: {
  name: string;
  color: string;
  size?: number;
  shape?: 'circle' | 'agent';
}) {
  const [failed, setFailed] = useState(false);
  if (shape === 'circle' && !failed) {
    return (
      <span
        aria-hidden="true"
        data-testid="human-portrait"
        className="inline-flex shrink-0 overflow-hidden select-none"
        style={{ width: size, height: size, background: color, borderRadius: '50%' }}
      >
        <img
          src={portraitDataUrl(name, color)}
          alt=""
          draggable={false}
          className="h-full w-full"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center font-semibold text-[var(--on-accent)] select-none"
      style={{
        width: size,
        height: size,
        background: color,
        fontSize: size * 0.42,
        borderRadius: shape === 'circle' ? '50%' : size * 0.32,
      }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const PERSONAL_IMAGES = ['personal-beret', 'personal-code', 'personal-goggles'];
const ROOM_IMAGES = ['room-chat', 'room-goggles', 'room-halo'];

/** 3D와 같은 시각 언어: Personal Agent = 각진(팔각) 프레임, Room Agent = 육각 프레임. 색이 아니라 모양과 ✦ 표식으로 사람과 구분한다. */
const OCTAGON = 'polygon(28% 0, 72% 0, 100% 28%, 100% 72%, 72% 100%, 28% 100%, 0 72%, 0 28%)';
const HEXAGON = 'polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)';

/** 작은 ✦ 표식 배지. Agent 아바타 모서리에 붙는다. */
function StarMark({ size, color }: { size: number; color: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid="agent-star"
      className="absolute flex items-center justify-center rounded-full font-bold leading-none select-none"
      style={{
        right: -size * 0.12,
        bottom: -size * 0.12,
        width: size,
        height: size,
        background: 'var(--on-accent)',
        border: `1.5px solid ${color}`,
        color: '#fff',
        fontSize: size * 0.62,
      }}
    >
      ✦
    </span>
  );
}

/** "✦ Agent" / "✦ Room Agent" 각진 이름표. 사람 이름은 둥근 칩/원형 아바타라 모양으로 구분된다. */
export function AgentTag({ color, room = false }: { color: string; room?: boolean }) {
  return (
    <span
      data-testid="agent-tag"
      className="inline-flex items-center gap-0.5 rounded-[3px] border px-1 text-[10px] font-semibold leading-4"
      style={{ borderColor: color, color: ink(color) }}
    >
      <span aria-hidden="true">✦</span>
      {room ? 'Room Agent' : 'Agent'}
    </span>
  );
}

/**
 * Agent 아바타. 캐릭터 PNG는 흰 배경이라, 밝은 중립 배경 위에 그대로 올리고
 * 소유자 색(Room Agent는 라임)은 프레임 테두리로만 쓴다. 블렌드 모드를 쓰지 않아 캐릭터 본래 색이 유지된다.
 */
export function AgentAvatar({
  variant,
  color,
  size = 40,
  name,
  room = false,
}: {
  variant: string | null | undefined;
  /** 프레임 색: Personal은 소유자 색, Room Agent는 라임 */
  color: string;
  size?: number;
  name?: string;
  room?: boolean;
}) {
  const key = `${room ? 'room' : 'personal'}-${variant ?? ''}`;
  const list = room ? ROOM_IMAGES : PERSONAL_IMAGES;
  const file = list.includes(key) ? key : room ? 'room-chat' : 'personal-beret';
  const ring = Math.max(2, Math.round(size / 12));
  const clip = room ? HEXAGON : OCTAGON;
  return (
    <span
      role="img"
      aria-label={name ?? 'Agent'}
      data-testid="agent-avatar"
      data-shape={room ? 'hexagon' : 'octagon'}
      className="relative inline-block shrink-0"
      style={{ width: size, height: size }}
    >
      <span className="absolute inset-0" style={{ background: color, clipPath: clip }} />
      <span className="absolute overflow-hidden" style={{ inset: ring, background: 'var(--avatar-paper)', clipPath: clip }}>
        <img src={`/assets/avatars/${file}.png`} alt="" draggable={false} className="h-full w-full object-cover" />
      </span>
      <StarMark size={Math.max(12, Math.round(size * 0.38))} color={color} />
    </span>
  );
}
