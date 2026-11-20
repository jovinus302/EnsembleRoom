import { WORLD_FONT, WorldText } from '../text';
import type { CapsuleDims } from './dims';

export const SIGN_FONT = WORLD_FONT;

/**
 * 간판: 원목 받침 앞면에 새긴 이름(서리 유리여도 읽힌다). 좌표는 캡슐 내부 좌표계(바닥 윗면 원점).
 * 소유자 색 점을 앞에 단다.
 */
export function RoomSign({ label, color, colors, dims, hover }: { label: string; color: string; colors?: readonly string[]; dims: CapsuleDims; hover: number }) {
  const base = dims.floorHeight - 0.48;
  const y = -(dims.floorHeight + 0.48) / 2;
  const z = dims.baseHalfDepth + 0.012;
  const size = dims.proportion === 'plump' ? 0.5 : 0.4;
  const dotX = -Math.min(label.length * size * 0.28 + 0.3, dims.length / 2 - 0.2);
  return (
    <group position={[0, y, z]} scale={1 + hover * 0.08}>
      {colors && colors.length >= 2 ? (
        colors.slice(0, 6).map((c, i, arr) => (
          <mesh key={i} position={[dotX - (arr.length - 1) * size * 0.5 + i * size * 0.5, 0, 0.005]}>
            <circleGeometry args={[size * 0.2, 20]} />
            <meshBasicMaterial color={c} toneMapped={false} />
          </mesh>
        ))
      ) : (
        <mesh position={[dotX, 0, 0.005]}>
          <circleGeometry args={[size * 0.28, 24]} />
          <meshBasicMaterial color={color} toneMapped={false} />
        </mesh>
      )}
      <WorldText
        fontSize={Math.min(size, base * 0.55)}
        anchorX="center"
        anchorY="middle"
        position={[size * 0.2, 0, 0.01]}
        color="#fff2dc"
        outlineWidth={size * 0.03}
        outlineColor="#3a2414"
        maxWidth={dims.length * 0.9}
      >
        {label}
      </WorldText>
    </group>
  );
}
