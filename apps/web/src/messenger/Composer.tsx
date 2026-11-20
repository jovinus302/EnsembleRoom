import { useState, type FormEvent, type KeyboardEvent } from 'react';

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
    <form onSubmit={onSubmit} className="flex items-end gap-2 border-t border-line bg-panel px-4 py-3">
      {targets.length > 0 && (
        <>
          <label htmlFor="composer-to" className="sr-only">
            받는 이
          </label>
          <select
            id="composer-to"
            value={toValid}
            onChange={(e) => setTo(e.target.value)}
            className="h-10 max-w-[150px] rounded-lg border border-line bg-bg px-2 text-xs text-muted"
          >
            <option value="">모두에게</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                → {t.name}
              </option>
            ))}
          </select>
        </>
      )}
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
        className="max-h-32 min-h-[40px] flex-1 resize-none rounded-lg border border-line bg-bg px-3 py-2 text-sm placeholder:text-muted"
      />
      <button
        type="submit"
        disabled={disabled || !text.trim()}
        className="h-10 rounded-lg border border-line bg-raised px-4 text-sm font-medium disabled:opacity-40"
      >
        보내기
      </button>
    </form>
  );
}
