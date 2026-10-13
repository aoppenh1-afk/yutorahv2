'use client';
import { useMemo, useState } from 'react';
import {
  Download,
  BookOpen,
  Loader2,
  Pause,
  Play,
  RotateCw,
  Search,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import {
  useDownloads,
  downloadShiur,
  cancelDownload,
  removeDownload,
  loadDownloads,
} from '@/lib/downloads';
import { downloadSize } from '@/lib/download-contract';
import { useConnectivity, checkConnection } from '@/lib/connectivity';
import { timeLabel, type LibraryState } from '@/lib/library';
import type { Shiur } from '@/lib/yutorah';
import type { usePlaybackState } from './playback';
import { Avatar } from './ui';

export function DownloadsPage({
  library,
  player,
  onPlay,
  onDetails,
  onBrowse,
  notify,
}: {
  library: LibraryState;
  player: ReturnType<typeof usePlaybackState>;
  onPlay: (shiur: Shiur) => void;
  onDetails: (shiur: Shiur) => void;
  onBrowse: () => void;
  notify: (message: string) => void;
}) {
  const downloads = useDownloads();
  const { online, checking } = useConnectivity();
  const [query, setQuery] = useState('');
  const [removing, setRemoving] = useState<number | null>(null);
  const [confirmation, setConfirmation] = useState<number | null>(null);
  const items = useMemo(
    () =>
      downloads.items.filter((item) =>
        (item.shiur.title + ' ' + item.shiur.teacher)
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase().trim()),
      ),
    [downloads.items, query],
  );
  const bytes = downloads.items.reduce((total, item) => total + item.bytes, 0);
  async function remove(id: number) {
    setRemoving(id);
    try {
      if (player.active?.id === id) player.stop();
      await removeDownload(id);
      setConfirmation(null);
      notify('Download removed from this device.');
    } catch {
      notify('Could not remove this download. Try again.');
    } finally {
      setRemoving(null);
    }
  }
  return (
    <section className="downloads-page" aria-label="Downloaded shiurim">
      {!online && (
        <div className="downloads-offline-notice">
          <WifiOff size={25} aria-hidden="true" />
          <div>
            <h1>No internet connection</h1>
            <p>Listen to your downloaded shiurim.</p>
          </div>
        </div>
      )}
      <div className="downloads-heading">
        <div>
          {online ? <h1>Downloads</h1> : <h2>Downloads</h2>}
          <p>
            {downloads.items.length}{' '}
            {downloads.items.length === 1 ? 'shiur' : 'shiurim'} on this device
            {bytes > 0 && <span>{downloadSize(bytes)}</span>}
          </p>
        </div>
        {!online && (
          <button
            className="downloads-retry"
            disabled={checking}
            onClick={() => void checkConnection()}
          >
            <RotateCw size={16} className={checking ? 'spin' : ''} />
            {checking ? 'Checking…' : 'Try again'}
          </button>
        )}
      </div>
      {downloads.error && (
        <div className="downloads-error" role="alert">
          <p>{downloads.error}</p>
          <button onClick={() => void loadDownloads()}>Try again</button>
        </div>
      )}
      {!downloads.ready && (
        <output className="downloads-loading">
          <Loader2 size={18} className="spin" /> Loading downloads…
        </output>
      )}
      {downloads.jobs.length > 0 && (
        <div className="downloads-jobs" aria-label="Download progress">
          <p className="downloads-keep-open">
            Keep the app open until your downloads finish.
          </p>
          {downloads.jobs.map((job) => (
            <div className="downloads-job" key={job.shiur.id}>
              <div className="downloads-job-heading">
                <h3>{job.shiur.title}</h3>
                <button
                  aria-label={'Cancel download of ' + job.shiur.title}
                  onClick={() => cancelDownload(job.shiur.id)}
                >
                  <X size={17} />
                </button>
              </div>
              {job.status === 'failed' ? (
                <>
                  <p role="alert">{job.error}</p>
                  <button
                    disabled={!online}
                    className="downloads-retry"
                    onClick={() =>
                      void downloadShiur(job.shiur).catch((error) =>
                        notify(error.message),
                      )
                    }
                  >
                    <RotateCw size={15} /> Retry download
                  </button>
                </>
              ) : (
                <>
                  <progress
                    max={job.total || undefined}
                    value={job.total ? job.bytes : undefined}
                    aria-label={'Downloading ' + job.shiur.title}
                  />
                  <output>
                    {job.status === 'queued'
                      ? 'Waiting to download'
                      : job.savingContent
                        ? 'Saving image and study content…'
                        : job.total
                          ? downloadSize(job.bytes) +
                            ' of ' +
                            downloadSize(job.total)
                          : 'Downloading ' + downloadSize(job.bytes)}
                  </output>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {downloads.items.length > 3 && (
        <label className="downloads-search">
          <Search size={18} />
          <input
            type="search"
            aria-label="Search downloads"
            placeholder="Find a downloaded shiur"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}
      <div className="downloads-list">
        {items.map((item) => {
          const shiur = item.shiur;
          const progress = library.history.find(
            (value) => value.shiur.id === item.id,
          );
          const playing = player.active?.id === item.id && player.playing;
          return (
            <article className="downloaded-shiur" key={item.id}>
              <div className="downloaded-shiur-main">
                <Avatar
                  src={shiur.image}
                  name={shiur.teacher}
                  className="downloaded-shiur-avatar"
                />
                <div className="downloaded-shiur-copy">
                  <h3>{shiur.title}</h3>
                  <p>{shiur.teacher}</p>
                  <div className="downloaded-shiur-meta">
                    <span>{timeLabel(shiur.duration)}</span>
                    <span>{downloadSize(item.bytes)}</span>
                  </div>
                </div>
                <button
                  className="downloaded-shiur-play"
                  aria-label={
                    (playing
                      ? 'Pause '
                      : progress?.seconds
                        ? 'Resume '
                        : 'Play ') + shiur.title
                  }
                  onClick={() => (playing ? player.play() : onPlay(shiur))}
                  disabled={removing === item.id}
                >
                  {playing ? (
                    <Pause size={19} fill="currentColor" />
                  ) : (
                    <Play size={19} fill="currentColor" />
                  )}
                </button>
              </div>
              <div className="downloaded-shiur-footer">
                <span>
                  {progress?.seconds &&
                  progress.seconds < progress.duration - 15
                    ? 'Resume at ' + timeLabel(progress.seconds)
                    : 'Available offline'}
                </span>
                <button
                  aria-label={'Remove download of ' + shiur.title}
                  onClick={() =>
                    setConfirmation(confirmation === item.id ? null : item.id)
                  }
                >
                  <Trash2 size={14} /> Remove
                </button>
              </div>
              <div className="downloaded-shiur-study">
                <button onClick={() => onDetails(shiur)}>
                  <BookOpen size={15} /> Read transcript & notes
                </button>
                <span>
                  {[
                    item.content?.transcript && 'Transcript',
                    item.content?.notes && 'Notes',
                    item.content?.summary && 'Summaries',
                  ]
                    .filter(Boolean)
                    .join(', ') || 'No study content saved'}
                  {item.content?.transcript ||
                  item.content?.notes ||
                  item.content?.summary
                    ? ' saved offline'
                    : ''}
                </span>
              </div>
              {confirmation === item.id && (
                <div className="downloaded-shiur-confirm">
                  <p>Remove this download from your device?</p>
                  <div>
                    <button onClick={() => setConfirmation(null)}>
                      Keep download
                    </button>
                    <button
                      className="download-remove-confirm"
                      disabled={removing === item.id}
                      onClick={() => void remove(item.id)}
                    >
                      {removing === item.id ? 'Removing…' : 'Remove download'}
                    </button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {downloads.ready && !downloads.error && !downloads.items.length && (
        <div className="downloads-empty">
          <Download size={31} aria-hidden="true" />
          <h2>No downloaded shiurim yet</h2>
          <p>
            {online
              ? 'Open a shiur and tap Download for offline. It will be here whenever you want to listen.'
              : "When you're back online, open a shiur and tap Download for offline."}
          </p>
          {online && (
            <button className="primary-button" onClick={onBrowse}>
              Find shiurim
            </button>
          )}
        </div>
      )}
      {downloads.items.length > 0 && !items.length && (
        <p className="downloads-no-results">No downloads match your search.</p>
      )}
      {downloads.items.length > 0 && (
        <p className="downloads-device-note">
          Downloads stay on this device. Clearing website data removes them.
        </p>
      )}
    </section>
  );
}
