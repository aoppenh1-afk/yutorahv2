'use client';
import { Check, Download, Loader2, X } from 'lucide-react';
import type { Shiur } from '@/lib/yutorah';
import { useDownloads, downloadShiur, cancelDownload } from '@/lib/downloads';
import { useConnectivity } from '@/lib/connectivity';

export function DownloadButton({
  shiur,
  notify,
}: {
  shiur: Shiur;
  notify: (text: string) => void;
}) {
  const downloads = useDownloads();
  const { online } = useConnectivity();
  const saved = downloads.items.some((item) => item.id === shiur.id);
  const job = downloads.jobs.find((value) => value.shiur.id === shiur.id);
  const busy = job && job.status !== 'failed';
  return (
    <div className="download-action">
      <button
        disabled={saved || (!online && !busy)}
        onClick={() => {
          if (busy) cancelDownload(shiur.id);
          else
            void downloadShiur(shiur).catch((error) => notify(error.message));
        }}
      >
        {saved ? (
          <Check size={17} />
        ) : busy ? (
          <X size={17} />
        ) : (
          <Download size={17} />
        )}
        {saved
          ? 'Downloaded'
          : busy
            ? 'Cancel download'
            : job?.status === 'failed'
              ? 'Retry download'
              : 'Download for offline'}
      </button>
      {busy && (
        <output className="download-inline-progress">
          <Loader2 size={13} className="spin" />
          {job.status === 'queued'
            ? 'Waiting to download'
            : job.savingContent
              ? 'Saving image and study content…'
              : job.total
                ? Math.min(99, Math.round((job.bytes / job.total) * 100)) + '%'
                : 'Downloading…'}
        </output>
      )}
      {busy && (
        <p className="download-keep-open">
          Keep the app open until the download finishes.
        </p>
      )}
      {job?.error && (
        <p role="alert" className="download-inline-error">
          {job.error}
        </p>
      )}
    </div>
  );
}
