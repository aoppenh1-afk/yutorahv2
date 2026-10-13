import type { Follow } from './learning';

export type RemoteFollow = {
  teacher_id: number;
  teacher_name: string;
  image: string | null;
  following: boolean;
  notifications_enabled?: boolean;
};
export type FollowIntent = {
  follow: Follow;
  following: boolean;
  operation: string;
};
export type FollowIntents = Record<string, FollowIntent>;

export function teacherFollowImage(
  follow: Follow,
  teachers: readonly { id: number; image: string }[],
): string {
  return (
    teachers.find((teacher) => teacher.id === follow.id)?.image ||
    follow.image ||
    ''
  );
}

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
        image:
          f.image ||
          local.find(
            (follow) => follow.kind === 'teacher' && follow.id === f.teacher_id,
          )?.image,
        ...(typeof f.notifications_enabled === 'boolean'
          ? { notificationsEnabled: f.notifications_enabled }
          : {}),
      });
  for (const intent of Object.values(pending)) {
    if (intent.following) teachers.set(intent.follow.id, intent.follow);
    else teachers.delete(intent.follow.id);
  }
  // Other follows sync through the private account library.
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
