'use client';
import { ArrowRight, BookOpen } from 'lucide-react';
import type { CatalogEntry } from '@/lib/catalog';
import type { LibraryState } from '@/lib/library';
import type { Follow } from '@/lib/learning';
import { FollowButton } from './follow-button';

export function TopicCard({
  topic,
  heading: Heading,
  onOpen,
  library,
  follow,
}: {
  topic: CatalogEntry;
  heading: 'h2' | 'h3';
  onOpen: () => void;
  library: LibraryState;
  follow: (f: Follow) => void;
}) {
  return (
    <article className="catalog-card">
      <button className="catalog-card-main" onClick={onOpen}>
        <span className="catalog-card-icon">
          <BookOpen size={23} />
        </span>
        <div>
          {(topic.path?.length || topic.group) && (
            <span className="catalog-path">
              {topic.path?.slice(0, -1).join(' / ') || topic.group}
            </span>
          )}
          <Heading dir="auto">{topic.name}</Heading>
          {topic.description && (
            <p className="catalog-description" dir="auto">
              {topic.description}
            </p>
          )}
          <span>{topic.count.toLocaleString()} shiurim</span>
        </div>
        <ArrowRight size={17} />
      </button>
      <FollowButton
        follow={{ kind: 'topic', id: topic.id, name: topic.name }}
        library={library}
        onFollow={follow}
      />
    </article>
  );
}
