import { ANSWER_BLOCK_TYPES, type AnswerBlock } from '@ensemble/shared';
import './answerBlocks.css';
import { ChecklistBlock } from './ChecklistBlock';
import { CompareBlock } from './CompareBlock';
import { MoneyBlock } from './MoneyBlock';
import { ProfileBlock } from './ProfileBlock';
import { ScheduleBlock } from './ScheduleBlock';
import { StatusBlock } from './StatusBlock';

const KNOWN = new Set<string>(ANSWER_BLOCK_TYPES);

function One({ block }: { block: AnswerBlock }) {
  switch (block.type) {
    case 'schedule':
      return <ScheduleBlock block={block} />;
    case 'profile':
      return <ProfileBlock block={block} />;
    case 'compare':
      return <CompareBlock block={block} />;
    case 'checklist':
      return <ChecklistBlock block={block} />;
    case 'money':
      return <MoneyBlock block={block} />;
    case 'status':
      return <StatusBlock block={block} />;
    default:
      return null;
  }
}

/** 답변 카드 묶음. 모르는 type은 무시하고, 보일 것이 없으면 아무것도 그리지 않는다. */
export function AnswerBlocks({ blocks }: { blocks?: readonly AnswerBlock[] }) {
  const known = (blocks ?? []).filter((b) => b && KNOWN.has((b as { type: string }).type));
  if (known.length === 0) return null;
  return (
    <div className="ab-root" data-testid="answer-blocks">
      {known.map((b, i) => (
        <One key={i} block={b} />
      ))}
    </div>
  );
}
