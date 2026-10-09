export function fetchOfficialVtt(
  id: string,
  signal: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<string | null>;
