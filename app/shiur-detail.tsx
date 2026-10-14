/* oxlint-disable jsx-a11y/media-has-caption -- YUTorah provides no caption tracks for these recordings; never invent captions. */
'use client';
import { lazy, useLayoutEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import {
  ArrowRight,
  Bookmark,
  Check,
  ChevronRight,
  CircleCheck,
  Download,
  Ellipsis,
  ExternalLink,
  FileText,
  Info,
  Link2,
  ListMusic,
  ListPlus,
  Loader2,
  Pause,
  Play,
  Share2,
} from 'lucide-react';
import type { BrowseKind } from '@/lib/catalog';
import type { Follow, relatedShiurim } from '@/lib/learning';
import { timeLabel, type LibraryState } from '@/lib/library';
import { mediaKind, type Shiur } from '@/lib/yutorah';
import { Avatar } from './ui';
import { DownloadButton } from './download-button';
import { FollowButton } from './follow-button';
import { PlaybackPosition, usePlaybackState } from './playback';
import { ScreenBoundary } from './screen-boundary';
import { ShiurViews } from './shiur-views';

const ArticleReader = lazy(() =>
  import('./article-reader').then((m) => ({ default: m.ArticleReader })),
);
const CollectionContext = lazy(() =>
  import('./collection-context').then((m) => ({
    default: m.CollectionContext,
  })),
);
const TranscriptReader = lazy(() =>
  import('./transcript-reader').then((m) => ({ default: m.TranscriptReader })),
);

export type DetailShiur = Shiur & { text?: string; video?: string };

const dateLabel = (value: string) =>
  new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

export function ShiurDetail({
  shiur,
  library,
  saved,
  learned,
  online,
  loading,
  error,
  related,
  relatedLoading,
  relatedError,
  notify,
  onRetry,
  onRelatedRetry,
  onOpen,
  onDetails,
  onFollow,
  onSave,
  onQueue,
  onPlaylist,
  onShare,
  onToggleLearned,
  onReport,
}: {
  shiur: DetailShiur;
  library: LibraryState;
  saved: boolean;
  learned: boolean;
  online: boolean;
  loading: boolean;
  error: string;
  related: ReturnType<typeof relatedShiurim>;
  relatedLoading: boolean;
  relatedError: boolean;
  notify: (text: string) => void;
  onRetry: () => void;
  onRelatedRetry: () => void;
  onOpen: (kind: BrowseKind, id?: number) => void;
  onDetails: (s: Shiur) => void;
  onFollow: (follow: Follow) => void;
  onSave: (s: Shiur) => void;
  onQueue: (s: Shiur) => void;
  onPlaylist: (s: Shiur) => void;
  onShare: (s: Shiur, seconds?: number) => Promise<void>;
  onToggleLearned: (s: Shiur) => void;
  onReport: (s: Shiur) => void;
}) {
  const player = usePlaybackState();
  const kind = mediaKind(shiur);
  const pdf = kind === 'text' && /pdf/i.test(shiur.format + shiur.audio);
  const active = player.active?.id === shiur.id;
  const progress = library.history.find((h) => h.shiur.id === shiur.id);
  const resumable =
    active ||
    (!!progress &&
      progress.seconds > 5 &&
      !(progress.duration > 0 && progress.duration - progress.seconds < 15));
  const videoSource =
    shiur.video ||
    (['youtube', 'video', 'mp4'].includes(shiur.format) ? shiur.audio : '');
  const youtubeId = videoSource.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([\w-]{11})/,
  )?.[1];
  const speakers = shiur.speakers?.length
    ? shiur.speakers
    : [{ id: shiur.teacherId, name: shiur.teacher, image: shiur.image }];
  const listen = () => {
    if (active && player.playing) return player.play();
    const params = new URLSearchParams(window.location.search);
    const shared =
      params.get('shiur') === String(shiur.id) && params.has('t')
        ? Math.max(0, Number(params.get('t')) || 0)
        : undefined;
    player.start(shiur, shared);
  };
  const facts: {
    label: string;
    links?: { name: string; open: () => void }[];
    text?: string;
  }[] = [];
  if (shiur.series)
    facts.push({
      label: 'Series',
      links: [
        { name: shiur.series, open: () => onOpen('series', shiur.seriesId) },
      ],
    });
  if (shiur.topicPaths?.length)
    facts.push({
      label: shiur.topicPaths.length > 1 ? 'Topics' : 'Topic',
      links: shiur.topicPaths.map((t) => ({
        name: [t.group, t.branch, t.name].filter(Boolean).join(' / '),
        open: () => onOpen('topic', t.id),
      })),
    });
  if (shiur.venueId)
    facts.push({
      label: 'Venue',
      links: [
        {
          name: shiur.venue || 'Venue',
          open: () => onOpen('venue', shiur.venueId),
        },
      ],
    });
  if (shiur.uploadedAt)
    facts.push({ label: 'Uploaded', text: dateLabel(shiur.uploadedAt) });
  return (
    <div className="detail-body">
      <header className="detail-hero">
        <p className="detail-topic">
          {shiur.topics.slice(0, 3).join(' · ') || shiur.category}
        </p>
        <h2 dir="auto">{shiur.title}</h2>
        <div className="detail-credits">
          {speakers.map((speaker, i) => (
            <div className="detail-credit" key={speaker.id + ':' + i}>
              <button
                className="detail-teacher"
                onClick={() => onOpen('teacher', speaker.id)}
              >
                <Avatar src={speaker.image} name={speaker.name} />
                <strong>{speaker.name}</strong>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
              {speaker.id > 0 && (
                <FollowButton
                  follow={{
                    kind: 'teacher',
                    id: speaker.id,
                    name: speaker.name,
                    image: speaker.image,
                  }}
                  library={library}
                  onFollow={onFollow}
                />
              )}
            </div>
          ))}
        </div>
        <div className="detail-meta">
          <span>
            {shiur.duration
              ? `${Math.round(shiur.duration / 60)} min`
              : shiur.format.toUpperCase()}
          </span>
          <span>
            {shiur.language === 'HE'
              ? 'Hebrew'
              : shiur.language === 'EN'
                ? 'English'
                : shiur.language}
          </span>
          <span>{shiur.date ? dateLabel(shiur.date) : ''}</span>
          <ShiurViews shiur={shiur} />
          {learned && (
            <span className="detail-learned">
              <Check size={13} aria-hidden="true" />
              Learned
            </span>
          )}
        </div>
      </header>
      <div className="detail-actions">
        {kind === 'audio' ? (
          <button className="primary-button detail-primary" onClick={listen}>
            {active && player.playing ? (
              <Pause size={17} fill="currentColor" />
            ) : (
              <Play size={17} fill="currentColor" />
            )}
            {active && player.playing
              ? 'Pause'
              : resumable
                ? 'Resume'
                : 'Listen'}
          </button>
        ) : pdf ? (
          <button
            className="primary-button detail-primary"
            onClick={() =>
              document
                .getElementById('detail-article-reader')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          >
            <FileText size={17} /> Read article
          </button>
        ) : (
          <a
            className="primary-button detail-primary"
            href={shiur.audio || shiur.url}
            target="_blank"
            rel="noreferrer"
          >
            {kind === 'text' ? <FileText size={17} /> : <Play size={17} />}
            {kind === 'text' ? 'Read article' : 'Open video'}
            <ExternalLink size={14} />
          </a>
        )}
        <button
          className="detail-icon-action"
          aria-label="Save"
          aria-pressed={saved}
          title={saved ? 'Saved' : 'Save'}
          onClick={() => onSave(shiur)}
        >
          <Bookmark size={19} fill={saved ? 'currentColor' : 'none'} />
        </button>
        {shiur.audio && kind === 'audio' && (
          <DownloadButton shiur={shiur} notify={notify} />
        )}
        <Menu.Root>
          <Menu.Trigger
            className="detail-icon-action"
            aria-label="More actions"
            title="More actions"
          >
            <Ellipsis size={20} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner
              sideOffset={8}
              align="end"
              className="action-menu-positioner"
            >
              <Menu.Popup className="action-menu">
                {kind === 'audio' && (
                  <Menu.Item onClick={() => onQueue(shiur)}>
                    <ListPlus size={16} /> Add to queue
                  </Menu.Item>
                )}
                <Menu.Item onClick={() => onPlaylist(shiur)}>
                  <ListMusic size={16} /> Add to playlist
                </Menu.Item>
                <Menu.Item onClick={() => void onShare(shiur)}>
                  <Share2 size={16} /> Copy link
                </Menu.Item>
                {active && (
                  <PlaybackPosition>
                    {(clock) => (
                      <Menu.Item onClick={() => void onShare(shiur, clock.time)}>
                        <Link2 size={16} /> Copy link at {timeLabel(clock.time)}
                      </Menu.Item>
                    )}
                  </PlaybackPosition>
                )}
                {shiur.audio && (
                  <Menu.LinkItem
                    href={shiur.audio}
                    target="_blank"
                    rel="noreferrer"
                    download
                    closeOnClick
                  >
                    <Download size={16} />
                    {kind === 'audio' ? 'Download audio file' : 'Download file'}
                  </Menu.LinkItem>
                )}
                <Menu.Separator className="action-menu-separator" />
                <Menu.Item onClick={() => onToggleLearned(shiur)}>
                  <CircleCheck size={16} />
                  {learned ? 'Mark as not learned' : 'Mark as learned'}
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
      {loading && (
        <output className="inline-loading">
          <Loader2 size={14} className="spin" />
          Loading details…
        </output>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
          <button onClick={onRetry}>Retry</button>
        </div>
      )}
      {youtubeId && (
        <iframe
          className="video-embed"
          src={'https://www.youtube-nocookie.com/embed/' + youtubeId}
          title="YUTorah shiur video"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      )}
      {videoSource && !youtubeId && /\.mp4(?:\?|$)/i.test(videoSource) && (
        <video
          className="video-embed"
          src={videoSource}
          controls
          playsInline
        />
      )}
      {shiur.description && (
        <DetailDescription key={shiur.id} text={shiur.description} />
      )}
      {online && shiur.collections?.length ? (
        <ScreenBoundary>
          <CollectionContext
            key={shiur.id}
            shiur={shiur}
            onOpen={(id) => onOpen('collection', id)}
            onDetails={onDetails}
          />
        </ScreenBoundary>
      ) : null}
      {pdf && (
        <div id="detail-article-reader">
          <ScreenBoundary>
            <ArticleReader key={shiur.id} shiur={shiur} />
          </ScreenBoundary>
        </div>
      )}
      {kind !== 'text' && (
        <ScreenBoundary>
          <TranscriptReader
            shiurId={shiur.id}
            onSeek={(seconds) => player.start(shiur, seconds)}
          />
        </ScreenBoundary>
      )}
      {shiur.text && (
        <section className="detail-section">
          <h3>Text from YUTorah</h3>
          <p className="source-text" dir="auto">
            {shiur.text}
          </p>
        </section>
      )}
      {shiur.materials.length > 0 && (
        <section className="detail-section">
          <h3>Source sheets</h3>
          {shiur.materials.map((m, i) => (
            <a
              className="source-link"
              key={m.url + i}
              href={m.url}
              target="_blank"
              rel="noreferrer"
            >
              <FileText size={16} />
              {m.name || `Source sheet ${i + 1}`}
              <ExternalLink size={14} />
            </a>
          ))}
        </section>
      )}
      {(related.length > 0 || relatedLoading || relatedError) && (
        <section className="detail-section detail-related">
          <h3>Based on this shiur</h3>
          {relatedLoading && (
            <p className="feed-loading">
              <Loader2 className="spin" size={14} />
              Finding related learning…
            </p>
          )}
          {relatedError && (
            <p className="feed-notice">
              Some recommendations could not load.{' '}
              <button onClick={onRelatedRetry}>Try again</button>
            </p>
          )}
          {related.slice(0, 5).map(({ shiur: s, reason }) => (
            <button key={s.id} onClick={() => onDetails(s)}>
              <span>
                <strong dir="auto">{s.title}</strong>
                <small>
                  {s.teacher} ·{' '}
                  {s.duration
                    ? Math.round(s.duration / 60) + ' min'
                    : s.format}
                </small>
                <small className="related-reason">{reason}</small>
              </span>
              <ArrowRight size={16} />
            </button>
          ))}
        </section>
      )}
      {facts.length > 0 && (
        <section className="detail-section">
          <h3>Details</h3>
          <dl className="detail-facts">
            {facts.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>
                  {fact.links?.map((link) => (
                    <button key={link.name} onClick={link.open}>
                      <span dir="auto">{link.name}</span>
                      <ChevronRight size={15} aria-hidden="true" />
                    </button>
                  ))}
                  {fact.text}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <div className="detail-source-actions">
        <a
          className="original-shiur-link"
          href={shiur.url}
          target="_blank"
          rel="noreferrer"
        >
          View original on YUTorah <ExternalLink size={14} />
        </a>
        <button className="text-button" onClick={() => onReport(shiur)}>
          <Info size={14} /> Report an issue
        </button>
      </div>
    </div>
  );
}

function DetailDescription({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [text, open]);
  return (
    <div className="detail-description">
      <p ref={ref} dir="auto" data-clamped={!open || undefined}>
        {text}
      </p>
      {long && (
        <button
          className="text-button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
