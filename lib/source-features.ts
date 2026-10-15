export type SourceFeatures = { links: boolean; sheets: boolean };

/** Server switches are independent; neither output is required by the other. */
export function sourceFeatures(
  env: Record<string, string | undefined> = process.env,
): SourceFeatures {
  const enabled = (value: string | undefined) =>
    !/^(?:0|false|off|no)$/i.test(value?.trim() ?? '');
  return {
    links: enabled(env.SOURCES_LINKS_ENABLED),
    sheets: enabled(env.SOURCES_SHEETS_ENABLED),
  };
}
