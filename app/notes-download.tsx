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
  return (
    <Menu.Root>
      <Menu.Trigger className="study-download" disabled={Boolean(busy)}>
        {busy ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
        {busy ? 'Preparing…' : 'Download'} <ChevronDown size={12} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          sideOffset={6}
          align="end"
          className="notes-download-positioner"
        >
          <Menu.Popup
            className="notes-download-menu"
            aria-label="Download notes"
          >
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
