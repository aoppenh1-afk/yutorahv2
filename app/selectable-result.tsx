'use client';
import type { Shiur } from '@/lib/yutorah';
export function SelectableResult({
  enabled,
  selected,
  shiur,
  onSelect,
  children,
}: {
  enabled: boolean;
  selected: boolean;
  shiur: Shiur;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  if (!enabled) return <>{children}</>;
  return (
    <div className={'selectable-result' + (selected ? ' is-selected' : '')}>
      <label className="result-check">
        <input
          type="checkbox"
          checked={selected}
          onChange={onSelect}
          aria-label={'Select ' + shiur.title}
        />
      </label>
      {children}
    </div>
  );
}
