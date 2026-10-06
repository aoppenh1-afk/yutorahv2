'use client';
import { Check, Plus } from 'lucide-react';
import type { Follow } from '@/lib/learning';
import type { LibraryState } from '@/lib/library';
export function FollowButton({
  follow,
  library,
  onFollow,
  compact = false,
}: {
  follow: Follow;
  library: LibraryState;
  onFollow: (follow: Follow) => void;
  compact?: boolean;
}) {
  const following = library.following.some(
    (f) => f.kind === follow.kind && f.id === follow.id,
  );
  return (
    <button
      className={
        'follow-button ' +
        (following ? 'is-following' : '') +
        (compact ? ' compact-follow' : '')
      }
      onClick={() => onFollow(follow)}
      aria-pressed={following}
      aria-label={`${following ? 'Unfollow' : 'Follow'} ${follow.name}`}
    >
      {following ? <Check size={14} /> : <Plus size={14} />}
      <span>{following ? 'Following' : 'Follow'}</span>
    </button>
  );
}
