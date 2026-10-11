import type { Follow } from './learning';

export type RemoteFollow = {
  teacher_id: number;
  teacher_name: string;
  image: string | null;
  following: boolean;
};
export type FollowIntent = {
  follow: Follow;
  following: boolean;
  operation: string;
};
export type FollowIntents = Record<string, FollowIntent>;

export function mergeTeacherFollows(
  local: Follow[],
  remote: RemoteFollow[],
  pending: FollowIntents,
): Follow[] {
  const teachers = new Map<number, Follow>();
  for (const f of remote)
    if (f.following)
      teachers.set(f.teacher_id, {
        kind: 'teacher',
        id: f.teacher_id,
        name: f.teacher_name,
        image: f.image ?? undefined,
      });
  for (const intent of Object.values(pending)) {
    if (intent.following) teachers.set(intent.follow.id, intent.follow);
    else teachers.delete(intent.follow.id);
  }
  // Topics and series continue to be local preferences.
  return [...teachers.values(), ...local.filter((f) => f.kind !== 'teacher')];
}

export function followsToImport(
  local: Follow[],
  remote: RemoteFollow[],
  owner: string | null,
  userId: string,
): Follow[] {
  if (owner && owner !== userId) return [];
  const known = new Set(remote.map((f) => f.teacher_id));
  // A remote unfollow is a tombstone. Another device must not resurrect it.
  return local.filter((f) => f.kind === 'teacher' && !known.has(f.id));
}
