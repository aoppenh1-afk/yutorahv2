/* oxlint-disable next/no-img-element -- CDN-hosted YUTorah portraits are rendered at reserved dimensions. */
/* oxlint-disable jsx-a11y/media-has-caption -- No caption tracks are supplied by the upstream audio library. */
'use client';
import { useState } from 'react';
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
} from 'lucide-react';
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
import { highlightParts, matchExcerpt } from '@/lib/search-discovery';
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
  const [bad, setBad] = useState(false);
  return src && !bad && !src.includes('_default.') ? (
    <img
      className={'avatar ' + className}
      src={src}
      alt=""
      loading="lazy"
      onError={() => setBad(true)}
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
export function ShiurCard({
  shiur: s,
  index,
  onPlay,
  onDetails,
  onSave,
  saved,
  active = false,
  query = '',
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
  return (
    <article className={'shiur-card ' + (active ? 'is-playing' : '')}>
      <div className="card-top">
        <span className="card-number">
          {index !== undefined ? String(index + 1).padStart(2, '0') : 'YUTORAH'}
        </span>
        <button
          aria-label={(saved ? 'Unsave ' : 'Save ') + s.title}
          aria-pressed={saved}
          onClick={() => onSave(s)}
        >
          {saved ? (
            <Bookmark size={17} fill="currentColor" />
          ) : (
            <Bookmark size={17} />
          )}
        </button>
      </div>
      <button className="category-label" onClick={() => onDetails(s)}>
        {s.topics[0] || s.category || s.format.toUpperCase()}
      </button>
      <h3 dir="auto">
        <button onClick={() => onDetails(s)}>
          {highlightParts(s.title, query).map((part, i) =>
            part.match ? <mark key={i}>{part.text}</mark> : part.text,
          )}
        </button>
      </h3>
      <div className="card-teacher">
        <Avatar src={s.image} name={s.teacher} />
        <span>{s.teacher}</span>
      </div>
      <div className="card-bottom">
        <span>
          {kind === 'text' ? <FileText size={14} /> : <Headphones size={14} />}{' '}
          {s.duration
            ? `${Math.round(s.duration / 60)} min`
            : kind === 'text'
              ? 'Article'
              : 'Recording'}
        </span>
        <button
          className="card-play"
          aria-label={(kind === 'audio' ? 'Play ' : 'Open ') + s.title}
          onClick={() => (kind === 'audio' ? onPlay(s) : onDetails(s))}
        >
          {kind === 'text' ? (
            <FileText size={15} />
          ) : active ? (
            <span className="equalizer">
              <i />
              <i />
              <i />
            </span>
          ) : (
            <Play size={14} fill="currentColor" />
          )}
        </button>
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
  extra,
  query = '',
}: {
  shiur: Shiur;
  onPlay: (s: Shiur) => void;
  onDetails: (s: Shiur) => void;
  onSave: (s: Shiur) => void;
  onQueue: (s: Shiur) => void;
  saved: boolean;
  progress?: { seconds: number; duration: number };
  extra?: React.ReactNode;
  query?: string;
}) {
  const kind = mediaKind(s);
  return (
    <article className="shiur-row">
      <button
        className="row-cover"
        onClick={() => (kind === 'audio' ? onPlay(s) : onDetails(s))}
        aria-label={(kind === 'audio' ? 'Play ' : 'Open ') + s.title}
      >
        <Avatar src={s.image} name={s.teacher} />
        <span>
          <Play size={18} fill="currentColor" />
        </span>
      </button>
      <div className="row-content">
        <div className="row-meta">
          {highlightParts(
            s.topics.slice(0, 2).join(' · ') || s.category,
            query,
          ).map((part, i) =>
            part.match ? <mark key={i}>{part.text}</mark> : part.text,
          )}
          {s.series && (
            <span>
              {' '}
              ·{' '}
              {highlightParts(s.series, query).map((part, i) =>
                part.match ? <mark key={i}>{part.text}</mark> : part.text,
              )}
            </span>
          )}
        </div>
        <h3 dir="auto">
          <button onClick={() => onDetails(s)}>
            {highlightParts(s.title, query).map((part, i) =>
              part.match ? <mark key={i}>{part.text}</mark> : part.text,
            )}
          </button>
        </h3>
        <p>
          {s.teacher}
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
              {progress.duration - progress.seconds < 15
                ? 'Completed'
                : `${timeLabel(progress.seconds)} listened`}
            </small>
          </div>
        )}
        {s.description && (
          <p className="row-description">
            {highlightParts(
              query ? matchExcerpt(s.description, query) : s.description,
              query,
            ).map((part, i) =>
              part.match ? <mark key={i}>{part.text}</mark> : part.text,
            )}
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
          aria-label={(kind === 'audio' ? 'Play ' : 'Read ') + s.title}
        >
          {kind === 'text' ? (
            <FileText size={17} />
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
  return (
    <>
      <audio
        ref={p.audio}
        src={p.active?.audio || undefined}
        preload="metadata"
        {...p.handlers}
      />
      {p.active && (
        <section className="player" aria-label="Audio player">
          <div className="player-track">
            <button
              className="player-art"
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
            <FilterSelect
              label="Playback speed"
              value={String(library.speed)}
              onChange={(v) => update((old) => ({ ...old, speed: Number(v) }))}
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
                {library.volume ? <Volume2 size={18} /> : <VolumeX size={18} />}
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
            <button
              className="icon-button queue-button"
              onClick={onQueue}
              aria-label={`Open queue, ${library.queue.length} shiurim`}
            >
              <ListMusic size={20} />
              {library.queue.length > 0 && <span>{library.queue.length}</span>}
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
      )}
    </>
  );
}
