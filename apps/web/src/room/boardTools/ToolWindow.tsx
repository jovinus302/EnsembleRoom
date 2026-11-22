import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * 보드 도구 창. 공용 Sheet(제목 줄 + 안쪽 여백)와 같은 동작(Esc·배경 클릭으로 닫기, 포커스 복귀, body portal)을 하되
 * 종류 색 헤더를 맨 위에 직접 그린다. 배경·글자는 전역 토큰(--bg --fg)을 따른다.
 */
export function ToolWindow({
  title,
  onClose,
  testId,
  header,
  style,
  children,
}: {
  title: string;
  onClose: () => void;
  testId?: string;
  header: ReactNode;
  style?: CSSProperties;
  children: ReactNode;
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
  return createPortal(
    <div
      className="tg-scrim pointer-events-auto fixed inset-0 z-50 flex items-center justify-center p-4"
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
        className="tg-panel tg-toolwin tool-window max-h-[90vh] w-full max-w-[560px] overflow-y-auto outline-none"
        style={style}
      >
        {header}
        {children}
      </div>
    </div>,
    document.body,
  );
}
