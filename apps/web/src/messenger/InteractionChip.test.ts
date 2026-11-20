import { describe, expect, it } from 'vitest';
import { interactionChip } from './InteractionChip';

const it0 = { channel: 'a2a' as const, fromId: 'ra', toIds: ['ag'], seq: 1, at: 1000, pending: true };
describe('interactionChip', () => {
  it('없으면 null, A2A는 조율 중, A2H는 승인 대기', () => {
    expect(interactionChip(null, 0)).toBeNull();
    expect(interactionChip(undefined, 0)).toBeNull();
    expect(interactionChip(it0, 99999)?.label).toBe('Agent끼리 조율 중');
    expect(interactionChip({ ...it0, channel: 'a2h' }, 99999)?.label).toBe('승인 대기');
  });
  it('pending이 아니면 20초 뒤 숨긴다', () => {
    const done = { ...it0, pending: false };
    expect(interactionChip(done, 1000 + 19000)).not.toBeNull();
    expect(interactionChip(done, 1000 + 20000)).toBeNull();
  });
});
