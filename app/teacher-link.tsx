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
  const speakers = shiur.speakers?.length
    ? shiur.speakers
    : [{ id: shiur.teacherId, name: shiur.teacher, image: shiur.image }];
  return (
    <span className={'teacher-credits ' + className}>
      {speakers.map((speaker, index) => (
        <span key={speaker.id + ':' + index}>
          {index > 0 && <span className="credit-separator"> · </span>}
          {speaker.id > 0 ? (
            <a
              className="teacher-link"
              href={'/?view=entity&kind=teacher&id=' + speaker.id}
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
                onTeacher({
                  ...shiur,
                  teacherId: speaker.id,
                  teacher: speaker.name,
                  image: speaker.image,
                  speakers: [speaker],
                });
              }}
            >
              {speaker.name}
            </a>
          ) : (
            speaker.name
          )}
        </span>
      ))}
    </span>
  );
}
