import * as THREE from 'three';
import type { CharacterEvent } from './types';

/**
 * S19 연출용 조회·훅. 캐릭터 컴포넌트가 마운트되면 등록하고, 프레임마다 월드 좌표를 읽을 수 있다.
 * - getCharacterWorldPosition(id, out): 머리 위(말풍선 높이) 기준의 월드 좌표. 없으면 null
 * - onCharacterEvent(fn): spawn/despawn/trip_start/trip_end/cue 이벤트 구독, 구독 해제 함수를 돌려준다
 */
const objects = new Map<string, { obj: THREE.Object3D; height: number; roomId: string | null }>();
const listeners = new Set<(e: CharacterEvent) => void>();

export function registerCharacter(id: string, obj: THREE.Object3D, height: number, roomId: string | null): () => void {
  objects.set(id, { obj, height, roomId });
  return () => {
    if (objects.get(id)?.obj === obj) objects.delete(id);
  };
}

export function getCharacterWorldPosition(id: string, out = new THREE.Vector3(), headHeight = true): THREE.Vector3 | null {
  const e = objects.get(id);
  if (!e) return null;
  e.obj.updateWorldMatrix(true, false);
  out.set(0, headHeight ? e.height : 0, 0);
  return e.obj.localToWorld(out);
}

export function characterRoomOf(id: string): string | null {
  return objects.get(id)?.roomId ?? null;
}

export function listCharacterIds(): string[] {
  return [...objects.keys()];
}

export function onCharacterEvent(fn: (e: CharacterEvent) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function emitCharacterEvent(e: CharacterEvent): void {
  for (const l of listeners) l(e);
}
