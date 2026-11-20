import * as THREE from 'three';

/** Swarm이 매 프레임 갱신하는 내 커서의 월드 좌표(지면 교차점). FxScene·클릭 연출이 읽는다 */
export const cursorWorld = {
  point: new THREE.Vector3(),
  valid: false,
  inside: false,
  hoverRoom: null as string | null,
};
