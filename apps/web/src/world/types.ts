import type { AmbienceStage, GlassClarity, ThemeId, ThemeVariant, WorldRoom } from '@ensemble/shared';
import type { ReactNode } from 'react';
import type { QualityTier } from './quality';

export interface WorldUser {
  id: string;
  name: string;
  /** 사용자 고유 색 (hex) */
  color: string;
}

/** WorldCanvas 입력: useWorld 스토어의 rooms/users를 그대로 넘기면 된다 */
export type WorldRoomInput = WorldRoom;

/** 캡슐 하나를 그리는 데 필요한 파생 값 */
export interface CapsuleModel {
  roomId: string;
  kind: 'my' | 'our' | 'dm';
  /** my Room의 소유자 */
  ownerId: string | null;
  memberIds: readonly string[];
  relation: 'mine' | 'yours' | 'ours';
  label: string;
  theme: ThemeId;
  themeVariant: ThemeVariant | null;
  /** 구성원 색(my는 소유자 1개, our는 구성원 전원) */
  memberColors: string[];
  /** my=소유자 색, our=구성원 혼합색 */
  color: string;
  glass: GlassClarity;
  /** 보는 사람의 고유 색. 'agent 시야' 유리의 림 빛과 라벨 표식에 쓴다 */
  viewerColor: string;
  ambience: AmbienceStage;
}

/** 캡슐 내부에 자식을 넣을 때(`renderInterior`) 받는 컨텍스트. 좌표계는 capsule/dims.ts 참고 */
export interface CapsuleInteriorContext {
  model: CapsuleModel;
  /** 바닥 윗면 중심이 원점, +x 길이 방향, +y 위, +z 카메라(관객) 쪽 */
  dims: import('./capsule/dims').CapsuleDims;
  quality: QualityTier;
}

export interface WorldCanvasProps {
  /** 이 월드를 보는 사람. 배치·라벨·유리가 이 사람 기준으로 정해진다 */
  viewerId: string;
  rooms: readonly WorldRoomInput[];
  users: Readonly<Record<string, WorldUser>>;
  selectedRoomId?: string | null;
  /** 카메라가 접근할 캡슐. null/undefined면 월드 조망 */
  focusRoomId?: string | null;
  /** 캡슐 클릭(roomId) 또는 빈 곳 클릭(null) */
  onSelectRoom?: (roomId: string | null) => void;
  onHoverRoom?: (roomId: string | null) => void;
  /** 'auto'(기본)면 ?q= 강제값, 없으면 PerformanceMonitor 자동 */
  quality?: QualityTier | 'auto';
  /** 개발·테스트용: 서버가 준 preview 값 대신 덮어쓴다 */
  glassOverrides?: Readonly<Record<string, GlassClarity>>;
  ambienceOverrides?: Readonly<Record<string, AmbienceStage>>;
  /** 캡슐 내부 소품(S17)을 넣는 자리 */
  renderInterior?: (ctx: CapsuleInteriorContext) => ReactNode;
  /** false면 실내를 비운다. 기본(true/미지정)은 S17 Diorama(GLB 소품 세트), 로딩 중에는 PlaceholderInterior. renderInterior가 있으면 무시 */
  placeholderInterior?: boolean;
  /** S18: 캡슐 안의 사람·Agent. stage/WorldHost가 useRoomModel(포커스)·world preview(조망)에서 만든다 */
  characters?: import('./agents/types').WorldCharacters;
  /** true면 frameloop를 멈춘다(탭이 숨겨졌을 때) */
  paused?: boolean;
  /** 카메라 감쇠·튜브 흐름·맥동·캐릭터 모션을 줄인다 (prefers-reduced-motion) */
  reducedMotion?: boolean;
  /** 포커스 영역(캔버스 좌표계의 사각형). 캔버스는 화면 전체이고, 카메라는 대상을 이 사각형 중앙에 맞춘다. 없으면 캔버스 전체 */
  viewRect?: { left: number; top: number; width: number; height: number } | null;
  /** 월드 첫 진입 인트로(태양 쪽 지평선에서 내려오는 카메라). true면 마운트 직후 한 번 재생 */
  intro?: boolean;
  /** 내 커서 위치를 상대에게 알린다(휘발성 cursor 채널, 캡슐 로컬 인코딩). 20Hz 상한 */
  onCursor?: (c: { x: number; y: number; z: number }) => void;
  className?: string;
  style?: React.CSSProperties;
}
