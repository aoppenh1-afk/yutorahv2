import type { SearchPlan } from './yutorah';
import {
  interpretSearchRequest,
  searchText,
  wordMatch,
} from './search-matching';

/** Deterministic, disclosed interpretation. Never generates religious answers. */
export function naturalSearch(
  query: string,
  now = new Date(),
): { term: string; options: Partial<SearchPlan>; labels: string[] } {
  let term = query.trim();
  const options: Partial<SearchPlan> = {};
  const labels: string[] = [];
  // Protect quoted phrases from conversational cleanup.
  const quotes: string[] = [];
  term = term.replace(/"[^"]+"/g, (value) => {
    quotes.push(value);
    return `QUOTED${quotes.length - 1}TOKEN`;
  });
  // Correct only recognizable request/filter words, with a unique one-edit
  // whole-word match. Subjects and quoted phrases are handled separately.
  const controls = [
    'please',
    'find',
    'show',
    'recommend',
    'shiur',
    'shiurim',
    'lecture',
    'lectures',
    'minutes',
    'minute',
    'under',
    'newest',
    'latest',
    'shortest',
    'longest',
    'english',
    'hebrew',
    'improve',
    'understand',
    'explain',
  ];
  term = term.replace(/[\p{L}\p{M}]+/gu, (word) => {
    const normalized = searchText(word);
    if (normalized.length < 4 || controls.includes(normalized)) return word;
    const matches = [
      ...new Set(
        controls
          .filter((control) => wordMatch(normalized, control) === 0.65)
          .map((control) =>
            /^minutes?$/.test(control)
              ? 'minutes'
              : /^lectures?$/.test(control)
                ? 'lecture'
                : control,
          ),
      ),
    ];
    if (matches.length !== 1) return word;
    labels.push(`${word} → ${matches[0]}`);
    return matches[0];
  });
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    fifteen: 15,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    ninety: 90,
  };
  term = term.replace(
    /\b(twenty|thirty|forty|fifty|sixty|ninety)[ -](one|two|three|four|five|six|seven|eight|nine)(?=\s+(?:minutes?|mins?|hours?))/gi,
    (_, tens, unit) =>
      String(words[tens.toLowerCase()] + words[unit.toLowerCase()]),
  );
  term = term
    .replace(
      /\b(one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety)\s+(minutes?|mins?|hours?)\b/gi,
      (_, n, unit) => `${words[n.toLowerCase()]} ${unit}`,
    )
    .replace(/\b(?:half (?:an? )?hour|half-hour)\b/gi, '30 minutes')
    .replace(/\b(?:an?|one) hour\b/gi, '60 minutes')
    .replace(
      /\b(\d+(?:\.\d+)?)\s*hours?\b/gi,
      (_, n) => `${Number(n) * 60} minutes`,
    );
  const minutes = (n: string) => Math.max(1, Math.min(240, Number(n)));
  term = term.replace(
    /\bbetween\s+(\d+)\s*(?:minutes?\s*)?and\s+(\d+)\s*(?:minutes?|mins?)\b/gi,
    (_, a, b) => {
      options.min = minutes(a);
      options.max = minutes(b);
      return ' ';
    },
  );
  term = term.replace(
    /\b(?:at least|longer than|over|more than)\s+(\d+)\s*(?:minutes?|mins?)\b/gi,
    (_, n) => {
      options.min = minutes(n);
      return ' ';
    },
  );
  term = term.replace(
    /\b(?:i (?:only )?have|i(?:'ve| have) got|for my|for a)\s+(\d+)\s*(?:minutes?|mins?)(?:\s+(?:commute|drive|walk|to listen|to learn))?\b/gi,
    (_, n) => {
      options.max = minutes(n);
      return ' ';
    },
  );
  term = term.replace(
    /\b(?:short|quick)\s+(?=(?:shiur|lecture|class|audio|video|lesson))/gi,
    () => {
      options.max ||= 20;
      return '';
    },
  );
  term = term
    .replace(/\b(?:newest|latest|most recent)(?:\s+first)?\b/gi, () => {
      options.sort = 'new';
      return ' ';
    })
    .replace(/\boldest(?:\s+first)?\b/gi, () => {
      options.sort = 'old';
      return ' ';
    })
    .replace(/\bshortest(?:\s+first)?\b/gi, () => {
      options.sort = 'short';
      return ' ';
    })
    .replace(/\blongest(?:\s+first)?\b/gi, () => {
      options.sort = 'long';
      return ' ';
    });
  const day = (date: Date) => date.toISOString().slice(0, 10);
  term = term.replace(
    /\b(?:from |during |in )?(this year|last year|this month|last month)\b/gi,
    (_, period) => {
      const y = now.getUTCFullYear(),
        m = now.getUTCMonth();
      const start = new Date(
        Date.UTC(
          y - (period.toLowerCase() === 'last year' ? 1 : 0),
          /month/i.test(period)
            ? m - (period.toLowerCase() === 'last month' ? 1 : 0)
            : 0,
          1,
        ),
      );
      const end = /last year/i.test(period)
        ? new Date(Date.UTC(y, 0, 0))
        : /last month/i.test(period)
          ? new Date(Date.UTC(y, m, 0))
          : now;
      options.after = day(start);
      options.before = day(end);
      return ' ';
    },
  );
  term = term.replace(
    /\b(?:from |in |during )?(?:the )?(?:past|last)\s+(\d+)\s+(days?|weeks?)\b/gi,
    (_, n, unit) => {
      options.after = day(
        new Date(
          now.getTime() -
            Math.min(3650, Number(n) * (/week/i.test(unit) ? 7 : 1)) * 86400000,
        ),
      );
      options.before = day(now);
      return ' ';
    },
  );
  term = term.replace(/\b(?:from|in|during)\s+((?:19|20)\d{2})\b/gi, (_, y) => {
    options.after = `${y}-01-01`;
    options.before = `${y}-12-31`;
    return ' ';
  });
  term = term.replace(/\b(?:since|after)\s+((?:19|20)\d{2})\b/gi, (_, y) => {
    options.after = `${y}-01-01`;
    return ' ';
  });
  term = term.replace(
    /\b(?:without|excluding|exclude|but not)\s+([\p{L}\p{N}]+)/giu,
    (_, word) => {
      options.exclude = [options.exclude, word].filter(Boolean).join(' ');
      return ' ';
    },
  );
  term = term.replace(
    /\b(?:in )?(english|hebrew)\s+(?=shiur|lecture|class|audio|video|lesson)/gi,
    (_, language) => {
      options.language = /hebrew/i.test(language) ? 'HE' : 'EN';
      return ' ';
    },
  );
  const request = interpretSearchRequest(term);
  term = request.term;
  labels.push(...request.labels);
  term = term.replace(/QUOTED(\d+)TOKEN/g, (_, i) => quotes[Number(i)]);
  return { term: term.replace(/\s+/g, ' ').trim(), options, labels };
}
