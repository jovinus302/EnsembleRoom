import './answerBlocks.css';

/** 카드 정리 중(composing)에 자리를 잡아 두는 뼈대 */
export function BlockSkeleton() {
  return (
    <div className="ab-root" data-testid="ab-skeleton" aria-hidden="true">
      <div className="ab-card ab-skel">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}
