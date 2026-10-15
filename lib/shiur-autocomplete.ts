import type { SearchDatabase } from './search-storage';
import type { ShiurSuggestion } from './search-discovery';
import {
  interpretSpacing,
  searchAliases,
  searchTerms,
  searchText,
  wordMatch,
  prepareMatchText,
  createTextMatcher,
  relatedSearchTerms,
} from './search-matching';
import { createRelevanceScorer } from '../packages/yutorah-core/src/search-ranking.js';
import { titleVocabulary } from './title-index';

type Title = { id: number; title: string };

/** Bound both query expansion and the number of titles read into memory. */
export function titleAutocompleteQuery(query: string, words: string[] = []) {
  const terms = [...new Set(searchTerms(query))];
  if (terms.length > 12)
    throw new RangeError('Please use up to 12 words for suggestions.');
  const groups = terms.map((term) => {
    const completions = words
      .map((word) => ({ word, score: wordMatch(term, word) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .flatMap(({ word }) => searchAliases(word));
    const subjects = relatedSearchTerms(term);
    return [
      ...new Set([
        ...subjects,
        ...subjects.flatMap(searchAliases),
        ...completions,
      ]),
    ]
      .map(searchText)
      .filter((word) => /^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*$/u.test(word))
      .slice(0, 24);
  });
  const sqlite = groups
    .map(
      (group) =>
        `(${group.map((word) => `"${word}"${word.length >= 3 && !/\p{N}/u.test(word) ? '*' : ''}`).join(' OR ')})`,
    )
    .join(' AND ');
  const postgres = groups
    .map(
      (group) =>
        `(${group
          .map((phrase) =>
            phrase
              .split(' ')
              .map(
                (word) =>
                  `'${word}'${word.length >= 3 && !/\p{N}/u.test(word) ? ':*' : ''}`,
              )
              .join(' <-> '),
          )
          .join(' | ')})`,
    )
    .join(' & ');
  return { sqlite, postgres };
}

/** Database relevance selects a small candidate set from the entire title index.
 * The shared matcher then favors complete phrases and nearby title words.
 */
export async function findShiurSuggestions(
  db: SearchDatabase,
  query: string,
): Promise<ShiurSuggestion[]> {
  if (query.length > 300) throw new RangeError('Please use a shorter search.');
  if (searchText(query).length < 3) return [];
  // Validate limits before querying the vocabulary.
  titleAutocompleteQuery(query);
  const learned = await titleVocabulary(db, query);
  const term = interpretSpacing(query, learned.phrases).term;
  const compiled = titleAutocompleteQuery(term, learned.words);
  const statement =
    db.dialect === 'postgres'
      ? db
          .prepare(`SELECT id,title FROM search_title_catalog
        WHERE to_tsvector('simple',title) @@ to_tsquery('simple',?)
        ORDER BY ts_rank_cd(to_tsvector('simple',title),to_tsquery('simple',?)) DESC, id DESC LIMIT 50`)
          .bind(compiled.postgres, compiled.postgres)
      : db
          .prepare(`SELECT rowid AS id,title FROM search_title_autocomplete
        WHERE search_title_autocomplete MATCH ? ORDER BY rank LIMIT 50`)
          .bind(compiled.sqlite);
  const { results } = await statement.all<Title>();
  const terms = searchTerms(term);
  const matchers = terms.map((word) => createTextMatcher(word));
  const scoreTitle = createRelevanceScorer(term);
  return [...new Map(results.map((title) => [title.id, title])).values()]
    .map((title) => ({ ...title, prepared: prepareMatchText(title.title) }))
    .filter(
      (title) =>
        Number.isSafeInteger(title.id) &&
        title.id > 0 &&
        title.title &&
        matchers.every((matcher) => matcher.score(title.prepared) > 0),
    )
    .map((title) => ({
      ...title,
      score:
        2000 *
          terms.filter((word) =>
            ` ${title.prepared.normalized} `.includes(` ${word} `),
          ).length +
        scoreTitle({
          title: title.title,
          topics: [],
          series: '',
          teacher: '',
          description: '',
        }),
    }))
    .sort(
      (a, b) =>
        b.score - a.score || a.title.length - b.title.length || b.id - a.id,
    )
    .slice(0, 5)
    .map((title) => ({
      id: title.id,
      kind: 'shiur',
      name: title.title,
      context: 'Shiur',
    }));
}

/** Isolate caches by database, cap their size, and share identical in-flight reads. */
export function createShiurAutocomplete(clock = Date.now) {
  const databases = new WeakMap<
    SearchDatabase,
    {
      cache: Map<string, { until: number; items: ShiurSuggestion[] }>;
      pending: Map<string, Promise<ShiurSuggestion[]>>;
    }
  >();
  return async (db: SearchDatabase, query: string) => {
    if (query.length > 300)
      throw new RangeError('Please use a shorter search.');
    const key = searchText(query);
    if (key.length < 3) return [];
    let state = databases.get(db);
    if (!state) {
      state = { cache: new Map(), pending: new Map() };
      databases.set(db, state);
    }
    const hit = state.cache.get(key);
    if (hit && hit.until > clock()) return hit.items;
    const active = state.pending.get(key);
    if (active) return active;
    if (state.pending.size >= 32) throw new Error('Suggestions are busy.');
    const request = findShiurSuggestions(db, key);
    state.pending.set(key, request);
    try {
      const items = await request;
      if (state.cache.size >= 64 && !state.cache.has(key))
        state.cache.delete(state.cache.keys().next().value!);
      state.cache.set(key, { until: clock() + 60000, items });
      return items;
    } finally {
      state.pending.delete(key);
    }
  };
}
