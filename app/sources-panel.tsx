'use client';
import { useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Download,
  Ellipsis,
  Loader2,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import type { useSourceCreator } from '@/hooks/use-source-creator';
import { useSourceSheet, type SheetFormat } from '@/hooks/use-source-sheet';
import type { TranscriptSource } from '@/lib/sources';
import { orderedSheetSources } from '@/lib/source-draft';
import { sourceEditions, sourceTextRows } from '@/lib/source-sheet';
import { timeLabel } from '@/lib/library';

const noSources: TranscriptSource[] = [];
type Creator = ReturnType<typeof useSourceCreator>;
const reasons: Record<string, string> = {
  unresolved: 'Could not identify the source',
  ambiguous: 'More than one possible source',
  missing_section: 'The section was not specified',
  inferred: 'The location would have to be assumed',
  missing_location: 'Missing a numbered location',
  missing_amud: 'Missing the page side',
  missing_comment: 'Missing the comment number',
  incomplete_range: 'Incomplete range',
  partial_commentary: 'The commentary was not fully identified',
  invalid_match: 'Could not verify the citation',
  limit: 'Processing limit reached',
  ambiguous_quote: 'The passage appears in multiple locations',
  unmatched_quote: 'No matching passage found',
  unverified_quote: 'Could not verify the passage',
  search_limit: 'Too many matches to identify one source',
};
export function SourcesPanel({
  shiurId,
  title,
  teacher,
  creator,
  onSeek,
}: {
  shiurId: number;
  title: string;
  teacher: string;
  creator: Creator;
  onSeek: (seconds: number) => void;
}) {
  const { result, features, available } = creator;
  const sheet = useSourceSheet({
    shiurId,
    title,
    teacher,
    sources: result?.sources || noSources,
    enabled: features.sheets,
    includeLinks: features.links,
    partial: result?.status !== 'ready',
    limited: result?.limited || false,
  });
  const { draft, setDraft, selected, sources } = sheet;
  const [dialog, setDialog] = useState<
    'download' | 'add' | 'review' | 'settings' | null
  >(null);
  const [editing, setEditing] = useState(false);
  const [format, setFormat] = useState<SheetFormat>('pdf');
  const [allowMissing, setAllowMissing] = useState(false);
  const [reference, setReference] = useState('');
  const patch = (change: Partial<typeof draft>) =>
    setDraft((previous) => ({ ...previous, ...change }));
  const display = editing
    ? orderedSheetSources(sources, { ...draft, excluded: [] })
    : selected;
  const reviews = (result?.reviews || []).filter(
    (r) => !draft.dismissed.includes(r.id),
  );
  const checking = !creator.error && (!result || result.status === 'pending');
  const move = (index: number, direction: number) => {
    const order = display.map((source) => source.ref);
    [order[index], order[index + direction]] = [
      order[index + direction],
      order[index],
    ];
    patch({ order });
  };
  const add = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await sheet.add(reference)) {
      setReference('');
      setDialog(null);
    }
  };
  const startDownload = async () => {
    if (await sheet.download(format, allowMissing)) setDialog(null);
  };
  return (
    <section className="source-sheet" aria-label="Source sheet">
      <div className="source-sheet-toolbar">
        <output className="source-sheet-status">
          {features.sheets && (
            <span>
              {selected.length} {selected.length === 1 ? 'source' : 'sources'}
            </span>
          )}
          {checking && features.sheets && (
            <>
              <Loader2 size={13} className="spin" aria-hidden="true" />
              <span className="sr-only">Checking sources</span>
            </>
          )}
        </output>
        <div className="study-tools">
          {editing ? (
            <button className="study-tool" onClick={() => setEditing(false)}>
              <Check size={14} />
              Done
            </button>
          ) : (
            features.sheets && (
              <label className="source-english-toggle">
                <input
                  type="checkbox"
                  checked={draft.language !== 'he'}
                  onChange={(e) =>
                    patch({ language: e.target.checked ? 'both' : 'he' })
                  }
                />
                English
              </label>
            )
          )}
          <button
            className="study-tool"
            disabled={!features.sheets || !selected.length}
            onClick={() => {
              setAllowMissing(false);
              setDialog('download');
            }}
          >
            <Download size={15} />
            <span>Download</span>
            <ChevronDown size={12} className="study-tool-caret" />
          </button>
          <Menu.Root>
            <Menu.Trigger
              className="study-tool is-icon"
              aria-label="Source sheet options"
            >
              <Ellipsis size={18} />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner
                sideOffset={6}
                align="end"
                className="action-menu-positioner"
              >
                <Menu.Popup
                  className="action-menu source-sheet-menu"
                  aria-label="Source sheet options"
                >
                  <Menu.Item
                    disabled={!features.sheets || !sources.length}
                    onClick={() => setEditing((value) => !value)}
                  >
                    {editing ? 'Finish editing' : 'Edit sources'}
                  </Menu.Item>
                  <Menu.Item
                    disabled={!features.sheets}
                    onClick={() => setDialog('add')}
                  >
                    Add source
                  </Menu.Item>
                  {!!reviews.length && (
                    <Menu.Item onClick={() => setDialog('review')}>
                      Review possible sources ({reviews.length})
                    </Menu.Item>
                  )}
                  <Menu.Item onClick={creator.retry}>Refresh sources</Menu.Item>
                  <Menu.Item onClick={() => setDialog('settings')}>
                    Settings
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </div>
      </div>
      {creator.error && (
        <output className="source-sheet-message">
          {creator.error} <button onClick={creator.retry}>Retry</button>
        </output>
      )}
      {creator.recovering && (
        <output className="source-sheet-message">
          Connection interrupted. Retrying…
        </output>
      )}
      {!features.sheets ? (
        <div className="source-sheet-empty">
          <p>
            {creator.configured
              ? 'Source sheets are turned off.'
              : 'Loading sources…'}
          </p>
          {available.sheets && (
            <button
              className="study-tool"
              onClick={() => creator.setOutput('sheets', true)}
            >
              Show source sheet
            </button>
          )}
        </div>
      ) : (
        <>
          {draft.title !== title && draft.title && (
            <h3 className="source-sheet-title" dir="auto">
              {draft.title}
            </h3>
          )}
          {draft.introduction && (
            <p className="source-sheet-introduction" dir="auto">
              {draft.introduction}
            </p>
          )}
          {!display.length && (
            <div className="source-sheet-empty">
              <p>
                {checking
                  ? 'Finding sources…'
                  : sources.length
                    ? 'All sources are excluded.'
                    : 'No verified sources yet.'}
              </p>
              {!checking && (
                <button
                  className="study-tool"
                  onClick={() =>
                    reviews.length
                      ? setDialog('review')
                      : sources.length
                        ? setEditing(true)
                        : setDialog('add')
                  }
                >
                  {reviews.length
                    ? 'Review possible sources'
                    : sources.length
                      ? 'Choose sources'
                      : 'Add source'}
                </button>
              )}
            </div>
          )}
          <ol className="source-sheet-list">
            {display.map((source, index) => {
              const included = !draft.excluded.includes(source.ref);
              const editions = sourceEditions(
                sheet.texts[source.ref],
                draft.language,
              );
              const label =
                draft.language === 'en'
                  ? source.ref
                  : source.heRef || source.ref;
              const origin = source.occurrences.some(
                (o) => o.origin === 'transcript' || !o.origin,
              )
                ? ''
                : source.occurrences.some((o) => o.origin === 'notes')
                  ? 'From notes'
                  : 'Added by you';
              return (
                <li
                  key={source.ref}
                  className={!included ? 'is-excluded' : undefined}
                >
                  <article>
                    {editing && (
                      <div className="source-edit-row">
                        <label>
                          <input
                            type="checkbox"
                            checked={included}
                            aria-label={`Include ${source.ref}`}
                            onChange={(e) =>
                              patch({
                                excluded: e.target.checked
                                  ? draft.excluded.filter(
                                      (ref) => ref !== source.ref,
                                    )
                                  : [...draft.excluded, source.ref],
                              })
                            }
                          />
                          Include
                        </label>
                        <div>
                          <button
                            aria-label={`Move ${source.ref} up`}
                            disabled={index === 0}
                            onClick={() => move(index, -1)}
                          >
                            <ArrowUp size={15} />
                          </button>
                          <button
                            aria-label={`Move ${source.ref} down`}
                            disabled={index === display.length - 1}
                            onClick={() => move(index, 1)}
                          >
                            <ArrowDown size={15} />
                          </button>
                        </div>
                      </div>
                    )}
                    <div
                      className="source-sheet-heading"
                      dir={draft.language === 'en' ? 'ltr' : 'rtl'}
                    >
                      <h4>
                        {features.links ? (
                          <a
                            href={source.url}
                            target="_blank"
                            rel="noreferrer"
                            title={source.ref}
                          >
                            {label}
                          </a>
                        ) : (
                          label
                        )}
                      </h4>
                      <SourceTime source={source} onSeek={onSeek} />
                    </div>
                    {origin && <p className="source-sheet-origin">{origin}</p>}
                    {included && !!editions.length && (
                      <table
                        className="source-sheet-passages"
                        role="presentation"
                      >
                        <tbody>
                          {sourceTextRows(editions).map((row, j) => (
                            <tr key={j}>
                              {row.map((text, i) => (
                                <td
                                  key={i}
                                  className="source-sheet-text"
                                  dir={editions[i].direction}
                                  lang={editions[i].language}
                                >
                                  {text && <p>{text}</p>}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {included &&
                      editions.some((edition) => edition.truncated) && (
                        <p className="source-sheet-message">
                          Excerpt · Full text on Sefaria
                        </p>
                      )}
                    {included && !editions.length && (
                      <p className="source-sheet-message">
                        {sheet.loading
                          ? 'Loading text…'
                          : draft.language === 'en'
                            ? 'English text is unavailable.'
                            : 'Hebrew text is unavailable.'}
                        {!sheet.loading && (
                          <button onClick={sheet.retryText}>Retry</button>
                        )}
                      </p>
                    )}
                    {editing ? (
                      <label className="source-sheet-note">
                        Note
                        <textarea
                          rows={2}
                          maxLength={4000}
                          aria-label={`Note for ${source.ref}`}
                          value={draft.comments[source.ref] || ''}
                          onChange={(e) =>
                            patch({
                              comments: {
                                ...draft.comments,
                                [source.ref]: e.target.value,
                              },
                            })
                          }
                        />
                      </label>
                    ) : (
                      draft.comments[source.ref] && (
                        <p className="source-sheet-note-text" dir="auto">
                          {draft.comments[source.ref]}
                        </p>
                      )
                    )}
                  </article>
                </li>
              );
            })}
          </ol>
        </>
      )}
      {sheet.storageError && (
        <output className="source-sheet-message">{sheet.storageError}</output>
      )}
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !sheet.busy) setDialog(null);
        }}
      >
        <DialogContent className="source-sheet-dialog">
          <DialogTitle>
            {dialog === 'download'
              ? 'Download source sheet'
              : dialog === 'add'
                ? 'Add source'
                : dialog === 'review'
                  ? 'Possible sources'
                  : 'Source settings'}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {dialog === 'download'
              ? 'Choose the format and language for your sheet.'
              : 'Manage the sources for this shiur.'}
          </DialogDescription>
          {dialog === 'download' && (
            <>
              <label className="source-dialog-field">
                Format
                <select
                  aria-label="Format"
                  value={format}
                  onChange={(e) => setFormat(e.target.value as SheetFormat)}
                >
                  <option value="pdf">PDF</option>
                  <option value="docx">Word</option>
                  <option value="html">HTML</option>
                  <option value="print">Print</option>
                </select>
              </label>
              <label className="source-dialog-field">
                Language
                <select
                  aria-label="Language"
                  value={draft.language}
                  onChange={(e) => {
                    setAllowMissing(false);
                    patch({
                      language: e.target.value as typeof draft.language,
                    });
                  }}
                >
                  <option value="he">Hebrew</option>
                  <option value="both">Hebrew and English</option>
                  <option value="en">English</option>
                </select>
              </label>
              <details className="source-download-options">
                <summary>More options</summary>
                <label className="source-dialog-field">
                  Title
                  <input
                    value={draft.title}
                    maxLength={300}
                    onChange={(e) => patch({ title: e.target.value })}
                  />
                </label>
                <label className="source-dialog-field">
                  Introduction
                  <textarea
                    rows={2}
                    maxLength={4000}
                    value={draft.introduction}
                    onChange={(e) => patch({ introduction: e.target.value })}
                  />
                </label>
                <label className="source-dialog-field">
                  Text length
                  <select
                    aria-label="Text length"
                    value={draft.extent}
                    onChange={(e) =>
                      patch({ extent: e.target.value as typeof draft.extent })
                    }
                  >
                    <option value="excerpt">Excerpts</option>
                    <option value="full">Complete cited text</option>
                  </select>
                </label>
              </details>
              {checking && (
                <p className="source-dialog-hint">
                  Checking continues. This download includes the sources found
                  so far.
                </p>
              )}
              {sheet.loading ? (
                <output className="source-dialog-hint">
                  Loading source text…
                </output>
              ) : (
                sheet.missing > 0 && (
                  <label className="source-dialog-check">
                    <input
                      type="checkbox"
                      checked={allowMissing}
                      onChange={(e) => setAllowMissing(e.target.checked)}
                    />
                    Include {sheet.missing}{' '}
                    {sheet.missing === 1 ? 'source' : 'sources'} with missing
                    text as citations only
                  </label>
                )
              )}
              {sheet.exportError && (
                <p className="source-dialog-error" role="alert">
                  {sheet.exportError}
                </p>
              )}
              <button
                className="source-dialog-submit"
                disabled={
                  !!sheet.busy ||
                  sheet.loading ||
                  !selected.length ||
                  (!!sheet.missing && !allowMissing)
                }
                onClick={() => void startDownload()}
              >
                {sheet.busy && <Loader2 size={15} className="spin" />}
                {sheet.busy
                  ? 'Preparing…'
                  : format === 'print'
                    ? 'Print'
                    : 'Download'}
              </button>
            </>
          )}
          {dialog === 'add' && (
            <form
              className="source-add-form"
              onSubmit={(event) => void add(event)}
            >
              <label className="source-dialog-field">
                Source reference
                <input
                  autoComplete="off"
                  value={reference}
                  maxLength={250}
                  placeholder="e.g. Shulchan Arukh, Orach Chayim 4:4"
                  onChange={(e) => setReference(e.target.value)}
                />
              </label>
              {sheet.addError && (
                <p role="alert" className="source-dialog-error">
                  {sheet.addError}
                </p>
              )}
              <button
                className="source-dialog-submit"
                type="submit"
                disabled={sheet.adding || !reference.trim()}
              >
                {sheet.adding ? 'Checking…' : 'Add source'}
              </button>
            </form>
          )}
          {dialog === 'review' && (
            <>
              <p className="source-dialog-hint">
                These matches need confirmation before they can appear in the
                sheet.
              </p>
              <ol className="source-review-list">
                {reviews.map((review) => (
                  <li key={review.id}>
                    <p>{reasons[review.reason] || 'Needs verification'}</p>
                    <q dir="auto">{review.mention}</q>
                    {review.origin === 'transcript' && (
                      <button
                        className="study-time"
                        onClick={() => onSeek(review.startMs / 1000)}
                      >
                        {timeLabel(review.startMs / 1000)}
                      </button>
                    )}
                    {review.candidates?.map((ref) => (
                      <button
                        key={ref}
                        onClick={() => {
                          setReference(ref);
                          setDialog('add');
                        }}
                      >
                        {ref}
                      </button>
                    ))}
                    <button
                      onClick={() =>
                        patch({
                          dismissed: [...draft.dismissed, review.id].slice(
                            -250,
                          ),
                        })
                      }
                    >
                      Dismiss
                    </button>
                  </li>
                ))}
              </ol>
            </>
          )}
          {dialog === 'settings' && (
            <>
              <label className="source-dialog-check">
                <input
                  type="checkbox"
                  checked={features.links}
                  disabled={!available.links}
                  onChange={(e) => creator.setOutput('links', e.target.checked)}
                />
                Sefaria links
              </label>
              <label className="source-dialog-check">
                <input
                  type="checkbox"
                  checked={features.sheets}
                  disabled={!available.sheets}
                  onChange={(e) =>
                    creator.setOutput('sheets', e.target.checked)
                  }
                />
                Source sheets
              </label>
              <p className="source-dialog-hint">
                Your sheet edits and these settings are saved on this device.
              </p>
              {result?.warnings.map((warning) => (
                <p className="source-dialog-hint" key={warning}>
                  {warning}
                </p>
              ))}
              {result?.limited && (
                <p className="source-dialog-hint">
                  Processing limits were reached. Some sources may be missing.
                </p>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
function SourceTime({
  source,
  onSeek,
}: {
  source: TranscriptSource;
  onSeek: (seconds: number) => void;
}) {
  const first = source.occurrences.find(
    (o) => !o.origin || o.origin === 'transcript',
  );
  return first ? (
    <button
      type="button"
      className="study-time"
      dir="ltr"
      title={`Play ${source.ref}`}
      onClick={() => onSeek(first.startMs / 1000)}
    >
      {timeLabel(first.startMs / 1000)}
    </button>
  ) : null;
}
