import { useState } from 'react';
import type { Capability, Mandate } from '@ensemble/shared';
import { CAPABILITY_LABEL } from '../messenger/visits';
import { btn } from '../ui/tg';

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
  submitVariant = 'primary',
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
  /** 제출 버튼 위계: 기본 primary, 방을 비우는 등 주 행동이면 cta */
  submitVariant?: 'primary' | 'cta';
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
      className="flex flex-col gap-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (required && !trimmed) return;
        onSubmit(trimmed ? { text: trimmed, allowedActions: actions } : undefined);
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className="tg-mono">{label}</span>
        <textarea
          data-testid="mandate-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={500}
          rows={4}
          placeholder={placeholder}
          className="tg-field resize-none"
        />
        <span className="tg-aux self-end">{text.length}/500</span>
      </label>
      <fieldset className="flex flex-col gap-2" data-testid="mandate-actions">
        <legend className="tg-mono mb-1.5">허용할 행동</legend>
        {grants.map((c) => (
          <label key={c} className={`tg-opt${actions.includes(c) ? ' on' : ''}`}>
            <input type="checkbox" className="sr-only" checked={actions.includes(c)} onChange={() => toggle(c)} />
            <span className="r" aria-hidden="true" />
            <span className="flex flex-col">
              <span className="font-semibold">{CAPABILITY_LABEL[c]}</span>
              {CAPABILITY_HINT[c] && <span className="tg-aux">{CAPABILITY_HINT[c]}</span>}
            </span>
          </label>
        ))}
      </fieldset>
      {error && (
        <p role="alert" className="text-aux text-danger">
          {error}
        </p>
      )}
      <div className="sh-f">
        <button type="button" onClick={onCancel} className={btn('ghost')}>
          취소
        </button>
        <button
          type="submit"
          data-testid="mandate-submit"
          disabled={busy || (required && !trimmed)}
          className={btn(submitVariant)}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
