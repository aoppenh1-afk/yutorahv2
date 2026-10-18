'use client';
import { BookOpen, ChevronRight, Library, MapPin, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import type { BrowseKind } from '@/lib/catalog';
import type { Shiur } from '@/lib/yutorah';
import type {
  CatalogSearchMatch,
  MixedSearchMatch,
} from '@/lib/search-results';
import { entityLink } from '@/lib/legacy-links';
import { Avatar } from './ui';
import { CatalogCover } from './catalog-cover';
import { PagedItems } from './paged-items';

const labels: Record<BrowseKind, string> = {
  teacher: 'Teacher',
  series: 'Series',
  collection: 'Collection',
  venue: 'Venue',
  topic: 'Topic',
};
const icons = {
  teacher: Users,
  series: Library,
  collection: Library,
  venue: MapPin,
  topic: BookOpen,
};

function CatalogResult({
  page,
  grid,
  onOpen,
}: {
  page: CatalogSearchMatch;
  grid: boolean;
  onOpen: (kind: BrowseKind, id: number) => void;
}) {
  const Icon = icons[page.kind];
  return (
    <a
      className={
        'page-result ' + (grid ? 'page-result-card' : 'page-result-row')
      }
      href={entityLink(page.kind, page.id)}
      aria-label={`Open ${labels[page.kind].toLowerCase()}: ${page.name}`}
      onClick={(event) => {
        if (
          event.button ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        onOpen(page.kind, page.id);
      }}
    >
      <span
        className={
          'page-result-art' + (page.kind === 'teacher' ? ' is-teacher' : '')
        }
      >
        {page.kind === 'teacher' ? (
          <Avatar src={page.image || ''} name={page.name} />
        ) : page.kind === 'series' || page.kind === 'collection' ? (
          <CatalogCover
            kind={page.kind}
            id={page.id}
            image={page.image}
            resolved={page.artworkKnown}
          />
        ) : (
          <Icon size={26} />
        )}
      </span>
      <div className="page-result-copy">
        <span className="page-result-type">
          <Icon size={13} />
          {labels[page.kind]}
        </span>
        <h3 dir="auto">{page.name}</h3>
        <span className="page-result-meta">
          {page.count.toLocaleString()} shiurim
          {page.group && <span> · {page.group}</span>}
        </span>
      </div>
      <span className="page-result-action">
        Open {labels[page.kind].toLowerCase()}
        <ChevronRight size={17} />
      </span>
    </a>
  );
}

export function MixedSearchResults({
  matches,
  grid,
  onOpen,
  renderShiur,
}: {
  matches: MixedSearchMatch[];
  grid: boolean;
  onOpen: (kind: BrowseKind, id: number) => void;
  renderShiur: (shiur: Shiur, index: number) => ReactNode;
}) {
  return (
    <div
      className={
        'mixed-search-results ' + (grid ? 'shiur-grid' : 'results-list')
      }
    >
      <PagedItems items={matches}>
        {(visible) =>
          visible.map((match, index) =>
            match.kind === 'page' ? (
              <CatalogResult
                key={`${match.page.kind}-${match.page.id}`}
                page={match.page}
                grid={grid}
                onOpen={onOpen}
              />
            ) : (
              renderShiur(match.shiur, index)
            ),
          )
        }
      </PagedItems>
    </div>
  );
}
