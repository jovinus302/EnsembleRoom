import { z } from 'zod';

/** 답변 블록: Agent 가 구조화된 답(일정·프로필·비교 등)을 메시지에 첨부하는 형식. */

const id = z.string().min(1);
const str = (max: number) => z.string().min(1).max(max);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

/** 근거 칩: 어떤 기억/방/이벤트에서 나온 정보인지 */
export const SourceChipSchema = z.object({
  kind: z.enum(['memory', 'room', 'event']),
  label: str(40),
  roomId: id.optional(),
});
export type SourceChip = z.infer<typeof SourceChipSchema>;

const sources = z.array(SourceChipSchema).max(4).optional();

/* schedule */
export const ScheduleItemSchema = z.object({
  start: hhmm.optional(),
  end: hhmm.optional(),
  when: str(12).optional(),
  title: str(60),
  with: str(40).optional(),
  room: str(30).optional(),
  status: z.enum(['fixed', 'tentative', 'pending', 'free', 'conflict']),
  sources,
});
export type ScheduleItem = z.infer<typeof ScheduleItemSchema>;

export const ScheduleAnswerBlockSchema = z.object({
  type: z.literal('schedule'),
  title: str(60).optional(),
  days: z.array(z.object({ label: str(20), items: z.array(ScheduleItemSchema).max(8) })).max(7),
  verdict: str(80).optional(),
});
export type ScheduleAnswerBlock = z.infer<typeof ScheduleAnswerBlockSchema>;

/* profile */
export const ProfileChipSchema = z.object({
  text: str(30),
  tone: z.enum(['like', 'dislike', 'note']),
  sources,
});
export type ProfileChip = z.infer<typeof ProfileChipSchema>;

export const ProfileAnswerBlockSchema = z.object({
  type: z.literal('profile'),
  title: str(40),
  groups: z.array(z.object({ label: str(20), chips: z.array(ProfileChipSchema).max(6) })).max(4),
});
export type ProfileAnswerBlock = z.infer<typeof ProfileAnswerBlockSchema>;

/* compare */
export const CompareOptionSchema = z.object({
  label: str(40),
  pros: z.array(str(60)).max(3).optional(),
  cons: z.array(str(60)).max(3).optional(),
  people: z
    .array(z.object({ name: str(40), ok: z.enum(['yes', 'no', 'maybe']), note: str(60).optional() }))
    .max(6)
    .optional(),
  recommended: z.boolean().optional(),
});
export type CompareOption = z.infer<typeof CompareOptionSchema>;

export const CompareAnswerBlockSchema = z.object({
  type: z.literal('compare'),
  question: str(80),
  options: z.array(CompareOptionSchema).min(2).max(4),
  recommendation: str(80).optional(),
});
export type CompareAnswerBlock = z.infer<typeof CompareAnswerBlockSchema>;

/* checklist */
export const ChecklistItemSchema = z.object({
  text: str(60),
  due: str(30).optional(),
  room: str(30).optional(),
  done: z.boolean().optional(),
  sources,
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const ChecklistAnswerBlockSchema = z.object({
  type: z.literal('checklist'),
  title: str(60),
  items: z.array(ChecklistItemSchema).max(8),
});
export type ChecklistAnswerBlock = z.infer<typeof ChecklistAnswerBlockSchema>;

/* money */
export const MoneyLineSchema = z.object({
  label: str(60),
  amount: z.number().int(),
  from: str(40).optional(),
  to: str(40).optional(),
});
export type MoneyLine = z.infer<typeof MoneyLineSchema>;

export const MoneyAnswerBlockSchema = z.object({
  type: z.literal('money'),
  title: str(60),
  total: z.number().int().optional(),
  lines: z.array(MoneyLineSchema).max(8),
  note: str(80).optional(),
});
export type MoneyAnswerBlock = z.infer<typeof MoneyAnswerBlockSchema>;

/* status */
export const StatusItemSchema = z.object({
  text: str(60),
  state: z.enum(['decided', 'pending_approval', 'waiting', 'todo']),
  sources,
});
export type StatusItem = z.infer<typeof StatusItemSchema>;

export const StatusAnswerBlockSchema = z.object({
  type: z.literal('status'),
  rooms: z.array(z.object({ room: str(30), items: z.array(StatusItemSchema).max(4) })).max(4),
});
export type StatusAnswerBlock = z.infer<typeof StatusAnswerBlockSchema>;

export const AnswerBlockSchema = z.discriminatedUnion('type', [
  ScheduleAnswerBlockSchema,
  ProfileAnswerBlockSchema,
  CompareAnswerBlockSchema,
  ChecklistAnswerBlockSchema,
  MoneyAnswerBlockSchema,
  StatusAnswerBlockSchema,
]);
export type AnswerBlock = z.infer<typeof AnswerBlockSchema>;

export const ANSWER_BLOCK_TYPES = ['schedule', 'profile', 'compare', 'checklist', 'money', 'status'] as const;
export type AnswerBlockType = (typeof ANSWER_BLOCK_TYPES)[number];

export const MAX_BLOCKS_PER_MESSAGE = 2;
