import type { MetricsCounters, MetricsResponse, RoomEvent } from '@ensemble/shared';
import type { AppContext } from '../context';
import { forbidden, notFound } from '../errors';

const rate = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 1000) / 1000);

/** 이벤트 목록(이미 가시성 필터를 거친 것)에서 지표를 센다. 순수 함수. */
export function computeCounters(events: readonly RoomEvent[]): MetricsCounters {
  const c = {
    started: 0, acted: 0, pass: 0, error: 0, paused: 0,
    takeouts: 0,
    entered: 0, leaveExp: 0, leaveImp: 0, leaveMandate: 0, rejoins: 0, digest: 0, missed: 0,
    aReq: 0, aRes: 0, aApproved: 0, aEdited: 0, aRejected: 0,
    agreements: 0, memory: 0,
  };
  const byKind: Record<string, number> = {};
  const requestedAt = new Map<string, number>();
  // 방문 지표는 visitId 기준으로 센다. 요청·수락·거절·종료는 호스트 Room과 DM Room에 둘 다 기록되고,
  // 방문자는 수락 전 호스트 Room 이벤트(visit_requested)를 못 보므로 이벤트 수로 세면 수락이 요청을 넘는다.
  const vSeen = new Set<string>();
  const vAgentIds = new Set<string>();
  const vAccIds = new Set<string>();
  const vDecIds = new Set<string>();
  const vEndIds = new Set<string>();
  let resolveMsSum = 0;
  let resolveMsN = 0;

  for (const e of events) {
    switch (e.type) {
      case 'agent_turn_started': c.started++; break;
      case 'agent_turn_ended':
        if (e.result === 'acted') c.acted++;
        else if (e.result === 'pass') c.pass++;
        else c.error++;
        break;
      case 'agent_paused': c.paused++; break;
      case 'visit_requested':
        vSeen.add(e.visitId);
        if (e.visitorKind === 'agent') vAgentIds.add(e.visitId);
        break;
      case 'visit_accepted': vSeen.add(e.visitId); vAccIds.add(e.visitId); break;
      case 'visit_declined': vSeen.add(e.visitId); vDecIds.add(e.visitId); break;
      case 'visit_ended': vEndIds.add(e.visitId); break;
      case 'agent_arrived': if (e.visitId) vAgentIds.add(e.visitId); break;
      case 'visit_takeout': c.takeouts++; break;
      case 'member_entered': c.entered++; break;
      case 'member_left':
        if (e.implicit) c.leaveImp++;
        else {
          c.leaveExp++;
          if (e.mandate) c.leaveMandate++;
        }
        break;
      case 'member_rejoined':
        c.rejoins++;
        c.missed += e.missedCount;
        break;
      case 'digest_viewed': c.digest++; break;
      case 'approval_requested':
        c.aReq++;
        byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
        requestedAt.set(`${e.roomId}:${e.approvalId}`, e.ts);
        break;
      case 'approval_resolved': {
        c.aRes++;
        if (e.outcome === 'approved') c.aApproved++;
        else if (e.outcome === 'edited') c.aEdited++;
        else c.aRejected++;
        const t0 = requestedAt.get(`${e.roomId}:${e.approvalId}`);
        if (t0 !== undefined) {
          resolveMsSum += Math.max(0, e.ts - t0);
          resolveMsN++;
        }
        break;
      }
      case 'agreement_formed': c.agreements++; break;
      case 'memory_retained': c.memory++; break;
      default: break;
    }
  }

  const vReq = vSeen.size;
  const vAgent = vAgentIds.size;
  const rejoinRate = rate(c.rejoins, c.leaveExp + c.leaveImp);
  return {
    agentTurns: { started: c.started, acted: c.acted, pass: c.pass, error: c.error, paused: c.paused },
    visits: {
      requested: vReq,
      humanRequested: vReq - vAgent,
      agentSent: vAgent,
      accepted: vAccIds.size,
      declined: vDecIds.size,
      ended: vEndIds.size,
      acceptRate: rate(vAccIds.size, vReq),
      takeouts: c.takeouts,
      takeoutRate: rate(c.takeouts, vAgent),
    },
    presence: {
      entered: c.entered,
      leavesExplicit: c.leaveExp,
      leavesImplicit: c.leaveImp,
      leavesWithMandate: c.leaveMandate,
      mandateRate: rate(c.leaveMandate, c.leaveExp),
      rejoins: c.rejoins,
      rejoinRate: rejoinRate === null ? null : Math.min(1, rejoinRate),
      digestViewed: c.digest,
      missedChanges: c.missed,
    },
    approvals: {
      requested: c.aReq,
      resolved: c.aRes,
      pending: Math.max(0, c.aReq - c.aRes),
      approved: c.aApproved,
      edited: c.aEdited,
      rejected: c.aRejected,
      approvedRate: rate(c.aApproved, c.aRes),
      editedRate: rate(c.aEdited, c.aRes),
      rejectedRate: rate(c.aRejected, c.aRes),
      avgResolveMs: resolveMsN === 0 ? null : Math.round(resolveMsSum / resolveMsN),
      byKind,
    },
    agreements: c.agreements,
    memoryRetained: c.memory,
  };
}

/** Room 단위 조회 허용: 구성원, my Room 소유자, 또는 그 my Room 방문 기록이 있는 사람 */
function mayQueryRoom(ctx: AppContext, viewerId: string, roomId: string): boolean {
  const room = ctx.repo.getRoom(roomId)!;
  if (room.ownerId === viewerId) return true;
  if (room.kind !== 'my') return ctx.repo.isMember(roomId, viewerId);
  return ctx.repo.listVisitsByHost(roomId).some((v) => v.visitorUserId === viewerId && v.status !== 'declined');
}

/**
 * 요청자(viewerId)에게 보이는 이벤트만으로 지표를 만든다. `roomId`를 주면 그 Room만(접근 불가면 403).
 * 가시성은 스냅샷·hub와 같은 canSeeEvent를 쓰므로, 남의 Room 내용이나 private 이벤트는 숫자에 반영되지 않는다.
 */
export function buildMetrics(ctx: AppContext, viewerId: string, roomId?: string): MetricsResponse {
  let rooms = ctx.repo.listRooms();
  if (roomId !== undefined) {
    if (!ctx.repo.getRoom(roomId)) throw notFound('room_not_found');
    if (!mayQueryRoom(ctx, viewerId, roomId)) throw forbidden('forbidden');
    rooms = rooms.filter((r) => r.id === roomId);
  }
  const all: RoomEvent[] = [];
  const perRoom: MetricsResponse['perRoom'] = [];
  let repeatUse = 0;
  for (const room of rooms) {
    const events = ctx.store.listVisible(viewerId, room.id);
    if (events.length === 0) continue;
    all.push(...events);
    perRoom.push({ roomId: room.id, title: room.title, kind: room.kind, ...computeCounters(events) });
    const uses = events.filter((e) => e.type === 'member_entered' || e.type === 'member_rejoined').length;
    if (uses >= 2) repeatUse++;
  }
  return {
    generatedAt: Date.now(),
    totals: computeCounters(all),
    rooms: { active: perRoom.length, repeatUse, repeatUseRate: rate(repeatUse, perRoom.length) },
    perRoom,
  };
}
