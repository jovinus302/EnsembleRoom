import { z } from 'zod';
import type { RoomKind, VisitStatus } from './events';

/**
 * 권한 표 (계획 6절). 서버는 모든 쓰기 직전에 `effectiveCapabilities`를 서버 진실로 다시 계산한다.
 * Agent에게는 capability로 걸러진 도구만 준다(`allowedTools`).
 */
export const CapabilitySchema = z.enum([
  'chat',
  'comment',
  'edit_board',
  'propose_edit',
  'remember',
  'request_approval',
]);
export type Capability = z.infer<typeof CapabilitySchema>;
export const ALL_CAPABILITIES: readonly Capability[] = CapabilitySchema.options;

/** 방문자(사람)에게 줄 수 있는 grant의 상한 */
export const VISITOR_GRANTABLE: readonly Capability[] = ['chat', 'comment', 'propose_edit'];
/** 방문 Agent는 어떤 grant·mandate로도 이 둘을 가질 수 없다 */
export const VISITING_AGENT_FORBIDDEN: readonly Capability[] = ['edit_board', 'remember'];

/** 방문의 현재 상태와 호스트가 수락 때 준 grant */
export interface VisitGrant {
  status: VisitStatus;
  permissions: readonly Capability[];
}

/**
 * 권한 계산 대상. 서버가 DB에서 만든다.
 * - human owner: my Room 소유자 / 그 외 relation 'member': Our·DM 구성원
 * - agent accompanied: 소유자가 My Room에 있는 동안 / representing: 소유자가 Leave(대리 참여)한 동안
 * - agent member: Our Room 구성원의 Agent (소유자 유무와 무관)
 */
export type PermissionSubject =
  | { kind: 'human'; relation: 'owner' | 'member'; roomKind: RoomKind }
  | { kind: 'human'; relation: 'visitor'; visit: VisitGrant }
  | { kind: 'agent'; mode: 'accompanied' | 'representing'; roomKind: 'my' }
  | { kind: 'agent'; mode: 'member'; roomKind: 'our' }
  | { kind: 'agent'; mode: 'visiting'; visit: VisitGrant; mandateActions: readonly Capability[] }
  | { kind: 'room_agent' };

const ORDER = new Map(ALL_CAPABILITIES.map((c, i) => [c, i] as const));
function canonical(caps: Iterable<Capability>): Capability[] {
  return [...new Set(caps)].sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0));
}

export function effectiveCapabilities(subject: PermissionSubject): Capability[] {
  switch (subject.kind) {
    case 'room_agent':
      return canonical(['chat', 'comment', 'propose_edit', 'request_approval']);

    case 'human': {
      if (subject.relation === 'owner') {
        return subject.roomKind === 'my' ? canonical(ALL_CAPABILITIES) : [];
      }
      if (subject.relation === 'visitor') {
        if (subject.visit.status !== 'active') return [];
        return canonical(subject.visit.permissions.filter((c) => VISITOR_GRANTABLE.includes(c)));
      }
      // 구성원: Our는 합의된 카드 수정에 decision 승인이 필요하지만 그 판단은 domain 층이 한다.
      if (subject.roomKind === 'our') return canonical(['chat', 'comment', 'edit_board']);
      if (subject.roomKind === 'dm') return canonical(['chat']);
      return [];
    }

    case 'agent': {
      switch (subject.mode) {
        case 'accompanied':
          return canonical(['chat', 'comment', 'edit_board', 'remember', 'request_approval']);
        case 'representing':
          // 대리 참여: edit_board를 빼고 propose_edit(승인자는 소유자)
          return canonical(['chat', 'comment', 'propose_edit', 'remember', 'request_approval']);
        case 'member':
          // propose_edit 승인자는 소유자를 제외한 사람 구성원 1인(domain 층)
          return canonical(['chat', 'comment', 'propose_edit', 'remember', 'request_approval']);
        case 'visiting': {
          if (subject.visit.status !== 'active') return [];
          return canonical(
            subject.visit.permissions.filter(
              (c) => subject.mandateActions.includes(c) && !VISITING_AGENT_FORBIDDEN.includes(c),
            ),
          );
        }
      }
    }
  }
}

export function can(subject: PermissionSubject, capability: Capability): boolean {
  return effectiveCapabilities(subject).includes(capability);
}

/** Agent 도구 이름 (계획 6절 도구 표) */
export const TOOL_NAMES = [
  'say',
  'comment',
  'propose_edit',
  'edit_board',
  'request_approval',
  'remember',
  'end_visit',
  'pass',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** capability가 필요한 도구 → 필요한 capability. `end_visit`, `pass`는 capability와 무관하다. */
export const TOOL_CAPABILITY: Readonly<Record<Exclude<ToolName, 'end_visit' | 'pass'>, Capability>> = {
  say: 'chat',
  comment: 'comment',
  propose_edit: 'propose_edit',
  edit_board: 'edit_board',
  request_approval: 'request_approval',
  remember: 'remember',
};

/** Agent 턴에 줄 도구. 사람 subject에는 빈 배열. `pass`는 항상, `end_visit`은 활성 방문 중에만. */
export function allowedTools(subject: PermissionSubject): ToolName[] {
  if (subject.kind === 'human') return [];
  const caps = new Set(effectiveCapabilities(subject));
  const tools: ToolName[] = TOOL_NAMES.filter(
    (t): t is Exclude<ToolName, 'end_visit' | 'pass'> =>
      t !== 'end_visit' && t !== 'pass' && caps.has(TOOL_CAPABILITY[t]),
  );
  if (subject.kind === 'agent' && subject.mode === 'visiting' && subject.visit.status === 'active') {
    tools.push('end_visit');
  }
  tools.push('pass');
  return tools;
}
