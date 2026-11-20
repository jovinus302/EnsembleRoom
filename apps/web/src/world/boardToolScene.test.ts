import { beforeEach, describe, expect, it } from 'vitest';
import { useBoardToolScene, type BoardToolProp } from './boardToolScene';

const t = (id: string, createdSeq: number): BoardToolProp => ({ id, kind: 'ladder', title: id, ran: false, createdSeq });

describe('boardToolScene', () => {
  beforeEach(() => useBoardToolScene.getState().clear());

  it('처음 채워질 때 이미 있던 도구는 등장 애니메이션 대상이 아니다', () => {
    useBoardToolScene.getState().setRoom('r1', [t('a', 1), t('b', 2)]);
    expect(useBoardToolScene.getState().fresh['r1']).toEqual([]);
  });

  it('이후 새로 생긴 도구만 fresh에 쌓인다', () => {
    const s = useBoardToolScene.getState();
    s.setRoom('r1', [t('a', 1)]);
    s.setRoom('r1', [t('a', 1), t('c', 5)]);
    expect(useBoardToolScene.getState().fresh['r1']).toEqual(['c']);
  });

  it('clear하면 그 방 데이터가 사라진다(포커스 해제)', () => {
    const s = useBoardToolScene.getState();
    s.setRoom('r1', [t('a', 1)]);
    s.setRoom('r2', [t('b', 2)]);
    s.clear('r1');
    expect(useBoardToolScene.getState().byRoom['r1']).toBeUndefined();
    expect(useBoardToolScene.getState().byRoom['r2']).toHaveLength(1);
  });
});
