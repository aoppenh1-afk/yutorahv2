'use client';
import { useEffect, useState } from 'react';
import { BookOpen, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Shiur } from '@/lib/yutorah';
import type { CollectionData } from '@/lib/catalog';
export function CollectionContext({
  shiur,
  onOpen,
  onDetails,
}: {
  shiur: Shiur;
  onOpen: (id: number) => void;
  onDetails: (s: Shiur) => void;
}) {
  const [selected, setSelected] = useState(shiur.collections?.[0]?.id || 0),
    [data, setData] = useState<CollectionData | null>(null),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  const memberships = shiur.collections || [];
  const membership = memberships.map((c) => c.id).join(',');
  useEffect(() => {
    const ids = membership.split(',').map(Number);
    setSelected((old) => (ids.includes(old) ? old : ids[0] || 0));
  }, [shiur.id, membership]);
  useEffect(() => {
    setData(null);
    setError('');
    if (!selected) return;
    const abort = new AbortController();
    fetch('/api/catalog?action=entity&kind=collection&id=' + selected, {
      signal: abort.signal,
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        return d as CollectionData;
      })
      .then((d) => {
        if (!abort.signal.aborted) setData(d);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [selected, retry]);
  if (!memberships.length) return null;
  const index = data?.items.findIndex((s) => s.id === shiur.id) ?? -1;
  const go = (s: Shiur) =>
    onDetails({
      ...s,
      collections: [
        { id: selected, name: data?.name || '' },
        ...(s.collections || []).filter((c) => c.id !== selected),
      ],
    });
  return (
    <section className="detail-collection" aria-label="Collection">
      {memberships.length > 1 && (
        <select
          aria-label="Shiur collection"
          value={selected}
          onChange={(e) => setSelected(Number(e.target.value))}
        >
          {memberships.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name || 'Collection ' + c.id}
            </option>
          ))}
        </select>
      )}
      <div className="detail-collection-card">
        <button
          className="detail-collection-open"
          onClick={() => onOpen(selected)}
        >
          <BookOpen size={18} />
          <span>
            <strong dir="auto">
              {data?.name ||
                memberships.find((c) => c.id === selected)?.name ||
                'Open collection'}
            </strong>
            <small>
              {index >= 0 && data
                ? `Lesson ${index + 1} of ${data.items.length}`
                : 'Collection'}
            </small>
          </span>
        </button>
        {index >= 0 && data && (
          <nav aria-label="Collection lessons">
            <button
              className="detail-collection-step"
              aria-label="Previous lesson"
              title="Previous lesson"
              disabled={index === 0}
              onClick={() => go(data.items[index - 1])}
            >
              <ChevronLeft size={18} />
            </button>
            <button
              className="detail-collection-step"
              aria-label="Next lesson"
              title="Next lesson"
              disabled={index === data.items.length - 1}
              onClick={() => go(data.items[index + 1])}
            >
              <ChevronRight size={18} />
            </button>
          </nav>
        )}
      </div>
      {error && (
        <p className="inline-error">
          {error} <button onClick={() => setRetry((n) => n + 1)}>Retry</button>
        </p>
      )}
    </section>
  );
}
