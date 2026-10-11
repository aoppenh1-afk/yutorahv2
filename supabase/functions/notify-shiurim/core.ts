export type Upload = { id: number; title: string };

export function catalogItems(value: unknown): {
  items: Upload[];
  total: number;
} {
  const data = value as {
    response?: { docs?: Record<string, unknown>[]; numFound?: number };
  };
  if (
    !Array.isArray(data?.response?.docs) ||
    !Number.isSafeInteger(data.response.numFound) ||
    data.response.numFound! < 0
  )
    throw new Error('YUTorah returned an invalid catalog page');
  const items = data.response.docs.map((s) => ({
    id: Number(s.shiurID ?? s.shiurId ?? s.shiurid ?? s.id),
    title: String(s.shiurTitle ?? s.shiurtitle ?? s.title ?? '')
      .trim()
      .slice(0, 250),
  }));
  if (items.some((s) => !Number.isSafeInteger(s.id) || s.id <= 0 || !s.title))
    throw new Error('YUTorah returned an invalid recording');
  return { items, total: data.response.numFound! };
}

export function rssItems(value: unknown): Upload[] {
  const data = value as {
    rss?: {
      channel?: { item?: Record<string, unknown>[] | Record<string, unknown> };
    };
  };
  if (!data?.rss?.channel)
    throw new Error('YUTorah returned an invalid upload feed');
  const raw = data.rss.channel.item;
  const items = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((item) => {
    const link = typeof item.link === 'string' ? item.link : '';
    const id = Number(
      link.match(/(?:lectures\/lecture|shiurim\/shiur)\/(\d+)/i)?.[1],
    );
    return {
      id,
      title: String(item.title ?? '')
        .trim()
        .slice(0, 250),
    };
  });
  if (items.some((s) => !Number.isSafeInteger(s.id) || s.id <= 0 || !s.title))
    throw new Error('YUTorah returned an invalid upload');
  return items;
}

export function validPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return (
      u.protocol === 'https:' &&
      !u.port &&
      !u.username &&
      !u.password &&
      (u.hostname === 'fcm.googleapis.com' ||
        u.hostname === 'updates.push.services.mozilla.com' ||
        /^[a-z0-9-]+\.push\.apple\.com$/.test(u.hostname))
    );
  } catch {
    return false;
  }
}

export function deliveryFailure(status: number | undefined, attempts: number) {
  return {
    remove: status === 404 || status === 410,
    abandon:
      attempts >= 5 ||
      (status !== undefined &&
        status >= 400 &&
        status < 500 &&
        status !== 429 &&
        status !== 408),
    delayMs: Math.min(6 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(attempts, 8)),
  };
}
