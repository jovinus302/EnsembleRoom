import { useMemo } from 'react';
import * as THREE from 'three';
import { stadiumSlab } from './geometry';
import type { CapsuleDims } from './dims';

/** S17 전까지 캡슐 안이 비어 보이지 않도록 두는 임시 세트: 러그, 탁자, 의자 대용 원통 */
export function PlaceholderInterior({ dims, color, seats }: { dims: CapsuleDims; color: string; seats: number }) {
  const rug = useMemo(
    () => stadiumSlab(dims.floorHalfLength - 0.9, dims.floorHalfDepth - 0.55, 0.005, 0.03),
    [dims],
  );
  const rugColor = useMemo(() => new THREE.Color(color).lerp(new THREE.Color('#fff4e0'), 0.45), [color]);
  const stools = Math.min(seats, 6);
  const plump = dims.proportion === 'plump';
  const tableW = plump ? 2.6 : 1.7;
  return (
    <group>
      <mesh geometry={rug} receiveShadow>
        <meshStandardMaterial color={rugColor} roughness={1} />
      </mesh>
      <group position={[0, 0, 0.1]}>
        <mesh position={[0, 0.62, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[tableW / 2, tableW / 2, 0.09, 40]} />
          <meshStandardMaterial color="#8a5a37" roughness={0.5} />
        </mesh>
        <mesh position={[0, 0.3, 0]} castShadow>
          <cylinderGeometry args={[0.1, 0.16, 0.6, 16]} />
          <meshStandardMaterial color="#5a3a22" roughness={0.6} />
        </mesh>
        {Array.from({ length: stools }).map((_, i) => {
          const a = (i / stools) * Math.PI * 2 + 0.4;
          const rx = tableW / 2 + 0.55;
          return (
            <mesh key={i} position={[Math.cos(a) * rx, 0.28, Math.sin(a) * rx * 0.6]} castShadow>
              <cylinderGeometry args={[0.27, 0.22, 0.56, 20]} />
              <meshStandardMaterial color="#d9c0a0" roughness={0.8} />
            </mesh>
          );
        })}
        <mesh position={[0.15, 0.78, 0.05]} castShadow>
          <boxGeometry args={[0.55, 0.3, 0.4]} />
          <meshStandardMaterial color="#f4eadb" roughness={0.7} />
        </mesh>
      </group>
      {/* 램프 스탠드(전구는 InteriorLights) */}
      {[-1, 1].map((s) => (
        <mesh
          key={s}
          position={[s * (dims.length / 2 + dims.floorHalfDepth * 0.35), 0.65, -dims.floorHalfDepth * 0.45]}
          castShadow
        >
          <cylinderGeometry args={[0.035, 0.05, 1.3, 10]} />
          <meshStandardMaterial color="#3b2a1d" roughness={0.5} />
        </mesh>
      ))}
    </group>
  );
}
