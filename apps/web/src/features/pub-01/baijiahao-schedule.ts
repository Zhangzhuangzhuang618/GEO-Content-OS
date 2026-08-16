const DAILY_SCHEDULE_TEMPLATE = Object.freeze([
  '08:00:00',
  '09:30:00',
  '11:00:00',
  '12:30:00',
  '14:00:00',
  '15:30:00',
  '17:00:00',
  '18:30:00',
  '20:00:00',
  '21:30:00',
] as const);

export function automaticBaijiahaoScheduleTimes(targetCount: number): readonly string[] {
  if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 10) {
    throw new RangeError('Baijiahao daily target must be between 1 and 10');
  }
  if (targetCount === 1) return Object.freeze(['10:00:00']);
  const lastIndex = DAILY_SCHEDULE_TEMPLATE.length - 1;
  return Object.freeze(
    Array.from({ length: targetCount }, (_, index) => {
      const templateIndex = Math.round((index * lastIndex) / (targetCount - 1));
      return DAILY_SCHEDULE_TEMPLATE[templateIndex]!;
    }),
  );
}
