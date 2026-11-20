import { describe, expect, it } from 'vitest';
import { allowedTools, can, effectiveCapabilities, type Capability, type PermissionSubject, type VisitGrant } from '../src';

const active = (permissions: Capability[]): VisitGrant => ({ status: 'active', permissions });

describe('effectiveCapabilities (계획 6절 권한 표)', () => {
  it('my Room 소유자(사람): 전부', () => {
    expect(effectiveCapabilities({ kind: 'human', relation: 'owner', roomKind: 'my' })).toEqual([
      'chat',
      'comment',
      'edit_board',
      'propose_edit',
      'remember',
      'request_approval',
    ]);
  });

  it('소유자 Agent 동행 중: chat, comment, edit_board, remember', () => {
    const caps = effectiveCapabilities({ kind: 'agent', mode: 'accompanied', roomKind: 'my' });
    expect(caps).toEqual(expect.arrayContaining(['chat', 'comment', 'edit_board', 'remember']));
    expect(caps).not.toContain('propose_edit');
  });

  it('대리 참여로 강등: edit_board가 사라지고 propose_edit이 생긴다', () => {
    const accompanied = effectiveCapabilities({ kind: 'agent', mode: 'accompanied', roomKind: 'my' });
    const representing = effectiveCapabilities({ kind: 'agent', mode: 'representing', roomKind: 'my' });
    expect(accompanied).toContain('edit_board');
    expect(representing).not.toContain('edit_board');
    expect(representing).toContain('propose_edit');
    expect(representing).toEqual(expect.arrayContaining(['chat', 'comment']));
  });

  it('방문자(사람): grant ⊆ {chat, comment, propose_edit}', () => {
    const s = (perms: Capability[]): PermissionSubject => ({ kind: 'human', relation: 'visitor', visit: active(perms) });
    expect(effectiveCapabilities(s(['chat', 'comment']))).toEqual(['chat', 'comment']);
    // 소유자 전용 권한을 grant에 넣어도 걸러진다
    expect(effectiveCapabilities(s(['chat', 'edit_board', 'remember', 'request_approval', 'propose_edit']))).toEqual([
      'chat',
      'propose_edit',
    ]);
  });

  it('방문이 active가 아니면 방문자는 아무 권한이 없다', () => {
    for (const status of ['requested', 'ended', 'declined'] as const) {
      expect(
        effectiveCapabilities({ kind: 'human', relation: 'visitor', visit: { status, permissions: ['chat'] } }),
      ).toEqual([]);
    }
  });

  it('방문 Agent: grant ∩ mandate.allowedActions이고 edit_board와 remember는 절대 없다', () => {
    const visiting = (grant: Capability[], mandate: Capability[]): PermissionSubject => ({
      kind: 'agent',
      mode: 'visiting',
      visit: active(grant),
      mandateActions: mandate,
    });
    expect(effectiveCapabilities(visiting(['chat', 'comment', 'propose_edit'], ['chat', 'comment']))).toEqual(['chat', 'comment']);
    // grant와 mandate가 모두 넓어도 edit_board, remember는 없다
    const all: Capability[] = ['chat', 'comment', 'edit_board', 'propose_edit', 'remember', 'request_approval'];
    const caps = effectiveCapabilities(visiting(all, all));
    expect(caps).not.toContain('edit_board');
    expect(caps).not.toContain('remember');
    expect(caps).toEqual(['chat', 'comment', 'propose_edit', 'request_approval']);
    // mandate 밖의 것은 grant에 있어도 없다
    expect(effectiveCapabilities(visiting(['chat', 'comment'], ['chat']))).toEqual(['chat']);
    // 방문이 끝났으면 없다
    expect(
      effectiveCapabilities({
        kind: 'agent',
        mode: 'visiting',
        visit: { status: 'ended', permissions: all },
        mandateActions: all,
      }),
    ).toEqual([]);
  });

  it('Our Room 구성원(사람): chat, comment, edit_board', () => {
    expect(effectiveCapabilities({ kind: 'human', relation: 'member', roomKind: 'our' })).toEqual(['chat', 'comment', 'edit_board']);
  });

  it('Our Room 구성원 Agent: chat, comment, propose_edit, remember (edit_board 없음)', () => {
    const caps = effectiveCapabilities({ kind: 'agent', mode: 'member', roomKind: 'our' });
    expect(caps).toEqual(expect.arrayContaining(['chat', 'comment', 'propose_edit', 'remember']));
    expect(caps).not.toContain('edit_board');
  });

  it('Room Agent: chat, comment, propose_edit, request_approval (remember, edit_board 없음)', () => {
    expect(effectiveCapabilities({ kind: 'room_agent' })).toEqual(['chat', 'comment', 'propose_edit', 'request_approval']);
  });

  it('DM 구성원은 대화만, 남의 my Room 소유자 취급은 없다', () => {
    expect(effectiveCapabilities({ kind: 'human', relation: 'member', roomKind: 'dm' })).toEqual(['chat']);
    expect(effectiveCapabilities({ kind: 'human', relation: 'owner', roomKind: 'our' })).toEqual([]);
  });

  it('can()은 effectiveCapabilities와 같다', () => {
    const s: PermissionSubject = { kind: 'agent', mode: 'representing', roomKind: 'my' };
    expect(can(s, 'propose_edit')).toBe(true);
    expect(can(s, 'edit_board')).toBe(false);
  });
});

describe('allowedTools (권한으로 걸러서 쓸 수 없는 도구는 주지 않는다)', () => {
  it('사람에게는 도구가 없다', () => {
    expect(allowedTools({ kind: 'human', relation: 'owner', roomKind: 'my' })).toEqual([]);
  });

  it('방문 Agent는 end_visit과 pass가 있고 edit_board·remember 도구는 없다', () => {
    const tools = allowedTools({
      kind: 'agent',
      mode: 'visiting',
      visit: active(['chat', 'comment', 'propose_edit', 'edit_board', 'remember']),
      mandateActions: ['chat', 'comment', 'propose_edit', 'edit_board', 'remember'],
    });
    expect(tools).toEqual(['say', 'comment', 'propose_edit', 'end_visit', 'pass']);
  });

  it('동행 Agent는 edit_board가 있고 end_visit은 없다', () => {
    const tools = allowedTools({ kind: 'agent', mode: 'accompanied', roomKind: 'my' });
    expect(tools).toContain('edit_board');
    expect(tools).toContain('remember');
    expect(tools).not.toContain('end_visit');
    expect(tools.at(-1)).toBe('pass');
  });

  it('대리 참여 Agent는 edit_board 도구가 없다', () => {
    expect(allowedTools({ kind: 'agent', mode: 'representing', roomKind: 'my' })).not.toContain('edit_board');
  });

  it('Room Agent는 say, comment, propose_edit, request_approval, pass', () => {
    expect(allowedTools({ kind: 'room_agent' })).toEqual(['say', 'comment', 'propose_edit', 'request_approval', 'pass']);
  });

  it('끝난 방문의 Agent는 pass만 남는다', () => {
    expect(
      allowedTools({ kind: 'agent', mode: 'visiting', visit: { status: 'ended', permissions: ['chat'] }, mandateActions: ['chat'] }),
    ).toEqual(['pass']);
  });
});
