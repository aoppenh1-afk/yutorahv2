const entryKey = 'yutorahShiurBase';
type HistoryPort = Pick<
  History,
  'state' | 'pushState' | 'replaceState' | 'back'
>;

/** The underlying page stays intact while a shiur is open over it. */
export function readShiurNavigation(href: string) {
  const url = new URL(href);
  const value = url.searchParams.get('shiur') || '';
  const id = /^[1-9]\d{0,8}$/.test(value) ? value : null;
  const time = url.searchParams.has('t')
    ? Number(url.searchParams.get('t'))
    : NaN;
  url.searchParams.delete('shiur');
  url.searchParams.delete('t');
  return {
    base: url.pathname + url.search + url.hash,
    id,
    seconds: Number.isFinite(time) && time >= 0 ? time : undefined,
  };
}

function currentState(history: HistoryPort): Record<string, unknown> {
  const state: unknown = history.state;
  return state && typeof state === 'object' && !Array.isArray(state)
    ? { ...state }
    : {};
}

/** Related lessons replace the same overlay entry, so Back always dismisses it. */
export function openShiurNavigation(
  history: HistoryPort,
  href: string,
  id: number,
  seconds?: number,
) {
  if (!Number.isSafeInteger(id) || id <= 0 || id > 999_999_999)
    throw new RangeError('Choose a valid shiur.');
  const url = new URL(href);
  const previous = readShiurNavigation(href);
  url.searchParams.set('shiur', String(id));
  if (seconds !== undefined && Number.isFinite(seconds) && seconds >= 0)
    url.searchParams.set('t', String(Math.floor(seconds)));
  else if (previous.id !== String(id)) url.searchParams.delete('t');
  const state = currentState(history);
  if (previous.id) history.replaceState(state, '', url);
  else history.pushState({ ...state, [entryKey]: previous.base }, '', url);
  return previous.base;
}

/** A copied link has no owned entry to go back to; close it in place instead. */
export function closeShiurNavigation(history: HistoryPort, href: string) {
  const { base, id } = readShiurNavigation(href);
  if (!id) return false;
  const state = currentState(history);
  if (state[entryKey] === base) {
    history.back();
    return true;
  }
  delete state[entryKey];
  history.replaceState(state, '', base);
  return false;
}
