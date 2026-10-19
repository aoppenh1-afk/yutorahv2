type Event =
  | 'catalog_snapshot'
  | 'upstream_cache'
  | 'upstream_read'
  | 'search_cache'
  | 'search_pass'
  | 'search_transaction'
  | 'trending_snapshot'
  | 'transcript_read_cache'
  | 'audio_preparation';
/** Aggregate-only samples: never accept query text, SQL, IDs or request payloads. */
export function performanceSample(
  event: Event,
  values: Record<string, number>,
) {
  if ('window' in globalThis) return;
  const rate = Number(process.env.PERFORMANCE_SAMPLE_RATE ?? '0.01');
  if (!Number.isFinite(rate) || rate <= 0 || Math.random() >= Math.min(1, rate))
    return;
  const metrics = Object.fromEntries(
    Object.entries(values).filter(
      ([, value]) => Number.isFinite(value) && Math.abs(value) <= 1e12,
    ),
  );
  console.log(
    JSON.stringify({ event: 'performance', phase: event, ...metrics }),
  );
}
