import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { btn } from '../ui/tg';

/** 화면 가운데 모달 시트. Esc와 배경 클릭으로 닫는다. 3D가 붙어도 DOM 오버레이로 그대로 쓴다. */
export function Sheet({
  title,
  eyebrow,
  onClose,
  children,
  testId,
}: {
  title: string;
  /** 제목 위 작은 영문 대문자 라벨 (목업 .mono) */
  eyebrow?: string;
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
  // 스크림과 패널은 형제다: 스크림만 페이드하고, 패널의 조상에는 opacity 애니메이션을 걸지 않는다(패널 blur 유지).
  return createPortal(
    <div
      className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="tg-scrim tg-sheet-scrim" aria-hidden="true" onMouseDown={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-testid={testId}
        className="tg-panel tg-sheet tg-sheet-in max-h-[90vh] overflow-y-auto outline-none"
      >
        <div className="sh-h">
          <div className="min-w-0">
            {eyebrow && <div className="tg-mono">{eyebrow}</div>}
            <h2 className="tg-title">{title}</h2>
          </div>
          <button type="button" aria-label="닫기" onClick={onClose} className={`${btn('ghost', { round: true })} shrink-0`}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
