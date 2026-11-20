import * as THREE from 'three';

/** 내가 대상이거나 내가 일으킨 사건에서만 카메라를 아주 조금 그쪽으로 민다(8.7). CameraRig가 읽는다 */
export const cameraNudge = { cur: new THREE.Vector3(), want: new THREE.Vector3(), until: 0 };
