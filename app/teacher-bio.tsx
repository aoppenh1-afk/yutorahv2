'use client';

import { useEffect, useId, useRef, useState } from 'react';

export function TeacherBio({ description }: { description: string }) {
  const id = useId();
  const paragraph = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const element = paragraph.current;
    if (!element) return;
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
      setOverflows(element.scrollHeight > lineHeight * 4 + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [description]);

  return (
    <div className="teacher-bio">
      <p
        ref={paragraph}
        id={id}
        className={'catalog-bio' + (expanded ? '' : ' teacher-bio-collapsed')}
        dir="auto"
      >
        {description}
      </p>
      {overflows && (
        <button
          type="button"
          className="text-button teacher-bio-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : 'Read more'}
        </button>
      )}
    </div>
  );
}
