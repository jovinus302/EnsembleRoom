/** 이름 첫 글자를 색 원 안에 그린다. 사람은 원, Agent는 둥근 사각형으로 구분한다. */
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
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center font-semibold text-[#0b1020] select-none"
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

/**
 * Agent 아바타. 캐릭터 PNG는 흰 배경이라, 밝은 중립 원형 배경 위에 그대로 올리고
 * 소유자 색(Room Agent는 라임)은 바깥 링으로만 쓴다. 블렌드 모드를 쓰지 않아 캐릭터 본래 색이 유지된다.
 */
export function AgentAvatar({
  variant,
  color,
  size = 40,
  name,
  room = false,
}: {
  variant: string | null | undefined;
  /** 링 색: Personal은 소유자 색, Room Agent는 라임 */
  color: string;
  size?: number;
  name?: string;
  room?: boolean;
}) {
  const key = `${room ? 'room' : 'personal'}-${variant ?? ''}`;
  const list = room ? ROOM_IMAGES : PERSONAL_IMAGES;
  const file = list.includes(key) ? key : room ? 'room-chat' : 'personal-beret';
  const ring = Math.max(2, Math.round(size / 16));
  return (
    <span
      role="img"
      aria-label={name ?? 'Agent'}
      data-testid="agent-avatar"
      className="inline-block shrink-0 overflow-hidden rounded-full"
      style={{
        width: size,
        height: size,
        background: '#f4f7fd',
        boxShadow: `0 0 0 ${ring}px ${color}`,
      }}
    >
      <img src={`/assets/avatars/${file}.png`} alt="" draggable={false} className="h-full w-full object-cover" />
    </span>
  );
}
