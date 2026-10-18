/* oxlint-disable next/no-img-element -- Public YUTorah catalog artwork. */
'use client';
import { useEffect, useRef, useState } from 'react';
import { BookOpen } from 'lucide-react';
import type { BrowseKind } from '@/lib/catalog';
import { Avatar } from './ui';
import {
  cachedCatalogResource,
  loadCatalogResource,
} from '@/lib/catalog-client';

export function CatalogCover({
  kind,
  id,
  image,
  large = false,
  resolved = false,
}: {
  kind: BrowseKind;
  id: number;
  image?: string;
  large?: boolean;
  resolved?: boolean;
}) {
  const [artwork, setArtwork] = useState<{ id: number; image: string } | null>(
    null,
  );
  const url = '/api/catalog-artwork?id=' + id + '&format=json';
  const source =
    image ||
    (kind === 'collection'
      ? cachedCatalogResource<{ image: string }>(url)?.image
      : '') ||
    (artwork?.id === id ? artwork.image : '');
  const element = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const target = element.current;
    if (!target || kind !== 'collection' || image || resolved) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '160px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [kind, image, id, resolved]);
  useEffect(() => {
    if (kind !== 'collection' || image || !visible || resolved) return;
    let active = true;
    loadCatalogResource<{ image: string }>(url)
      .then((data) => {
        if (active)
          setArtwork({
            id,
            image: typeof data.image === 'string' ? data.image : '',
          });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [kind, id, image, visible, url, resolved]);
  return (
    <span
      className={'catalog-cover' + (large ? ' catalog-cover-large' : '')}
      ref={element}
      aria-hidden="true"
    >
      {source ? (
        <Avatar
          src={source}
          name=""
          fallback={<BookOpen size={large ? 40 : 23} />}
        />
      ) : (
        <BookOpen size={large ? 40 : 23} />
      )}
    </span>
  );
}
