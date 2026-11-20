import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** 화면 가운데 모달 시트. Esc와 배경 클릭으로 닫는다. 3D가 붙어도 DOM 오버레이로 그대로 쓴다. */
export function Sheet({
  title,
  onClose,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  // App 셸(z-10 stacking context) 안에 두면 body 직속 스테이지 크롬(z-30)·fx(z-40)에 가려진다.
  // body로 portal해서 모든 시트가 한 곳에서 최상위 계층(z-50)을 갖게 한다.
  return createPortal(
    <div
      className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-testid={testId}
        className="anim-card max-h-[90vh] w-full max-w-[520px] overflow-y-auto rounded-2xl border border-line bg-[#151d30] p-5 shadow-2xl outline-none"
      >
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            type="button"
            aria-label="닫기"
            onClick={onClose}
            className="ml-auto rounded-md px-2 py-0.5 text-lg leading-none text-muted hover:bg-raised hover:text-fg"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
