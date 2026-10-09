/* oxlint-disable next/no-img-element -- CDN-hosted YUTorah portraits are rendered at reserved dimensions. */
/* oxlint-disable jsx-a11y/media-has-caption -- No caption tracks are supplied by the upstream audio library. */
'use client';
import { useEffect, useRef, useState } from 'react';
import {
  Bookmark,
  ExternalLink,
  FileText,
  Headphones,
  ListPlus,
  Pause,
  Play,
  SkipForward,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  ListMusic,
  Loader2,
  ChevronUp,
  NotebookPen,
  Video,
  MoreHorizontal,
  ChevronDown,
  Check,
  Plus,
  BookOpen,
  X,
} from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { ShiurViews } from './shiur-views';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import type { Shiur } from '@/lib/yutorah';
import { mediaKind } from '@/lib/yutorah';
import { matchExcerpt } from '@/lib/search-discovery';
import { timeLabel, useAudio, LibraryState } from '@/lib/library';
export function Avatar({
  src,
  name,
  className = '',
}: {
  src: string;
  name: string;
  className?: string;
}) {
  return <Portrait key={src} src={src} name={name} className={className} />;
}
const cdnPortrait =
  /^(https:\/\/cdnyutorah\.cachefly\.net\/_images\/roshei_yeshiva\/[^?#]+?)(?:_o|_lp)?(\.(?:jpe?g|png))$/i;
function Portrait({
  src,
  name,
  className,
}: {
  src: string;
  name: string;
  className: string;
}) {
  const [failures, setFailures] = useState(0);
  const image = useRef<HTMLImageElement>(null);
  // YUTorah publishes the original 240×280 portraits with its `_lp` suffix.
  // API responses often point at the 50px plain or 90px `_o` thumbnails instead.
  // Fall back to the given image if the original is absent.
  const match = /_default\.|missingpicture/i.test(src)
    ? null
    : cdnPortrait.exec(src);
  const original = match ? `${match[1]}_lp${match[2]}` : src;
  const attempts = original === src ? [src] : [original, src];
  const imageSource = attempts[failures] ?? src;
  const available = failures < attempts.length;
  useEffect(() => {
    // A server-rendered image can fail before React attaches its error handler.
    if (image.current?.complete) {
      if (image.current.naturalWidth === 0) setFailures(failures + 1);
    }
  }, [imageSource, failures]);
  return src && available && !/_default\.|missingpicture/i.test(src) ? (
    <img
      ref={image}
      className={'avatar ' + className}
      src={imageSource}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailures(failures + 1)}
    />
  ) : (
    <span className={'avatar initials ' + className} aria-hidden="true">
      {name
        .replace(/^Rabbi\s+/, '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((s) => s[0])
        .join('')}
    </span>
  );
}
export function StatePanel({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <Empty className="state-panel">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children}
    </Empty>
  );
}
export function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v || 'all')}>
      <SelectTrigger className="filter-select" aria-label={label}>
        <SelectValue>
          {options.find((o) => o.value === value)?.label || label}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export const tone = (id: number) => 'tone-' + (Math.abs(id || 0) % 6);
export function Artwork({
  src,
  name,
  id,
  className = '',
  children,
}: {
  src: string;
  name: string;
  id: number;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <span className={`artwork ${tone(id)} ${className}`}>
      <Avatar src={src} name={name} className="artwork-portrait" />
      {children}
    </span>
  );
}
// Some series art exists only as a 58×65 thumbnail, which blurs when stretched to a cover.
const minCoverWidth = 200;
// Series without artwork share this 50px RIETS placeholder GIF.
const seriesPlaceholder =
  'https://cdnyutorah.cachefly.net/_images/series/riets.gif';
const mayHaveCoverArt = (image?: string) => !!image && !/\.gif$/i.test(image);
const coverArtChecks = new Map<string, Promise<boolean>>();
function hasCoverArt(image: string) {
  let check = coverArtChecks.get(image);
  if (!check) {
    check = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth >= minCoverWidth);
      img.onerror = () => resolve(false);
      img.src = image;
    });
    coverArtChecks.set(image, check);
  }
  return check;
}
/** The first `count` series whose artwork is large enough for a cover, or null while checking. */
export function useSeriesWithArt<T extends { id: number; image?: string }>(
  candidates: T[],
  count: number,
) {
  const [result, setResult] = useState<{ key: string; series: T[] } | null>(
    null,
  );
  const unique = [...new Map(candidates.map((s) => [s.id, s])).values()].filter(
    (s) => mayHaveCoverArt(s.image),
  );
  const key = unique.map((s) => s.id + (s.image || '')).join('|');
  const latest = useRef(unique);
  latest.current = unique;
  useEffect(() => {
    let live = true;
    const series = latest.current;
    void Promise.all(series.map((s) => hasCoverArt(s.image!))).then((ok) => {
      if (live)
        setResult({
          key,
          series: series.filter((_, i) => ok[i]).slice(0, count),
        });
    });
    return () => {
      live = false;
    };
  }, [key, count]);
  return result?.key === key ? result.series : null;
}
export function SeriesCover({
  name,
  id,
  image = '',
}: {
  name: string;
  id: number;
  image?: string;
}) {
  const [failures, setFailures] = useState(0);
  const sources = [image, seriesPlaceholder].filter(Boolean);
  const source = sources[failures];
  return (
    <span
      className={`series-cover ${tone(id)} ${source ? 'has-image' : ''}`}
      aria-hidden="true"
    >
      {source ? (
        <img
          key={source}
          src={source}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailures(failures + 1)}
        />
      ) : (
        <>
          <BookOpen className="cover-symbol" size={20} />
          <span className="cover-title" dir="auto">
            {name}
          </span>
          <span className="cover-caption">YUTorah series</span>
        </>
      )}
    </span>
  );
}
export function MobileRecordingCard({
  shiur: s,
  onPlay,
  onDetails,
  onSave,
  saved,
  active = false,
}: {
  shiur: Shiur;
  onPlay: (s: Shiur) => void;
  onDetails: (s: Shiur) => void;
  onSave: (s: Shiur) => void;
  saved: boolean;
  active?: boolean;
}) {
  const kind = mediaKind(s);
  return (
    <article
      className={'mobile-recording-card' + (active ? ' is-playing' : '')}
    >
      <button
        className={'recording-portrait ' + tone(s.teacherId)}
        onClick={() => (kind === 'audio' ? onPlay(s) : onDetails(s))}
        aria-label={
          (kind === 'audio' ? (active ? 'Pause ' : 'Play ') : 'Open ') + s.title
        }
      >
        <Avatar src={s.image} name={s.teacher} />
        <span>
          {active ? (
            <Pause size={12} fill="currentColor" />
          ) : kind === 'text' ? (
            <FileText size={12} />
          ) : kind === 'video' ? (
            <Video size={12} />
          ) : (
            <Play size={12} fill="currentColor" />
          )}
        </span>
      </button>
      <div className="recording-copy">
        <h3>
          <button onClick={() => onDetails(s)}>
            <span dir="auto">{s.title}</span>
            <span className="recording-teacher">{s.teacher}</span>
          </button>
        </h3>
        <div className="recording-meta">
          <span>
            {s.duration
              ? Math.round(s.duration / 60) + ' min'
              : kind === 'text'
                ? 'Article'
                : 'Recording'}
          </span>
          {(s.category || s.topics[0]) && (
            <span dir="auto">{s.category || s.topics[0]}</span>
          )}
          <ShiurViews shiur={s} />
        </div>
      </div>
      <button
        className="recording-save"
        aria-label={(saved ? 'Unsave ' : 'Save ') + s.title}
        aria-pressed={saved}
        onClick={() => onSave(s)}
      >
        <Bookmark size={18} fill={saved ? 'currentColor' : 'none'} />
      </button>
    </article>
  );
}

export function ShiurCard({
  shiur: s,
  onPlay,
  onDetails,
  onSave,
  saved,
  active = false,
}: {
  shiur: Shiur;
  index?: number;
  onPlay: (s: Shiur) => void;
  onDetails: (s: Shiur) => void;
  onSave: (s: Shiur) => void;
  saved: boolean;
  active?: boolean;
  query?: string;
}) {
  const kind = mediaKind(s);
  const isMobile = useIsMobile();
  if (isMobile)
    return (
      <MobileRecordingCard
        shiur={s}
        onPlay={onPlay}
        onDetails={onDetails}
        onSave={onSave}
        saved={saved}
        active={active}
      />
    );
  const open = () => (kind === 'audio' ? onPlay(s) : onDetails(s));
  const subject = s.category || s.topics[0];
  return (
    <article className={'shiur-card' + (active ? ' is-playing' : '')}>
      <div className="card-media">
        <Artwork src={s.image} name={s.teacher} id={s.teacherId} />
        <button
          className="card-play"
          aria-label={
            (kind === 'audio' ? (active ? 'Pause ' : 'Play ') : 'Open ') +
            s.title
          }
          onClick={open}
        >
          {kind === 'text' ? (
            <FileText size={18} />
          ) : active ? (
            <Pause size={18} fill="currentColor" />
          ) : (
            <Play size={18} fill="currentColor" />
          )}
        </button>
        <button
          className="card-save"
          aria-label={(saved ? 'Unsave ' : 'Save ') + s.title}
          aria-pressed={saved}
          onClick={() => onSave(s)}
        >
          <Bookmark size={16} fill={saved ? 'currentColor' : 'none'} />
        </button>
      </div>
      <div className="card-copy">
        <h3 dir="auto">
          <button onClick={() => onDetails(s)}>{s.title}</button>
        </h3>
        <p>{s.teacher}</p>
        <p className="card-meta">
          {active ? (
            <span className="eq" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          ) : kind === 'text' ? (
            <FileText size={13} />
          ) : kind === 'video' ? (
            <Video size={13} />
          ) : (
            <Headphones size={13} />
          )}
          <span>
            {s.duration
              ? Math.round(s.duration / 60) + ' min'
              : kind === 'text'
                ? 'Article'
                : 'Recording'}
          </span>
          <ShiurViews shiur={s} />
          {subject && <span dir="auto">{subject}</span>}
        </p>
      </div>
    </article>
  );
}

export function ShiurRow({
  shiur: s,
  onPlay,
  onDetails,
  onSave,
  onQueue,
  saved,
  progress,
  learned = false,
  extra,
  query = '',
  onPlaylist,
  onLearned,
  active = false,
}: {
  shiur: Shiur;
  onPlay: (s: Shiur) => void;
  onDetails: (s: Shiur) => void;
  onSave: (s: Shiur) => void;
  onQueue: (s: Shiur) => void;
  saved: boolean;
  progress?: { seconds: number; duration: number };
  learned?: boolean;
  extra?: React.ReactNode;
  query?: string;
  onPlaylist?: () => void;
  onLearned?: () => void;
  active?: boolean;
}) {
  const isMobile = useIsMobile();
  const kind = mediaKind(s);
  if (isMobile)
    return (
      <MobileShiurRow
        shiur={s}
        onPlay={onPlay}
        onDetails={onDetails}
        onSave={onSave}
        onQueue={onQueue}
        saved={saved}
        progress={progress}
        learned={learned}
        query={query}
        onPlaylist={onPlaylist}
        onLearned={onLearned}
        active={active}
      />
    );
  return (
    <article className={'shiur-row' + (active ? ' is-playing' : '')}>
      <button
        className={'row-cover ' + tone(s.teacherId)}
        onClick={() => (kind === 'audio' ? onPlay(s) : onDetails(s))}
        aria-label={(kind === 'audio' ? 'Play ' : 'Open ') + s.title}
      >
        <Avatar src={s.image} name={s.teacher} />
        <span>
          {active ? (
            <span className="eq" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          ) : kind === 'text' ? (
            <FileText size={18} />
          ) : (
            <Play size={18} fill="currentColor" />
          )}
        </span>
      </button>
      <div className="row-content">
        <div className="row-meta">
          {learned && <span className="learned-label">Learned</span>}
          <span dir="auto">
            {s.topics.slice(0, 2).join(' · ') || s.category}
          </span>
          {s.series && <span dir="auto">{s.series}</span>}
        </div>
        <h3 dir="auto">
          <button onClick={() => onDetails(s)}>{s.title}</button>
        </h3>
        <p className="row-byline">
          <strong>{s.teacher}</strong>
          <span> · </span>
          {s.duration ? `${Math.round(s.duration / 60)} min` : kind}
          <span> · </span>
          {s.date
            ? new Date(s.date).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                timeZone: 'UTC',
              })
            : ''}
          <ShiurViews shiur={s} />
        </p>
        {progress && (
          <div className="row-progress">
            <div>
              <span
                style={{
                  width:
                    Math.min(
                      100,
                      (100 * progress.seconds) / (progress.duration || 1),
                    ) + '%',
                }}
              />
            </div>
            <small>
              {learned ||
              (progress.duration > 0 &&
                progress.duration - progress.seconds < 15)
                ? 'Completed'
                : `${timeLabel(progress.seconds)} listened`}
            </small>
          </div>
        )}
        {s.description && (
          <p className="row-description">
            {query ? matchExcerpt(s.description, query) : s.description}
          </p>
        )}
      </div>
      <div className="row-actions">
        {extra}
        <button
          className="icon-button"
          onClick={() => onSave(s)}
          aria-label={(saved ? 'Unsave ' : 'Save ') + s.title}
          aria-pressed={saved}
        >
          <Bookmark size={18} fill={saved ? 'currentColor' : 'none'} />
        </button>
        {kind === 'audio' && (
          <button
            className="icon-button"
            onClick={() => onQueue(s)}
            aria-label={'Add to queue: ' + s.title}
          >
            <ListPlus size={19} />
          </button>
        )}
        <button
          className="row-play"
          onClick={() => (kind === 'audio' ? onPlay(s) : onDetails(s))}
          aria-label={
            (kind === 'audio' ? (active ? 'Pause ' : 'Play ') : 'Read ') +
            s.title
          }
        >
          {kind === 'text' ? (
            <FileText size={17} />
          ) : active ? (
            <Pause size={16} fill="currentColor" />
          ) : (
            <Play size={16} fill="currentColor" />
          )}
        </button>
      </div>
    </article>
  );
}
export function Player({
  player: p,
  library,
  update,
  onDetails,
  onQueue,
  onSave,
}: {
  player: ReturnType<typeof useAudio>;
  library: LibraryState;
  update: (fn: (old: LibraryState) => LibraryState) => void;
  onDetails: (s: Shiur) => void;
  onQueue: () => void;
  onSave: (s: Shiur) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isMobile = useIsMobile();
  return (
    <>
      <audio
        ref={p.audio}
        src={p.active?.audio || undefined}
        preload="metadata"
        {...p.handlers}
      />
      {isMobile ? (
        <MobileAudioPlayer
          player={p}
          library={library}
          update={update}
          onDetails={onDetails}
          onQueue={onQueue}
          onSave={onSave}
        />
      ) : (
        p.active && (
          <section
            className={
              'player ' +
              (expanded ? 'player-expanded ' : '') +
              (p.playing ? 'is-playing' : '')
            }
            aria-label="Audio player"
          >
            <button
              className="player-expand icon-button"
              aria-label={
                expanded ? 'Collapse player controls' : 'Expand player controls'
              }
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              <ChevronUp size={18} />
            </button>
            <div className="player-track">
              <button
                className={'player-art ' + tone(p.active.teacherId)}
                onClick={() => onDetails(p.active!)}
                aria-label="Open playing shiur"
              >
                <Avatar src={p.active.image} name={p.active.teacher} />
              </button>
              <div>
                <button
                  className="player-title"
                  onClick={() => onDetails(p.active!)}
                  dir="auto"
                >
                  {p.active.title}
                </button>
                <p>{p.active.teacher}</p>
              </div>
              <button
                className="icon-button player-save"
                aria-label="Save playing shiur"
                aria-pressed={library.saved.some((s) => s.id === p.active?.id)}
                onClick={() => onSave(p.active!)}
              >
                <Bookmark
                  size={17}
                  fill={
                    library.saved.some((s) => s.id === p.active?.id)
                      ? 'currentColor'
                      : 'none'
                  }
                />
              </button>
            </div>
            <div className="player-main">
              <div className="player-controls">
                <button
                  className="seek-button"
                  onClick={() => p.seek(p.time - 15)}
                  aria-label="Rewind 15 seconds"
                >
                  <RotateCcw size={20} />
                  <span>15</span>
                </button>
                <button
                  className="main-play"
                  onClick={p.play}
                  aria-label={p.playing ? 'Pause' : 'Play'}
                >
                  {p.loading ? (
                    <Loader2 size={21} className="spin" />
                  ) : p.playing ? (
                    <Pause size={19} fill="currentColor" />
                  ) : (
                    <Play size={19} fill="currentColor" />
                  )}
                </button>
                <button
                  className="seek-button"
                  onClick={() => p.seek(p.time + 15)}
                  aria-label="Forward 15 seconds"
                >
                  <RotateCw size={20} />
                  <span>15</span>
                </button>
                <button
                  className="icon-button next-button"
                  disabled={!library.queue.length}
                  onClick={p.next}
                  aria-label="Play next in queue"
                >
                  <SkipForward size={18} />
                </button>
              </div>
              <div className="player-progress">
                <time>{timeLabel(p.time)}</time>
                <Slider
                  aria-label="Playback position"
                  min={0}
                  max={p.duration || 1}
                  step={1}
                  value={[p.time]}
                  onValueChange={(v) => p.seek(Array.isArray(v) ? v[0] : v)}
                />
                <time>{timeLabel(p.duration)}</time>
              </div>
            </div>
            <div className="player-options">
              <button
                className="icon-button player-notes"
                onClick={() => onDetails(p.active!)}
                aria-label="Open shiur details and notes"
              >
                <NotebookPen size={18} />
              </button>
              <FilterSelect
                label="Playback speed"
                value={String(library.speed)}
                onChange={(v) =>
                  update((old) => ({ ...old, speed: Number(v) }))
                }
                options={[0.75, 1, 1.25, 1.5, 1.75, 2].map((v) => ({
                  value: String(v),
                  label: `${v}×`,
                }))}
              />
              <div className="volume-control">
                <button
                  className="icon-button"
                  onClick={() =>
                    update((old) => ({ ...old, volume: old.volume ? 0 : 1 }))
                  }
                  aria-label={library.volume ? 'Mute' : 'Unmute'}
                >
                  {library.volume ? (
                    <Volume2 size={18} />
                  ) : (
                    <VolumeX size={18} />
                  )}
                </button>
                <Slider
                  key={expanded ? 'expanded-volume' : 'compact-volume'}
                  aria-label="Volume"
                  min={0}
                  max={1}
                  step={0.05}
                  value={[library.volume]}
                  onValueChange={(v) =>
                    update((old) => ({
                      ...old,
                      volume: Array.isArray(v) ? v[0] : v,
                    }))
                  }
                />
              </div>
              <button
                className="icon-button queue-button"
                onClick={onQueue}
                aria-label={`Open queue, ${library.queue.length} shiurim`}
              >
                <ListMusic size={20} />
                {library.queue.length > 0 && (
                  <span>{library.queue.length}</span>
                )}
              </button>
              <button
                className="icon-button player-close"
                aria-label="Close player"
                title="Close player and stop playback"
                onClick={() => {
                  setExpanded(false);
                  p.stop();
                }}
              >
                <X size={19} />
              </button>
            </div>
            {p.error && (
              <div className="player-error" role="alert">
                {p.error}
                <a href={p.active.url} target="_blank" rel="noreferrer">
                  Open on YUTorah <ExternalLink size={13} />
                </a>
                <button
                  onClick={() => {
                    p.audio.current?.load();
                    p.audio.current?.play().catch(() => {});
                  }}
                >
                  Retry
                </button>
              </div>
            )}
          </section>
        )
      )}
    </>
  );
}

function MobileShiurRow({
  shiur: s,
  onPlay,
  onDetails,
  onSave,
  onQueue,
  onPlaylist,
  onLearned,
  saved,
  progress,
  learned,
  query = '',
  active,
}: {
  shiur: Shiur;
  onPlay: (s: Shiur) => void;
  onDetails: (s: Shiur) => void;
  onSave: (s: Shiur) => void;
  onQueue: (s: Shiur) => void;
  onPlaylist?: () => void;
  onLearned?: () => void;
  saved: boolean;
  progress?: { seconds: number; duration: number };
  learned?: boolean;
  query?: string;
  active?: boolean;
}) {
  const [actions, setActions] = useState(false);
  const kind = mediaKind(s);
  const doAction = (action: () => void) => {
    setActions(false);
    action();
  };
  return (
    <>
      <article
        className={'mobile-shiur-row shiur-row ' + (active ? 'is-playing' : '')}
      >
        <button
          className={'mobile-row-art listening-tone-' + (s.teacherId % 4)}
          onClick={() => onDetails(s)}
          aria-label={'Open ' + s.title}
        >
          <Avatar src={s.image} name={s.teacher} />
          {active && <span className="mobile-playing-dot" />}
        </button>
        <div className="mobile-row-copy">
          <h3>
            <button dir="auto" onClick={() => onDetails(s)}>
              {s.title}
            </button>
          </h3>
          <p>{s.teacher}</p>
          <div>
            <span>
              {s.duration
                ? `${Math.round(s.duration / 60)} min`
                : kind === 'text'
                  ? 'Article'
                  : 'Recording'}
            </span>
            {saved && (
              <Bookmark size={12} fill="currentColor" aria-label="Saved" />
            )}
            <ShiurViews shiur={s} />
            {learned && <Check size={13} aria-label="Learned" />}
          </div>
          {progress && (
            <progress
              value={progress.seconds}
              max={progress.duration || 1}
              aria-label={'Listening progress for ' + s.title}
            />
          )}{' '}
          {query && s.description && (
            <p className="mobile-row-excerpt">
              {matchExcerpt(s.description, query)}
            </p>
          )}
        </div>
        <div className="mobile-row-controls">
          <button
            className="mobile-row-play"
            onClick={() => (kind === 'audio' ? onPlay(s) : onDetails(s))}
            aria-label={
              (kind === 'audio' ? (active ? 'Pause ' : 'Play ') : 'Open ') +
              s.title
            }
          >
            {kind === 'text' ? (
              <FileText size={18} />
            ) : active ? (
              <Pause size={17} fill="currentColor" />
            ) : (
              <Play size={17} fill="currentColor" />
            )}
          </button>
          <button
            className="mobile-row-more"
            aria-label={'More options: ' + s.title}
            onClick={() => setActions(true)}
          >
            <MoreHorizontal size={21} />
          </button>
        </div>
      </article>
      <Sheet open={actions} onOpenChange={setActions}>
        <SheetContent side="bottom" className="mobile-actions-sheet">
          <SheetHeader>
            <SheetTitle dir="auto">{s.title}</SheetTitle>
            <SheetDescription>{s.teacher}</SheetDescription>
          </SheetHeader>
          <div className="mobile-actions-list">
            <button onClick={() => doAction(() => onDetails(s))}>
              <BookOpen size={20} />
              Shiur details & notes
            </button>
            <button onClick={() => doAction(() => onSave(s))}>
              <Bookmark size={20} fill={saved ? 'currentColor' : 'none'} />
              {saved ? 'Remove from saved' : 'Save for later'}
            </button>
            {kind === 'audio' && (
              <button onClick={() => doAction(() => onQueue(s))}>
                <ListPlus size={20} />
                Add to listening queue
              </button>
            )}
            {onPlaylist && (
              <button onClick={() => doAction(onPlaylist)}>
                <Plus size={20} />
                Add to a playlist
              </button>
            )}
            {onLearned && (
              <button onClick={() => doAction(onLearned)}>
                <Check size={20} />
                {learned ? 'Mark as not learned' : 'Mark as learned'}
              </button>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function MobileAudioPlayer({
  player: p,
  library,
  update,
  onDetails,
  onQueue,
  onSave,
}: {
  player: ReturnType<typeof useAudio>;
  library: LibraryState;
  update: (fn: (old: LibraryState) => LibraryState) => void;
  onDetails: (s: Shiur) => void;
  onQueue: () => void;
  onSave: (s: Shiur) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!p.active) return null;
  const s = p.active;
  const saved = library.saved.some((v) => v.id === s.id);
  const close = () => {
    setExpanded(false);
    p.stop();
  };
  return (
    <>
      <section
        className={'mobile-miniplayer player' + (p.playing ? ' is-playing' : '')}
        aria-label="Audio player"
      >
        <button
          className="mobile-miniplayer-open"
          onClick={() => setExpanded(true)}
          aria-label="Expand player controls"
        >
          <Avatar src={s.image} name={s.teacher} />
          <span>
            <strong dir="auto">{s.title}</strong>
            <small>{s.teacher}</small>
          </span>
          <ChevronUp size={16} />
        </button>
        <button
          className="mobile-miniplayer-play"
          aria-label={p.playing ? 'Pause' : 'Play'}
          onClick={p.play}
        >
          {p.loading ? (
            <Loader2 size={22} className="spin" />
          ) : p.playing ? (
            <Pause size={21} fill="currentColor" />
          ) : (
            <Play size={21} fill="currentColor" />
          )}
        </button>
        <button
          className="mobile-miniplayer-close"
          aria-label="Close player"
          title="Close player and stop playback"
          onClick={close}
        >
          <X size={21} />
        </button>
        <progress
          value={p.time}
          max={p.duration || 1}
          aria-label="Listening progress"
        />
      </section>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          className="mobile-now-playing top-0 left-0 translate-x-0 translate-y-0"
          showCloseButton={false}
        >
          <div className="now-playing-top">
            <button
              aria-label="Collapse player controls"
              onClick={() => setExpanded(false)}
            >
              <ChevronDown size={25} />
            </button>
            <div>
              <span>NOW PLAYING</span>
              <p>{s.series || 'The YUTorah library'}</p>
            </div>
            <button
              aria-label={`Open queue, ${library.queue.length} shiurim`}
              onClick={() => {
                setExpanded(false);
                onQueue();
              }}
            >
              <ListMusic size={24} />
            </button>
            <button
              aria-label="Close player"
              title="Close player and stop playback"
              onClick={close}
            >
              <X size={24} />
            </button>
          </div>
          <div className="now-playing-portrait">
            <Avatar key={s.image} src={s.image} name={s.teacher} />
          </div>
          <div className="now-playing-title">
            <div>
              <DialogTitle dir="auto">{s.title}</DialogTitle>
              <DialogDescription>{s.teacher}</DialogDescription>
            </div>
            <button
              aria-label={saved ? 'Unsave playing shiur' : 'Save playing shiur'}
              aria-pressed={saved}
              onClick={() => onSave(s)}
            >
              <Bookmark size={24} fill={saved ? 'currentColor' : 'none'} />
            </button>
          </div>
          <div className="now-playing-seek">
            <Slider
              aria-label="Playback position"
              min={0}
              max={p.duration || 1}
              step={1}
              value={[p.time]}
              onValueChange={(v) => p.seek(Array.isArray(v) ? v[0] : v)}
            />
            <div>
              <time>{timeLabel(p.time)}</time>
              <time>{timeLabel(p.duration)}</time>
            </div>
          </div>
          <div className="now-playing-transport">
            <button
              className="now-playing-skip"
              aria-label="Rewind 15 seconds"
              onClick={() => p.seek(p.time - 15)}
            >
              <RotateCcw size={29} />
              <span>15</span>
            </button>
            <button
              className="now-playing-main"
              aria-label={p.playing ? 'Pause' : 'Play'}
              onClick={p.play}
            >
              {p.loading ? (
                <Loader2 size={31} className="spin" />
              ) : p.playing ? (
                <Pause size={30} fill="currentColor" />
              ) : (
                <Play size={30} fill="currentColor" />
              )}
            </button>
            <button
              className="now-playing-skip"
              aria-label="Forward 15 seconds"
              onClick={() => p.seek(p.time + 15)}
            >
              <RotateCw size={29} />
              <span>15</span>
            </button>
          </div>
          <div className="now-playing-actions">
            <FilterSelect
              label="Playback speed"
              value={String(library.speed)}
              onChange={(v) => update((old) => ({ ...old, speed: Number(v) }))}
              options={[0.75, 1, 1.25, 1.5, 1.75, 2].map((v) => ({
                value: String(v),
                label: `${v}× speed`,
              }))}
            />
            <button
              onClick={() => {
                setExpanded(false);
                onDetails(s);
              }}
              aria-label="Open shiur details and notes"
            >
              <NotebookPen size={19} />
              Study notes
            </button>
            <button
              aria-label="Play next in queue"
              disabled={!library.queue.length}
              onClick={p.next}
            >
              <SkipForward size={21} />
            </button>
          </div>
          <div className="now-playing-volume">
            <button
              aria-label={library.volume ? 'Mute' : 'Unmute'}
              onClick={() =>
                update((old) => ({ ...old, volume: old.volume ? 0 : 1 }))
              }
            >
              {library.volume ? <Volume2 size={20} /> : <VolumeX size={20} />}
            </button>
            <Slider
              aria-label="Volume"
              min={0}
              max={1}
              step={0.05}
              value={[library.volume]}
              onValueChange={(v) =>
                update((old) => ({
                  ...old,
                  volume: Array.isArray(v) ? v[0] : v,
                }))
              }
            />
          </div>
          {p.error && (
            <div className="now-playing-error" role="alert">
              <p>{p.error}</p>
              <button
                onClick={() => {
                  p.audio.current?.load();
                  p.audio.current?.play().catch(() => {});
                }}
              >
                Retry playback
              </button>
              <a href={s.url} target="_blank" rel="noreferrer">
                Open on YUTorah <ExternalLink size={14} />
              </a>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
