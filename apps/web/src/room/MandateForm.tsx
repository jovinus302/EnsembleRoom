import { useState } from 'react';
import type { Capability, Mandate } from '@ensemble/shared';
import { CAPABILITY_LABEL } from '../messenger/visits';

/** 허용 행동 설명 (위임 메모 아래에 보인다) */
const CAPABILITY_HINT: Partial<Record<Capability, string>> = {
  chat: 'Room에서 대신 말해요',
  comment: '카드에 댓글을 달아요',
  propose_edit: '카드 수정안을 내요(승인 필요)',
  request_approval: '결정이 필요하면 나에게 승인을 요청해요',
};

/** 위임 메모(문구 + 허용 행동). LeaveSheet와 SendAgentSheet가 공유한다. */
export function MandateForm({
  label,
  placeholder,
  grants,
  defaultActions,
  submitLabel,
  required,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  label: string;
  placeholder: string;
  grants: readonly Capability[];
  defaultActions: readonly Capability[];
  submitLabel: string;
  required: boolean;
  busy: boolean;
  error?: string | null;
  onSubmit: (m: Mandate | undefined) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [actions, setActions] = useState<Capability[]>([...defaultActions]);
  const toggle = (c: Capability) => setActions((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));
  const trimmed = text.trim();
  return (
    <form
      className="mt-4 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (required && !trimmed) return;
        onSubmit(trimmed ? { text: trimmed, allowedActions: actions } : undefined);
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-muted">
        {label}
        <textarea
          data-testid="mandate-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={500}
          rows={4}
          placeholder={placeholder}
          className="resize-none rounded-md border border-line bg-bg px-2.5 py-2 text-sm text-fg placeholder:text-muted"
        />
        <span className="self-end">{text.length}/500</span>
      </label>
      <fieldset className="flex flex-col gap-1.5 text-sm" data-testid="mandate-actions">
        <legend className="mb-1 text-xs text-muted">허용할 행동</legend>
        {grants.map((c) => (
          <label key={c} className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={actions.includes(c)} onChange={() => toggle(c)} />
            <span>
              {CAPABILITY_LABEL[c]}
              {CAPABILITY_HINT[c] && <span className="ml-1.5 text-xs text-muted">{CAPABILITY_HINT[c]}</span>}
            </span>
          </label>
        ))}
      </fieldset>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          data-testid="mandate-submit"
          disabled={busy || (required && !trimmed)}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-[var(--on-accent-strong)] disabled:opacity-50"
        >
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="rounded-md border border-line px-4 py-1.5 text-sm hover:bg-raised">
          취소
        </button>
      </div>
    </form>
  );
}
