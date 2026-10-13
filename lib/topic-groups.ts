const leadingGroups = ['Gemara', 'Mishna', 'Parsha', 'Holidays', 'Machshava'];

/** Keep the requested subjects first, other subjects stable, and History last. */
export function orderedTopicGroups(groups: string[]): string[] {
  const unique = [...new Set(groups)];
  return [
    ...leadingGroups.filter((group) => unique.includes(group)),
    ...unique.filter(
      (group) => !leadingGroups.includes(group) && group !== 'History',
    ),
    ...(unique.includes('History') ? ['History'] : []),
  ];
}
