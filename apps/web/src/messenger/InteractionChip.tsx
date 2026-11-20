import { useEffect, useState } from 'react';
import { INTERACTION_COLORS, PREVIEW_INTERACTION_WINDOW_MS, type RoomPreviewDetail } from '@ensemble/shared';
import { cvar } from '../ui/tg';

/** 조망 상태 칩: 진행 중인 A2A/A2H의 종류만 보인다(구성원에게만 오는 detail.interaction). pending이 아니면 20초 뒤 숨긴다. */
export function interactionChip(it: RoomPreviewDetail['interaction'], nowMs: number): { label: string; color: string; channel: 'a2a' | 'a2h' } | null {
  if (!it) return null;
  if (!it.pending && nowMs - it.at >= PREVIEW_INTERACTION_WINDOW_MS) return null;
  return it.channel === 'a2a'
    ? { label: 'Agent끼리 조율 중', color: INTERACTION_COLORS.a2a, channel: 'a2a' }
    : { label: '승인 대기', color: INTERACTION_COLORS.a2h, channel: 'a2h' };
}

export function InteractionChip({ interaction }: { interaction: RoomPreviewDetail['interaction'] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!interaction || interaction.pending) return;
    const left = interaction.at + PREVIEW_INTERACTION_WINDOW_MS - Date.now();
    if (left <= 0) return;
    const id = window.setTimeout(() => setNow(Date.now()), left + 50);
    return () => window.clearTimeout(id);
  }, [interaction]);
  const chip = interactionChip(interaction, now);
  if (!chip) return null;
  return (
    <span
      data-testid="room-interaction"
      data-channel={chip.channel}
      className={`tg-chip ${chip.channel === 'a2h' ? 'warn' : 'tonal'} mt-0.5 self-start !h-[18px] !px-2`}
      style={chip.channel === 'a2h' ? undefined : cvar(chip.color)}
    >
      {chip.label}
    </span>
  );
}
