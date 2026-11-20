import { useState } from 'react';
import { AnswerBlocks } from './AnswerBlocks';
import { BlockSkeleton } from './BlockSkeleton';
import { SAMPLE_BLOCKS } from './samples';

/** 개발용 답변 카드 랩(/lab/answer-blocks): 서버·로그인 없이 6종을 한 화면에 보인다. ?w=360 으로 좁은 폭 확인. */
export function AnswerBlocksLab() {
  const w = Number(new URLSearchParams(location.search).get('w')) || 640;
  const [width] = useState(w);
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--fg)', padding: 24, display: 'flex', justifyContent: 'center' }}>
      <div style={{ width, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {Object.entries(SAMPLE_BLOCKS).map(([k, b]) => (
          <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>{k}</span>
            <AnswerBlocks blocks={[b]} />
          </div>
        ))}
        <div>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>skeleton</span>
          <BlockSkeleton />
        </div>
      </div>
    </div>
  );
}
