'use client';

import type { Shiur } from '@/lib/yutorah';

export function TeacherLink({
  shiur,
  onTeacher,
  className = '',
}: {
  shiur: Shiur;
  onTeacher?: (shiur: Shiur) => void;
  className?: string;
}) {
  if (!Number.isSafeInteger(shiur.teacherId) || shiur.teacherId <= 0)
    return <span className={className}>{shiur.teacher}</span>;

  return (
    <a
      className={'teacher-link ' + className}
      href={'/?view=search&teacher=' + shiur.teacherId}
      onClick={(event) => {
        if (
          !onTeacher ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        onTeacher(shiur);
      }}
    >
      {shiur.teacher}
    </a>
  );
}
