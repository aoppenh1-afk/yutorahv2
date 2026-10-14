'use client';
import { Menu } from '@base-ui/react/menu';
import { ChevronDown, Download, Loader2 } from 'lucide-react';

export type NotesFormat = 'pdf' | 'docx';
export function NotesDownload({
  busy,
  onDownload,
}: {
  busy: NotesFormat | null;
  onDownload: (format: NotesFormat) => void;
}) {
  const label = busy ? 'Preparing…' : 'Download';
  return (
    <Menu.Root>
      <Menu.Trigger
        className="study-tool"
        disabled={Boolean(busy)}
        aria-label={label}
        title="Download notes"
      >
        {busy ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
        <span>{label}</span>
        <ChevronDown size={12} className="study-tool-caret" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="action-menu-positioner">
          <Menu.Popup className="action-menu" aria-label="Download notes">
            <Menu.Item onClick={() => onDownload('pdf')}>PDF (.pdf)</Menu.Item>
            <Menu.Item onClick={() => onDownload('docx')}>
              Word (.docx)
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
