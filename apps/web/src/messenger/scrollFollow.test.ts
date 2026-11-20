import { describe, expect, it } from 'vitest';
import { isNearBottom, onContentGrow, sentByMe } from './scrollFollow';

describe('scrollFollow', () => {
  it('맨 아래 80px 이내면 near', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 420, clientHeight: 500 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 419, clientHeight: 500 })).toBe(false);
  });
  it('따라가는 중이면 맨 아래로, 아니면 안내 버튼', () => {
    expect(onContentGrow(true)).toEqual({ scrollToBottom: true, showJump: false });
    expect(onContentGrow(false)).toEqual({ scrollToBottom: false, showJump: true });
  });
  it('내가 보내면(pending 증가) 강제 하단', () => {
    expect(sentByMe(0, 1)).toBe(true);
    expect(sentByMe(1, 1)).toBe(false);
    expect(sentByMe(2, 1)).toBe(false);
  });
});
