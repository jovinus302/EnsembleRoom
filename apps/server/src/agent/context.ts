import { buildRoomState, visibleCards, type PermissionSubject, type RoomEvent, type ToolName } from '@ensemble/shared';
import type { AppContext } from '../context';
import { requireRoom } from '../domain/rooms';
import type { RecallResult } from '../memory/gateway';
import { MAX_EVENTS, buildSystemPrompt, buildUserPrompt } from './prompts';
import { toolSpecs } from './tools';
import type { AgentKind, Trigger, TurnInput, TurnMode } from './types';

/** 프롬프트에 넣지 않는 이벤트: Agent 턴 진행·presence 소음 */
const NOISE = new Set([
  'agent_step',
  'agent_turn_started',
  'agent_turn_ended',
  'agent_paused',
  'member_entered',
  'digest_viewed',
  'room_created',
  'memory_retained',
  'visit_requested',
  'visit_accepted',
  'agent_departed',
  'agent_returned',
  'visit_report',
]);

export function modeOf(subject: PermissionSubject, ownerAway: boolean): TurnMode {
  if (subject.kind === 'room_agent') return 'room';
  if (subject.kind === 'human') return 'accompanied'; // 사람 subject에는 턴이 없다. 도달하지 않는다.
  if (subject.mode === 'member') return ownerAway ? 'representing' : 'member';
  return subject.mode;
}

export interface BuildInput {
  turnId: string;
  roomId: string;
  agentId: string;
  agentKind: AgentKind;
  trigger: Trigger;
  forcedTool: ToolName | null;
  subject: PermissionSubject;
  tools: readonly ToolName[];
  recall: RecallResult;
}

/**
 * 이번 턴의 입력을 서버 진실로 만든다.
 * - 기억: gateway가 허용한 항목만(`recall`). 방문 Agent에게는 개인 ns가 오지 않는다(gateway가 계산).
 * - 이벤트: 'room' 가시성만. 방문 Agent는 자기 방문의 start_seq 이후만, 보드도 그 범위의 이벤트로 만든다. Room 요약도 주지 않는다.
 */
export function buildTurnInput(ctx: AppContext, b: BuildInput): TurnInput {
  const { repo, store } = ctx;
  const room = requireRoom(ctx, b.roomId);
  const personal = b.agentKind === 'personal' ? repo.getAgent(b.agentId) : undefined;
  const roomAgent = b.agentKind === 'room_agent' ? repo.getRoomAgent(b.agentId) : undefined;
  const agentRow = personal ?? roomAgent;
  if (!agentRow) throw new Error(`unknown agent: ${b.agentId}`);

  const all = store.listAll(b.roomId);
  const full = buildRoomState(b.roomId, all);
  const ownerId = personal?.ownerId ?? null;
  const ownerMember = ownerId ? full.members[ownerId] : undefined;
  const ownerAway = !!ownerMember && !ownerMember.present;
  const mode = modeOf(b.subject, ownerAway);
  const visiting = b.subject.kind === 'agent' && b.subject.mode === 'visiting';

  let mandate = null as TurnInput['mandate'];
  let scoped: RoomEvent[] = all;
  if (visiting) {
    const visit = repo.findOpenAgentVisit(b.agentId);
    mandate = visit?.mandate ?? null;
    const start = visit?.startSeq ?? Number.MAX_SAFE_INTEGER;
    scoped = all.filter((e) => e.seq >= start);
  } else if (mode === 'representing') {
    mandate = ownerMember?.mandate ?? null;
  }

  const events = scoped.filter((e) => e.visibility === 'room' && !NOISE.has(e.type)).slice(-MAX_EVENTS * 2);
  const board = visibleCards(visiting ? buildRoomState(b.roomId, scoped) : full);

  const names: Record<string, string> = {};
  for (const u of repo.listUsers()) names[u.id] = u.name;
  names[agentRow.id] = agentRow.name;
  for (const e of events) {
    for (const id of [e.actorId, 'to' in e ? e.to : null, 'agentId' in e ? e.agentId : null, 'toAgentId' in e ? e.toAgentId : null]) {
      if (!id || names[id]) continue;
      const a = repo.getAgent(id) ?? repo.getRoomAgent(id);
      if (a) names[id] = a.name;
    }
  }
  const nameOf = (id: string | null) => (id ? (names[id] ?? id) : '시스템');

  const specs = toolSpecs(b.tools);
  const memories = b.recall.items.map((m) => ({ id: m.id, kind: m.kind, text: m.text }));
  const summary = visiting ? null : (repo.getRoomSummary(b.roomId)?.text ?? null);
  const ownerName = ownerId ? (repo.getUser(ownerId)?.name ?? null) : null;

  const system = buildSystemPrompt({
    mode,
    agentName: agentRow.name,
    ownerName,
    personaPublic: agentRow.personaPublic,
    mandate,
    tools: specs,
    forcedTool: b.forcedTool,
  });
  // `to`에 쓸 수 있는 대화 상대: Room의 사람·Agent. 모델이 id를 지어내지 않도록 프롬프트에 명시한다.
  const people = new Set<string>(repo.memberIds(room.id));
  if (room.ownerId) people.add(room.ownerId);
  const participants: { id: string; name: string }[] = [];
  const addP = (id: string | undefined, name: string | undefined) => {
    if (id && name && id !== agentRow.id && !participants.some((x) => x.id === id)) participants.push({ id, name });
  };
  const visitingAgents = new Set<string>();
  for (const v of repo.listVisitsByHost(room.id)) {
    if (v.status !== 'active') continue;
    people.add(v.visitorUserId);
    if (v.visitorAgentId) visitingAgents.add(v.visitorAgentId);
  }
  for (const uid of people) {
    if (uid !== ownerId) addP(uid, repo.getUser(uid)?.name);
    const ag = repo.getAgentByOwner(uid);
    // My Room에서는 호스트의 Agent와 방문 중인 Agent만, Our Room에서는 구성원의 Agent를 부를 수 있다
    if (ag && (room.kind !== 'my' || uid === room.ownerId || visitingAgents.has(ag.id))) addP(ag.id, ag.name);
  }
  const ra = repo.getRoomAgentByRoom(room.id);
  if (ra) addP(ra.id, ra.name);
  const prompt = buildUserPrompt({ roomTitle: room.title, trigger: b.trigger, memories, summary, board, events, name: nameOf, participants });

  return {
    turnId: b.turnId,
    roomId: b.roomId,
    agent: { id: agentRow.id, kind: b.agentKind, name: agentRow.name, personaPublic: agentRow.personaPublic, ownerId, ownerName },
    mode,
    trigger: b.trigger,
    forcedTool: b.forcedTool,
    tools: specs,
    mandate,
    memories,
    events,
    board,
    roomSummary: summary,
    names,
    roomTitle: room.title,
    system,
    prompt,
  };
}
