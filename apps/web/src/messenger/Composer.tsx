import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { btn } from '../ui/tg';

export interface ComposerTarget {
  id: string;
  name: string;
}

export function Composer({
  onSend,
  placeholder,
  targets = [],
  disabledReason,
}: {
  onSend: (text: string, to?: string) => void;
  placeholder: string;
  /** 지정해서 말할 수 있는 Agent. 비어 있으면 받는 이 선택을 숨긴다. */
  targets?: ComposerTarget[];
  /** 값이 있으면 입력을 막고 이유를 보인다 (타임라인 재생 중, Leave 중 등) */
  disabledReason?: string;
}) {
  const disabled = !!disabledReason;
  const [text, setText] = useState('');
  const [to, setTo] = useState('');
  const toValid = targets.some((t) => t.id === to) ? to : '';

  function submit() {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t, toValid || undefined);
    setText('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // 한글 IME 조합 중 Enter는 글자 확정이므로 전송하지 않는다.
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submit();
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    submit();
  }

  return (
    <form onSubmit={onSubmit} data-tour="composer" className="tg-input m-3 mt-0 flex-wrap">
      {targets.length > 0 && (
        <>
          <label htmlFor="composer-to" className="sr-only">
            받는 이
          </label>
          <span className="relative inline-flex shrink-0">
          <select
            id="composer-to"
            value={toValid}
            onChange={(e) => setTo(e.target.value)}
            className={`${btn('soft')} max-w-[130px] shrink-0 appearance-none !pr-7 text-aux`}
          >
            <option value="">모두에게</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                → {t.name}
              </option>
            ))}
          </select>
          <span aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[length:var(--fs-label)] opacity-70">▾</span>
          </span>
        </>
      )}
      {/* 좁은 폭에서 줄바꿈되더라도 입력창과 전송 버튼은 같은 줄에 머문다 */}
      <div className="flex min-w-0 flex-1 basis-[200px] items-center gap-2">
        <label htmlFor="composer-input" className="sr-only">
          메시지 입력
        </label>
        <textarea
          id="composer-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={disabledReason ?? placeholder}
          disabled={disabled}
          className="max-h-32 min-h-[32px] min-w-[120px] flex-1 resize-none bg-transparent px-1 py-1.5 text-body placeholder:text-muted"
        />
        <button
          type="submit"
          disabled={disabled || !text.trim()}
          aria-label="보내기"
          className={`${btn('primary', { round: true })} shrink-0`}
        >
          <span aria-hidden="true">↑</span>
        </button>
      </div>
    </form>
  );
}
