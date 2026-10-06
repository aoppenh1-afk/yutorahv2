'use client';
import { useRef, useState } from 'react';
export function PagedItems<T>({
  items,
  children,
  size = 60,
}: {
  items: T[];
  children: (items: T[]) => React.ReactNode;
  size?: number;
}) {
  const [selected, setSelected] = useState(0);
  const anchor = useRef<HTMLDivElement>(null);
  const page = Math.min(
    selected,
    Math.max(0, Math.ceil(items.length / size) - 1),
  );
  const go = (next: number) => {
    setSelected(next);
    anchor.current?.focus({ preventScroll: true });
    anchor.current?.scrollIntoView({ block: 'start' });
  };
  return (
    <>
      <div ref={anchor} tabIndex={-1} />
      {children(items.slice(page * size, (page + 1) * size))}
      {items.length > size && (
        <nav className="list-pagination" aria-label="List pages">
          <button
            type="button"
            className="outline-button"
            disabled={page === 0}
            onClick={() => go(page - 1)}
          >
            Previous
          </button>
          <output>
            {page * size + 1}–{Math.min(items.length, (page + 1) * size)} of{' '}
            {items.length.toLocaleString()}
          </output>
          <button
            type="button"
            className="outline-button"
            disabled={(page + 1) * size >= items.length}
            onClick={() => go(page + 1)}
          >
            Next
          </button>
        </nav>
      )}
    </>
  );
}
