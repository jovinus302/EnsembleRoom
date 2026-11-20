import type { SQLInputValue } from 'node:sqlite';
import type {
  AgentDto,
  ApprovalKind,
  CanSeeContext,
  Capability,
  Mandate,
  MemoryKind,
  OwnerTag,
  RoomInfo,
  RoomKind,
  ThemeId,
  ThemeVariant,
  UserDto,
  VisitDto,
  VisitStatus,
  VisitorKind,
  VoteDecision,
} from '@ensemble/shared';
import type { Db } from './index';

/** 쿼리는 SQL에서 camelCase로 alias해 행을 그대로 쓴다. */
export type UserRow = UserDto;
export interface AgentRow {
  id: string;
  ownerId: string;
  name: string;
  personaPublic: string;
  variant: string | null;
}
export interface RoomAgentRow {
  id: string;
  roomId: string;
  name: string;
  personaPublic: string;
}
export interface RoomRow {
  id: string;
  kind: RoomKind;
  ownerId: string | null;
  title: string;
  theme: ThemeId;
  themeVariant: ThemeVariant | null;
}
export interface VisitRow {
  id: string;
  hostRoomId: string;
  visitorKind: VisitorKind;
  visitorUserId: string;
  visitorAgentId: string | null;
  status: VisitStatus;
  permissions: Capability[];
  mandate: Mandate | null;
  startSeq: number | null;
  endSeq: number | null;
  /** 요청이 오간 DM Room (없으면 호스트 Room에만 기록된다) */
  requestedInDmRoomId: string | null;
}
export interface CardRow {
  roomId: string;
  cardId: string;
  title: string;
  body: string;
  ownerTag: OwnerTag;
  version: number;
  agreed: boolean;
  deleted: boolean;
}
export interface CursorRow {
  lastSeenSeq: number;
  leftAtSeq: number | null;
}
export interface MemoryItemRow {
  id: string;
  ns: string;
  kind: MemoryKind;
  text: string;
  sourceRoomId: string | null;
  createdBy: string;
  status: string;
  createdAt: number;
}

export interface ApprovalRow {
  id: string;
  roomId: string;
  kind: ApprovalKind;
  requestedBy: string | null;
  payload: Record<string, unknown>;
  status: string;
  createdAt: number;
}
export interface ApprovalVoteRow {
  userId: string;
  decision: VoteDecision;
  edited: Record<string, unknown> | null;
}

/** 모든 SQL은 이 파일에 둔다(events 테이블은 events/store.ts). HOSTING: Postgres 이전 시 함께 바꾼다. */
export class Repo {
  constructor(readonly db: Db) {}

  private all<T>(sql: string, ...p: SQLInputValue[]): T[] {
    return this.db.raw.prepare(sql).all(...p) as unknown as T[];
  }
  private get<T>(sql: string, ...p: SQLInputValue[]): T | undefined {
    return this.db.raw.prepare(sql).get(...p) as unknown as T | undefined;
  }
  private run(sql: string, ...p: SQLInputValue[]): void {
    this.db.raw.prepare(sql).run(...p);
  }

  /* ----- users / sessions ----- */
  insertUser(u: UserRow): void {
    this.run('INSERT OR IGNORE INTO users (id, name, color, kind) VALUES (?, ?, ?, ?)', u.id, u.name, u.color, u.kind);
  }
  getUser(id: string): UserRow | undefined {
    return this.get('SELECT id, name, color, kind FROM users WHERE id = ?', id);
  }
  getUserByName(name: string): UserRow | undefined {
    return this.get('SELECT id, name, color, kind FROM users WHERE name = ? COLLATE NOCASE', name.trim());
  }
  listUsers(): UserRow[] {
    return this.all('SELECT id, name, color, kind FROM users ORDER BY rowid');
  }
  createSession(token: string, userId: string): void {
    this.run('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)', token, userId, Date.now());
  }
  getSessionUser(token: string): UserRow | undefined {
    return this.get(
      'SELECT u.id, u.name, u.color, u.kind FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?',
      token,
    );
  }

  /* ----- agents ----- */
  insertAgent(a: AgentRow): void {
    this.run(
      'INSERT OR IGNORE INTO agents (id, owner_id, name, persona_public, variant) VALUES (?, ?, ?, ?, ?)',
      a.id,
      a.ownerId,
      a.name,
      a.personaPublic,
      a.variant,
    );
  }
  private static readonly AGENT_COLS = 'id, owner_id AS ownerId, name, persona_public AS personaPublic, variant';
  getAgent(id: string): AgentRow | undefined {
    return this.get(`SELECT ${Repo.AGENT_COLS} FROM agents WHERE id = ?`, id);
  }
  getAgentByOwner(ownerId: string): AgentRow | undefined {
    return this.get(`SELECT ${Repo.AGENT_COLS} FROM agents WHERE owner_id = ? ORDER BY rowid LIMIT 1`, ownerId);
  }
  insertRoomAgent(a: RoomAgentRow): void {
    this.run(
      'INSERT OR IGNORE INTO room_agents (id, room_id, name, persona_public) VALUES (?, ?, ?, ?)',
      a.id,
      a.roomId,
      a.name,
      a.personaPublic,
    );
  }
  private static readonly RA_COLS = 'id, room_id AS roomId, name, persona_public AS personaPublic';
  getRoomAgent(id: string): RoomAgentRow | undefined {
    return this.get(`SELECT ${Repo.RA_COLS} FROM room_agents WHERE id = ?`, id);
  }
  getRoomAgentByRoom(roomId: string): RoomAgentRow | undefined {
    return this.get(`SELECT ${Repo.RA_COLS} FROM room_agents WHERE room_id = ?`, roomId);
  }

  static agentDto(a: AgentRow): AgentDto {
    return {
      id: a.id,
      kind: 'personal',
      ownerId: a.ownerId,
      name: a.name,
      personaPublic: a.personaPublic,
      variant: a.variant,
    };
  }
  static roomAgentDto(a: RoomAgentRow): AgentDto {
    return { id: a.id, kind: 'room', ownerId: null, name: a.name, personaPublic: a.personaPublic, variant: null };
  }

  /* ----- rooms ----- */
  insertRoom(r: RoomRow): void {
    this.run(
      'INSERT OR IGNORE INTO rooms (id, kind, owner_id, title, theme, theme_variant) VALUES (?, ?, ?, ?, ?, ?)',
      r.id,
      r.kind,
      r.ownerId,
      r.title,
      r.theme,
      r.themeVariant,
    );
  }
  private static readonly ROOM_COLS = 'id, kind, owner_id AS ownerId, title, theme, theme_variant AS themeVariant';
  getRoom(id: string): RoomRow | undefined {
    return this.get(`SELECT ${Repo.ROOM_COLS} FROM rooms WHERE id = ?`, id);
  }
  listRooms(): RoomRow[] {
    return this.all(`SELECT ${Repo.ROOM_COLS} FROM rooms ORDER BY rowid`);
  }
  addMember(roomId: string, userId: string): void {
    this.run('INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)', roomId, userId);
  }
  /** our/dm 구성원. my Room은 빈 배열(소유자는 ownerId) */
  memberIds(roomId: string): string[] {
    return this.all<{ userId: string }>(
      'SELECT user_id AS userId FROM room_members WHERE room_id = ? ORDER BY rowid',
      roomId,
    ).map((r) => r.userId);
  }
  roomInfo(r: RoomRow): RoomInfo {
    return {
      id: r.id,
      kind: r.kind,
      ownerId: r.ownerId,
      title: r.title,
      theme: r.theme,
      themeVariant: r.themeVariant,
      memberIds: this.memberIds(r.id),
    };
  }
  isMember(roomId: string, userId: string): boolean {
    return this.get('SELECT 1 AS x FROM room_members WHERE room_id = ? AND user_id = ?', roomId, userId) !== undefined;
  }

  /* ----- visits ----- */
  private static readonly VISIT_COLS = `id, host_room_id AS hostRoomId, visitor_kind AS visitorKind, visitor_user_id AS visitorUserId,
              visitor_agent_id AS visitorAgentId, status, permissions_json AS permissionsJson,
              mandate_json AS mandateJson, start_seq AS startSeq, end_seq AS endSeq,
              requested_in_dm_room_id AS requestedInDmRoomId`;
  private static visit(r: Record<string, unknown>): VisitRow {
    return {
      id: r.id as string,
      hostRoomId: r.hostRoomId as string,
      visitorKind: r.visitorKind as VisitorKind,
      visitorUserId: r.visitorUserId as string,
      visitorAgentId: (r.visitorAgentId as string | null) ?? null,
      status: r.status as VisitStatus,
      permissions: JSON.parse(r.permissionsJson as string) as Capability[],
      mandate: r.mandateJson ? (JSON.parse(r.mandateJson as string) as Mandate) : null,
      startSeq: (r.startSeq as number | null) ?? null,
      endSeq: (r.endSeq as number | null) ?? null,
      requestedInDmRoomId: (r.requestedInDmRoomId as string | null) ?? null,
    };
  }
  listVisitsByHost(roomId: string): VisitRow[] {
    return this.all<Record<string, unknown>>(
      `SELECT ${Repo.VISIT_COLS} FROM visits WHERE host_room_id = ? ORDER BY rowid`,
      roomId,
    ).map(Repo.visit);
  }
  getVisit(id: string): VisitRow | undefined {
    const r = this.get<Record<string, unknown>>(`SELECT ${Repo.VISIT_COLS} FROM visits WHERE id = ?`, id);
    return r ? Repo.visit(r) : undefined;
  }
  insertVisit(v: {
    id: string;
    hostRoomId: string;
    visitorKind: VisitorKind;
    visitorUserId: string;
    visitorAgentId: string | null;
    mandate: Mandate | null;
    requestedInDmRoomId: string | null;
  }): void {
    this.run(
      `INSERT INTO visits (id, host_room_id, visitor_kind, visitor_user_id, visitor_agent_id, status, permissions_json, mandate_json, requested_in_dm_room_id)
       VALUES (?, ?, ?, ?, ?, 'requested', '[]', ?, ?)`,
      v.id,
      v.hostRoomId,
      v.visitorKind,
      v.visitorUserId,
      v.visitorAgentId,
      v.mandate ? JSON.stringify(v.mandate) : null,
      v.requestedInDmRoomId,
    );
  }
  setVisitState(id: string, status: VisitStatus, permissions?: Capability[]): void {
    if (permissions) {
      this.run('UPDATE visits SET status = ?, permissions_json = ? WHERE id = ?', status, JSON.stringify(permissions), id);
    } else {
      this.run('UPDATE visits SET status = ? WHERE id = ?', status, id);
    }
  }
  setVisitStartSeq(id: string, seq: number): void {
    this.run('UPDATE visits SET start_seq = ? WHERE id = ?', seq, id);
  }
  setVisitEndSeq(id: string, seq: number): void {
    this.run('UPDATE visits SET end_seq = ? WHERE id = ?', seq, id);
  }
  /** 이 Agent의 요청 중이거나 활성인 방문 (한 번에 하나) */
  findOpenAgentVisit(agentId: string): VisitRow | undefined {
    const r = this.get<Record<string, unknown>>(
      `SELECT ${Repo.VISIT_COLS} FROM visits WHERE visitor_agent_id = ? AND status IN ('requested', 'active') ORDER BY rowid LIMIT 1`,
      agentId,
    );
    return r ? Repo.visit(r) : undefined;
  }
  /** 이 사용자의 호스트 Room에 대한 요청 중이거나 활성인 사람 방문 */
  findOpenHumanVisit(userId: string, hostRoomId: string): VisitRow | undefined {
    const r = this.get<Record<string, unknown>>(
      `SELECT ${Repo.VISIT_COLS} FROM visits WHERE visitor_user_id = ? AND host_room_id = ? AND visitor_kind = 'human'
         AND status IN ('requested', 'active') ORDER BY rowid LIMIT 1`,
      userId,
      hostRoomId,
    );
    return r ? Repo.visit(r) : undefined;
  }
  static visitDto(v: VisitRow): VisitDto {
    return {
      id: v.id,
      hostRoomId: v.hostRoomId,
      visitorKind: v.visitorKind,
      visitorUserId: v.visitorUserId,
      visitorAgentId: v.visitorAgentId,
      status: v.status,
      permissions: v.permissions,
      mandate: v.mandate,
      startSeq: v.startSeq,
      endSeq: v.endSeq,
    };
  }
  /** 이 사용자가 한 모든 방문 (world 유리 투명도 계산용) */
  listVisitsByVisitor(userId: string): VisitRow[] {
    return this.all<Record<string, unknown>>(
      `SELECT ${Repo.VISIT_COLS} FROM visits WHERE visitor_user_id = ? ORDER BY rowid`,
      userId,
    ).map(Repo.visit);
  }
  /** 두 사람의 DM Room (없으면 undefined) */
  findDmRoom(a: string, b: string): RoomRow | undefined {
    return this.get(
      `SELECT ${Repo.ROOM_COLS} FROM rooms r WHERE r.kind = 'dm'
         AND EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = r.id AND m.user_id = ?)
         AND EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = r.id AND m.user_id = ?)
         ORDER BY r.rowid LIMIT 1`,
      a,
      b,
    );
  }
  getMyRoomByOwner(ownerId: string): RoomRow | undefined {
    return this.get(`SELECT ${Repo.ROOM_COLS} FROM rooms WHERE kind = 'my' AND owner_id = ? ORDER BY rowid LIMIT 1`, ownerId);
  }

  /** hub·스냅샷·store가 쓰는 가시성 입력. 서버 진실에서 만든다. */
  canSeeContext(roomId: string, viewerId: string): CanSeeContext | null {
    const room = this.getRoom(roomId);
    if (!room) return null;
    return {
      viewerId,
      roomKind: room.kind,
      ownerId: room.ownerId,
      memberIds: this.memberIds(roomId),
      visits: this.listVisitsByHost(roomId).map((v) => ({
        visitorUserId: v.visitorUserId,
        visitorKind: v.visitorKind,
        status: v.status,
        startSeq: v.startSeq,
      })),
    };
  }

  /* ----- board cards (이벤트의 투영) ----- */
  private static readonly CARD_COLS =
    'room_id AS roomId, card_id AS cardId, title, body, owner_tag AS ownerTag, version, agreed, deleted';
  private static card(r: Record<string, unknown> | undefined): CardRow | undefined {
    if (!r) return undefined;
    return { ...(r as unknown as CardRow), agreed: !!r.agreed, deleted: !!r.deleted };
  }
  getCard(roomId: string, cardId: string): CardRow | undefined {
    return Repo.card(
      this.get(`SELECT ${Repo.CARD_COLS} FROM board_cards WHERE room_id = ? AND card_id = ?`, roomId, cardId),
    );
  }
  insertCard(c: Omit<CardRow, 'agreed' | 'deleted' | 'version'> & { version?: number }): void {
    this.run(
      'INSERT INTO board_cards (room_id, card_id, title, body, owner_tag, version) VALUES (?, ?, ?, ?, ?, ?)',
      c.roomId,
      c.cardId,
      c.title,
      c.body,
      c.ownerTag,
      c.version ?? 1,
    );
  }
  updateCard(
    roomId: string,
    cardId: string,
    f: { title: string; body: string; deleted: boolean; version: number },
  ): void {
    this.run(
      'UPDATE board_cards SET title = ?, body = ?, deleted = ?, version = ? WHERE room_id = ? AND card_id = ?',
      f.title,
      f.body,
      f.deleted ? 1 : 0,
      f.version,
      roomId,
      cardId,
    );
  }

  /* ----- read cursors ----- */
  getCursor(userId: string, roomId: string): CursorRow {
    const r = this.get<CursorRow>(
      'SELECT last_seen_seq AS lastSeenSeq, left_at_seq AS leftAtSeq FROM read_cursors WHERE user_id = ? AND room_id = ?',
      userId,
      roomId,
    );
    return r ?? { lastSeenSeq: 0, leftAtSeq: null };
  }
  /** 읽은 위치는 줄어들지 않는다 */
  setSeen(userId: string, roomId: string, seq: number): void {
    this.run(
      `INSERT INTO read_cursors (user_id, room_id, last_seen_seq) VALUES (?, ?, ?)
       ON CONFLICT (user_id, room_id) DO UPDATE SET last_seen_seq = MAX(last_seen_seq, excluded.last_seen_seq)`,
      userId,
      roomId,
      seq,
    );
  }

  /** left_at_seq 갱신. null이면 해제 */
  setLeftAt(userId: string, roomId: string, seq: number | null): void {
    this.run(
      `INSERT INTO read_cursors (user_id, room_id, last_seen_seq, left_at_seq) VALUES (?, ?, 0, ?)
       ON CONFLICT (user_id, room_id) DO UPDATE SET left_at_seq = excluded.left_at_seq`,
      userId,
      roomId,
      seq,
    );
  }

  /* ----- memory (접근은 memory/gateway.ts를 거친다) ----- */
  insertMemoryItem(m: Omit<MemoryItemRow, 'createdAt' | 'status'> & { createdAt?: number; status?: string }): void {
    this.run(
      `INSERT OR IGNORE INTO memory_items (id, ns, kind, text, source_room_id, source_seqs, created_by, status, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      m.id,
      m.ns,
      m.kind,
      m.text,
      m.sourceRoomId,
      m.createdBy,
      m.status ?? 'active',
      m.createdAt ?? Date.now(),
    );
  }
  listMemoryItems(ns: string): MemoryItemRow[] {
    return this.all(
      `SELECT id, ns, kind, text, source_room_id AS sourceRoomId, created_by AS createdBy, status, created_at AS createdAt
         FROM memory_items WHERE ns = ? AND status = 'active' ORDER BY created_at, rowid`,
      ns,
    );
  }
  private static readonly MEM_COLS =
    'id, ns, kind, text, source_room_id AS sourceRoomId, created_by AS createdBy, status, created_at AS createdAt';
  getMemoryItem(id: string): MemoryItemRow | undefined {
    return this.get(`SELECT ${Repo.MEM_COLS} FROM memory_items WHERE id = ?`, id);
  }
  /** 여러 ns의 활성 항목 (오래된 순) */
  listMemoryItemsIn(nsList: readonly string[]): MemoryItemRow[] {
    if (nsList.length === 0) return [];
    const marks = nsList.map(() => '?').join(', ');
    return this.all(
      `SELECT ${Repo.MEM_COLS} FROM memory_items WHERE ns IN (${marks}) AND status = 'active' ORDER BY created_at, rowid`,
      ...nsList,
    );
  }
  setMemoryStatus(id: string, status: 'active' | 'deleted'): void {
    this.run('UPDATE memory_items SET status = ? WHERE id = ?', status, id);
  }
  setMemoryNs(id: string, ns: string): void {
    this.run('UPDATE memory_items SET ns = ? WHERE id = ?', ns, id);
  }

  /* ----- approvals (요청 S8, 투표·해소 S10 domain/approvals.ts) ----- */
  insertApproval(a: { id: string; roomId: string; kind: ApprovalKind; requestedBy: string | null; payload: unknown }): void {
    this.run(
      'INSERT INTO approvals (id, room_id, kind, requested_by, payload_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      a.id,
      a.roomId,
      a.kind,
      a.requestedBy,
      JSON.stringify(a.payload),
      'pending',
      Date.now(),
    );
  }
  getApproval(id: string): ApprovalRow | undefined {
    const r = this.get<Record<string, unknown>>(
      `SELECT id, room_id AS roomId, kind, requested_by AS requestedBy, payload_json AS payloadJson, status, created_at AS createdAt
         FROM approvals WHERE id = ?`,
      id,
    );
    if (!r) return undefined;
    return {
      id: r.id as string,
      roomId: r.roomId as string,
      kind: r.kind as ApprovalKind,
      requestedBy: (r.requestedBy as string | null) ?? null,
      payload: JSON.parse(r.payloadJson as string) as Record<string, unknown>,
      status: r.status as string,
      createdAt: r.createdAt as number,
    };
  }
  setApprovalStatus(id: string, status: string): void {
    this.run('UPDATE approvals SET status = ? WHERE id = ?', status, id);
  }
  listApprovalVotes(approvalId: string): ApprovalVoteRow[] {
    return this.all<Record<string, unknown>>(
      'SELECT user_id AS userId, decision, edited_json AS editedJson FROM approval_votes WHERE approval_id = ? ORDER BY rowid',
      approvalId,
    ).map((r) => ({
      userId: r.userId as string,
      decision: r.decision as VoteDecision,
      edited: r.editedJson ? (JSON.parse(r.editedJson as string) as Record<string, unknown>) : null,
    }));
  }
  insertApprovalVote(approvalId: string, userId: string, decision: VoteDecision, edited: unknown): void {
    this.run(
      'INSERT INTO approval_votes (approval_id, user_id, decision, edited_json) VALUES (?, ?, ?, ?)',
      approvalId,
      userId,
      decision,
      edited === undefined || edited === null ? null : JSON.stringify(edited),
    );
  }
  setCardAgreed(roomId: string, cardId: string): void {
    this.run('UPDATE board_cards SET agreed = 1 WHERE room_id = ? AND card_id = ?', roomId, cardId);
  }

  upsertRoomSummary(roomId: string, uptoSeq: number, text: string): void {
    this.run(
      `INSERT INTO room_summaries (room_id, upto_seq, text) VALUES (?, ?, ?)
       ON CONFLICT (room_id) DO UPDATE SET upto_seq = excluded.upto_seq, text = excluded.text`,
      roomId,
      uptoSeq,
      text,
    );
  }
  getRoomSummary(roomId: string): { uptoSeq: number; text: string } | undefined {
    return this.get('SELECT upto_seq AS uptoSeq, text FROM room_summaries WHERE room_id = ?', roomId);
  }
}
