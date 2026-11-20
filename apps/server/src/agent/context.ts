import { buildRoomState, visibleBoardTools, visibleCards, type Mandate, type PermissionSubject, type RoomEvent, type ToolName } from '@ensemble/shared';
import type { AppContext } from '../context';
import { requireRoom } from '../domain/rooms';
import type { RecallResult } from '../memory/gateway';
import { MAX_EVENTS, buildSystemPrompt, buildUserPrompt } from './prompts';
import { askableAgents } from './a2a';
import { toolSpecs } from './tools';
import type { A2AJob, AgentKind, Trigger, TurnA2A, TurnInput, TurnMode } from './types';

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

/** 자동 대리의 기본 위임(소유자가 정하지 않음): 대화만 하고, 소유자가 정할 일은 승인 요청으로 넘긴다 */
export const AUTO_REPLY_MANDATE: Mandate = {
  text: '자리를 비운 동안 자동 대리: 대화만 하고, 확정·약속·소유자가 정해야 할 일은 승인 요청으로 넘긴다',
  allowedActions: ['chat', 'request_approval'],
};

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
  /** A2A 답(answer)·정리(collect) 턴 */
  ask?: A2AJob;
  /** 이 턴에 ask_agents를 줬는가 → [물어볼 수 있는 Agent]를 프롬프트에 싣는다 */
  allowAsk?: boolean;
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
  // 보수적 대리 턴: 자동 대리(auto_reply)와 A2A 답 턴(a2a_ask). representing 모드·AUTO_REPLY_MANDATE·자동 대리 프롬프트를 쓴다.
  const autoReply = (b.trigger.reason === 'auto_reply' || b.trigger.reason === 'a2a_ask') && b.subject.kind === 'agent' && b.subject.mode === 'member';
  const mode = autoReply ? 'representing' : modeOf(b.subject, ownerAway);
  const visiting = b.subject.kind === 'agent' && b.subject.mode === 'visiting';

  let mandate = null as TurnInput['mandate'];
  let scoped: RoomEvent[] = all;
  if (visiting) {
    const visit = repo.findOpenAgentVisit(b.agentId);
    mandate = visit?.mandate ?? null;
    const start = visit?.startSeq ?? Number.MAX_SAFE_INTEGER;
    scoped = all.filter((e) => e.seq >= start);
  } else if (autoReply) {
    mandate = AUTO_REPLY_MANDATE;
  } else if (mode === 'representing') {
    mandate = ownerMember?.mandate ?? null;
  }

  const events = scoped.filter((e) => e.visibility === 'room' && !NOISE.has(e.type)).slice(-MAX_EVENTS * 2);
  const scopedState = visiting ? buildRoomState(b.roomId, scoped) : full;
  const board = visibleCards(scopedState);
  const boardTools = visibleBoardTools(scopedState);

  const names: Record<string, string> = {};
  for (const u of repo.listUsers()) names[u.id] = u.name;
  names[agentRow.id] = agentRow.name;
  for (const e of events) {
    const rec = e.type === 'message' ? (e.recipients ?? []) : [];
    for (const id of [e.actorId, 'to' in e ? e.to : null, 'agentId' in e ? e.agentId : null, 'toAgentId' in e ? e.toAgentId : null, ...rec]) {
      if (!id || names[id]) continue;
      const a = repo.getAgent(id) ?? repo.getRoomAgent(id);
      if (a) names[id] = a.name;
    }
  }
  const nameOf = (id: string | null) => (id ? (names[id] ?? id) : '시스템');

  const specs = toolSpecs(b.tools);
  const askable = b.allowAsk ? askableAgents(ctx, b.roomId, b.agentId, full) : [];
  const a2a = b.ask ? buildA2A(ctx, b.ask, all, b.trigger) : null;
  const memories = b.recall.items.map((m) => ({ id: m.id, kind: m.kind, text: m.text }));
  const summary = visiting ? null : (repo.getRoomSummary(b.roomId)?.text ?? null);
  const ownerName = ownerId ? (repo.getUser(ownerId)?.name ?? null) : null;
  const seedOwner = !!ownerId && repo.getUser(ownerId)?.kind === 'seed';

  const system = buildSystemPrompt({
    mode,
    agentName: agentRow.name,
    ownerName,
    personaPublic: agentRow.personaPublic,
    mandate,
    tools: specs,
    forcedTool: b.forcedTool,
    autoReply,
    seedOwner,
  });
  // `to`에 쓸 수 있는 대화 상대: Room의 사람·Agent. 모델이 id를 지어내지 않도록 프롬프트에 명시한다.
  const people = new Set<string>(repo.memberIds(room.id));
  if (room.ownerId) people.add(room.ownerId);
  const participants: { id: string; name: string }[] = [];
  const members: { id: string; name: string }[] = [];
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
    const uname = repo.getUser(uid)?.name;
    if (uname && !members.some((m) => m.id === uid)) members.push({ id: uid, name: uname });
    if (uid !== ownerId) addP(uid, uname);
    const ag = repo.getAgentByOwner(uid);
    // My Room에서는 호스트의 Agent와 방문 중인 Agent만, Our Room에서는 구성원의 Agent를 부를 수 있다
    if (ag && (room.kind !== 'my' || uid === room.ownerId || visitingAgents.has(ag.id))) addP(ag.id, ag.name);
  }
  const ra = repo.getRoomAgentByRoom(room.id);
  if (ra) addP(ra.id, ra.name);
  const prompt = buildUserPrompt({ roomTitle: room.title, trigger: b.trigger, memories, summary, board, boardTools, events, name: nameOf, participants, seedOwner, askable, a2a });

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
    boardTools,
    members,
    roomSummary: summary,
    names,
    roomTitle: room.title,
    askable,
    a2a,
    system,
    prompt,
  };
}

/** A2A 질문·정리 턴의 맥락. 질문 메시지, 그에 대한 답(replyTo === askSeq, 질문자 아님)을 이벤트 로그에서 모은다. */
function buildA2A(ctx: AppContext, ask: A2AJob, all: readonly RoomEvent[], trigger: Trigger): TurnA2A {
  const { repo } = ctx;
  const nameOfId = (id: string) => repo.getAgent(id)?.name ?? repo.getRoomAgent(id)?.name ?? repo.getUser(id)?.name ?? id;
  const askEv = all.find((e) => e.seq === ask.askSeq);
  const question = askEv?.type === 'message' ? askEv.text : trigger.event?.type === 'message' ? trigger.event.text : '';
  if (ask.role === 'answer') {
    return { role: 'answer', askSeq: ask.askSeq, askerId: ask.askerId, askerName: nameOfId(ask.askerId), askerKind: ask.askerKind, question };
  }
  const resolved = new Set<string>();
  for (const e of all) if (e.type === 'approval_resolved') resolved.add(e.approvalId);
  const answers: Extract<TurnA2A, { role: 'collect' }>['answers'] = [];
  for (const e of all) {
    if (e.type !== 'message' || e.replyTo !== ask.askSeq || e.actorId === ask.askerId) continue;
    if ((e.actorKind !== 'agent' && e.actorKind !== 'room_agent') || !e.actorId) continue;
    const approvalPending =
      !!e.turnId && all.some((x) => x.type === 'approval_requested' && x.turnId === e.turnId && !resolved.has(x.approvalId));
    const owner = repo.getAgent(e.actorId)?.ownerId;
    answers.push({ agentId: e.actorId, name: nameOfId(e.actorId), ownerName: owner ? (repo.getUser(owner)?.name ?? null) : null, text: e.text, approvalPending });
  }
  return { role: 'collect', askSeq: ask.askSeq, question, answers };
}
