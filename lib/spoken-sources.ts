/** Recover locations actually spoken in the transcript. Every proposal still needs Sefaria validation. */
export type SpokenCitation = {
  ref: string;
  category: string;
  start: number;
  end: number;
  ranges: Array<{ start: number; end: number }>;
};
type Name = {
  title: string;
  aliases: string;
  kind:
    | 'talmud'
    | 'commentary'
    | 'sectioned'
    | 'siman'
    | 'part'
    | 'author'
    | 'law';
};
type Anchor = Name & { start: number; end: number };
type Token = { text: string; start: number; end: number };
type Address = { value: string; start: number; end: number; next: number };

const tractates = [
  ['Berakhot', 'berachot|berachos|brachot|brachos|berakhot|ברכות'],
  ['Shabbat', 'shabbat|shabbos|שבת'],
  ['Eruvin', 'eruvin|eiruvin|ערובין|עירובין'],
  ['Pesachim', 'pesachim|psachim|pesahim|פסחים'],
  ['Rosh Hashanah', 'rosh\\s+ha(?:shanah|shana|shonah|shona)|ראש\\s+השנה'],
  ['Yoma', 'yoma|יומא'],
  ['Sukkah', 'sukkah|sukka|succah|succos|sukkos|סוכה'],
  ['Beitzah', 'beitzah|beitza|beitsah|ביצה'],
  ['Taanit', "taanit|taanis|ta[’']anit|תענית"],
  ['Megillah', 'megillah|megilla|מגילה'],
  ['Moed Katan', 'moed\\s+katan|מועד\\s+קטן'],
  ['Chagigah', 'chagigah|chagiga|hagigah|חגיגה'],
  ['Yevamot', 'yevamot|yevamos|יבמות'],
  ['Ketubot', 'ketubot|ketubos|kesubos|כתובות'],
  ['Nedarim', 'nedarim|נדרים'],
  ['Nazir', 'nazir|נזיר'],
  ['Sotah', 'sotah|sota|סוטה'],
  ['Gittin', 'gittin|gitin|גיטין'],
  ['Kiddushin', 'kiddushin|kidushin|קדושין|קידושין'],
  ['Bava Kamma', 'bav[ae]\\s+(?:kamma|kama|kamah)|בבא\\s+קמא'],
  ['Bava Metzia', 'bav[ae]\\s+(?:metzia|metsia|metziah)|בבא\\s+מציעא'],
  ['Bava Batra', 'bav[ae]\\s+(?:batra|basra)|בבא\\s+בתרא'],
  ['Sanhedrin', 'sanhedrin|סנהדרין'],
  ['Makkot', 'makkot|makkos|makot|makos|מכות'],
  ['Shevuot', 'shevuot|shevuos|shvuos|שבועות'],
  ['Avodah Zarah', 'avod[ae]h?\\s+zar[ae]h?|עבודה\\s+זרה'],
  ['Horayot', 'horayot|horayos|הוריות'],
  ['Zevachim', 'zevachim|zvachim|זבחים'],
  ['Menachot', 'menachot|menachos|menahot|מנחות'],
  ['Chullin', 'chullin|chulin|hullin|חולין'],
  ['Bekhorot', 'bekhorot|bechorot|bechoros|bechiros|בכורות'],
  ['Arakhin', 'arakhin|arachin|erchin|ערכין'],
  ['Temurah', 'temurah|temura|תמורה'],
  ['Keritot', 'keritot|kerisos|kritot|כריתות'],
  ['Meilah', 'meilah|meila|מעילה'],
  ['Tamid', 'tamid|תמיד'],
  ['Niddah', 'niddah|nidah|nidda|נדה|נידה'],
];
const names: Name[] = [
  ...tractates.map(([title, aliases]) => ({
    title,
    aliases,
    kind: 'talmud' as const,
  })),
  {
    title: 'Tosafot',
    aliases: 'tosafot|tosafos|tosfos|tosfot|תוספות|תוס[״"׳\']',
    kind: 'commentary',
  },
  { title: 'Rashi', aliases: 'rashi|רש[״"׳\']י', kind: 'commentary' },
  { title: 'Ramban', aliases: 'ramban|רמב[״"׳\']ן', kind: 'commentary' },
  { title: 'Rashba', aliases: 'rashba|רשב[״"׳\']א', kind: 'commentary' },
  { title: 'Ritva', aliases: 'ritva|ריטב[״"׳\']א', kind: 'commentary' },
  { title: 'Ran', aliases: 'ran|ר[״"׳\']ן', kind: 'commentary' },
  { title: 'Rosh', aliases: 'rosh|רא[״"׳\']ש', kind: 'commentary' },
  { title: 'Maharsha', aliases: 'maharsha|מהרש[״"׳\']א', kind: 'commentary' },
  {
    title: 'Shulchan Arukh',
    aliases: 'shulch[ao]n\\s+(?:aruch|arukh|oruch)|שולחן\\s+ערוך|שו[״"׳\']ע',
    kind: 'sectioned',
  },
  { title: 'Tur', aliases: 'tur|טור', kind: 'sectioned' },
  {
    title: 'Beit Yosef',
    aliases: 'bei[st]\\s+yose[fp]h?|בית\\s+יוסף',
    kind: 'sectioned',
  },
  {
    title: 'Responsa Chatam Sofer',
    aliases: 'cha[st]am\\s+so[fp]her|cha[st]am\\s+sofer|חתם\\s+סופר',
    kind: 'sectioned',
  },
  {
    title: 'Turei Zahav on Shulchan Arukh',
    aliases: 'taz|turei\\s+zahav|ט[״"׳\']ז',
    kind: 'sectioned',
  },
  {
    title: 'Mishnah Berurah',
    aliases:
      'mishn[ae]h?\\s+ber(?:u|o)rah?|mishna\\s+brura|משנה\\s+ברורה|מ[״"׳\']ב',
    kind: 'siman',
  },
  {
    title: 'Magen Avraham',
    aliases: 'mag[ae]n\\s+avrah[ao]m|מגן\\s+אברהם',
    kind: 'siman',
  },
  {
    title: 'Mishneh Torah',
    aliases: 'rambam|רמב[״"׳\']ם|mishneh\\s+torah|משנה\\s+תורה',
    kind: 'author',
  },
  ...[
    ['Marriage', 'ishus|ishut|אישות'],
    ['Blessings', 'brachos|berachos|berakhot|ברכות'],
    ['Fringes', 'tzitzis|tzitzit|ציצית'],
    ['Circumcision', 'milah|mila|מילה'],
    ['Sabbath', 'shabbos|shabbat|שבת'],
    [
      'Daily Offerings and Additional Offerings',
      'temidin\\s+u(?:m|\\s+m)usafin|תמידין\\s+ומוספין|תמידים\\s+ומוספים',
    ],
  ].map(([title, aliases]) => ({
    title: 'Mishneh Torah, ' + title,
    aliases: `(?:hilchos|hilchot|hilkhot|הלכות)\\s+(?:${aliases})`,
    kind: 'law' as const,
  })),
  {
    title: 'Orach Chayim',
    aliases:
      'o(?:r|ra)ch\\s+ch(?:ayim|aim|ay[i]?m)|[ao]r(?:a|au)?ch\\s+cha[iy]m|auruch\\s+chaim|אורח\\s+חיים|או[״"׳\']ח',
    kind: 'part',
  },
  {
    title: "Yoreh De'ah",
    aliases: 'yoreh?\\s+d[ei][ae]h?|יורה\\s+דעה|יו[״"׳\']ד',
    kind: 'part',
  },
  {
    title: 'Even HaEzer',
    aliases: 'even\\s+(?:ha\\s*)?e[sz]er|אבן\\s+העזר|אה[״"׳\']ע',
    kind: 'part',
  },
  {
    title: 'Choshen Mishpat',
    aliases: 'chosh[ae]n\\s+mishpat|choshen\\s+mishpot|חושן\\s+משפט|חו[״"׳\']מ',
    kind: 'part',
  },
];
const patterns = names.map((name) => ({
  name,
  pattern: new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${name.aliases})(?![\\p{L}\\p{N}])`,
    'giu',
  ),
}));
const english: Record<string, number> = {
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
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
};
const letters: Record<string, number> = {
  aleph: 1,
  alef: 1,
  beis: 2,
  bais: 2,
  bet: 2,
  gimmel: 3,
  gimel: 3,
  daled: 4,
  dalet: 4,
  hei: 5,
  hey: 5,
  vav: 6,
  zayin: 7,
  zain: 7,
  ches: 8,
  chet: 8,
  tes: 9,
  tet: 9,
  yud: 10,
  yod: 10,
  kaf: 20,
  chaf: 20,
  lamed: 30,
  mem: 40,
  nun: 50,
  samech: 60,
  ayin: 70,
  pei: 80,
  peh: 80,
  tzadi: 90,
  tzadik: 90,
  kuf: 100,
  kof: 100,
  resh: 200,
  shin: 300,
  tav: 400,
  taf: 400,
};
const hebrew: Record<string, number> = {
  א: 1,
  ב: 2,
  ג: 3,
  ד: 4,
  ה: 5,
  ו: 6,
  ז: 7,
  ח: 8,
  ט: 9,
  י: 10,
  כ: 20,
  ך: 20,
  ל: 30,
  מ: 40,
  ם: 40,
  נ: 50,
  ן: 50,
  ס: 60,
  ע: 70,
  פ: 80,
  ף: 80,
  צ: 90,
  ץ: 90,
  ק: 100,
  ר: 200,
  ש: 300,
  ת: 400,
};
const siman = /^(?:sim[ao]n|[בל]?סימן)$/iu;
const daf = /^(?:daf|[ב]?דף)$/iu;
const seif = /^(?:s[ei]+f|[ב]?סעיף)$/iu;
const katan = /^(?:k[ao]t[ao]n|קטן)$/iu;
const chapter = /^(?:perek|chapter|[ב]?פרק)$/iu;
const halacha = /^(?:halach[ao]h?|halakhah?|[ב]?הלכה)$/iu;

function readNumber(tokens: Token[], at: number): Address | null {
  const token = tokens[at];
  if (!token) return null;
  const word = token.text.toLowerCase();
  let next = at + 1,
    value = 0;
  if (/^\d+[ab]?$/u.test(word)) {
    if (parseInt(word) < 1 || parseInt(word) > 9999) return null;
    return { value: word, start: token.start, end: token.end, next };
  }
  if (Object.hasOwn(english, word)) {
    value = english[word];
    if (tokens[next]?.text === 'hundred' && value < 10) {
      value *= 100;
      next++;
      if (tokens[next]?.text === 'and' && english[tokens[next + 1]?.text])
        next++;
      if (english[tokens[next]?.text]) {
        value += english[tokens[next].text];
        next++;
      }
    }
    if (tokens[next]?.text === '-' && english[tokens[next + 1]?.text] < 10)
      next++;
    if (value % 10 === 0 && value >= 20 && english[tokens[next]?.text] < 10) {
      value += english[tokens[next].text];
      next++;
    }
  } else if (Object.hasOwn(letters, word)) {
    value = letters[word];
    while (
      letters[tokens[next]?.text] &&
      letters[tokens[next].text] < letters[tokens[next - 1].text]
    ) {
      value += letters[tokens[next].text];
      next++;
    }
  } else {
    const numeral = word.replace(/[״"׳'’]/gu, '');
    if (!/^[א-ת]{1,4}$/u.test(numeral)) return null;
    const values = Array.from(numeral, (char) => hebrew[char]);
    // Reject ordinary Hebrew words, while allowing conventional 15/16 and repeated tavs.
    if (
      numeral !== 'טו' &&
      numeral !== 'טז' &&
      values.some((n, i) => i && n > values[i - 1])
    )
      return null;
    value = values.reduce((sum, n) => sum + n, 0);
  }
  return value
    ? {
        value: String(value),
        start: token.start,
        end: tokens[next - 1].end,
        next,
      }
    : null;
}

function markerAddress(
  tokens: Token[],
  marker: RegExp,
  after = 0,
  numberBefore = false,
): Address | null {
  for (let i = after; i < tokens.length; i++) {
    if (!marker.test(tokens[i].text)) continue;
    let at = i + 1;
    if (/^(?:number|מספר)$/iu.test(tokens[at]?.text || '')) at++;
    const number = readNumber(tokens, at);
    if (number) return { ...number, start: tokens[i].start };
    if (numberBefore && i > after) {
      const preceding = readNumber(tokens, i - 1);
      if (preceding?.next === i)
        return { ...preceding, end: tokens[i].end, next: i + 1 };
    }
  }
  return null;
}
function sideAddress(
  tokens: Token[],
  number: Address,
  marked: boolean,
): Address {
  if (/[ab]$/u.test(number.value)) return number;
  let at = number.next;
  const marker = tokens[at]?.text || '';
  const compact = marker.match(/^ע[״"׳']([אב])[׳']?$/u);
  if (compact)
    return {
      ...number,
      value: number.value + (compact[1] === 'א' ? 'a' : 'b'),
      end: tokens[at].end,
      next: at + 1,
    };
  if (/^(?:amud|עמוד|ע[״"׳']?)$/iu.test(marker)) at++;
  else if (
    marked &&
    /[א-ת]/u.test(tokens[number.next - 1].text) &&
    /^[.:]$/u.test(marker)
  ) {
    return {
      ...number,
      value: number.value + (marker === '.' ? 'a' : 'b'),
      end: tokens[at].end,
      next: at + 1,
    };
  } else if (!/^[ab]$/iu.test(marker)) return number;
  const side = (tokens[at]?.text || '').replace(/[״"׳'’]/gu, '');
  const value = /^(?:a|aleph|alef|א)$/iu.test(side)
    ? 'a'
    : /^(?:b|beis|bais|bet|ב)$/iu.test(side)
      ? 'b'
      : null;
  return value
    ? {
        ...number,
        value: number.value + value,
        end: tokens[at].end,
        next: at + 1,
      }
    : number;
}

/** All indexes here are UTF-16, as in String.slice. Windows cannot pass another named source. */
export function spokenCitations(text: string): SpokenCitation[] {
  // Official VTT often vocalizes Hebrew names and addresses. Match unvocalized text,
  // then restore exact original UTF-16 spans so links preserve the transcript.
  const positions: number[] = [];
  const characters: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (/[\u0591-\u05bd\u05bf-\u05c7\u200e\u200f]/u.test(text[i])) continue;
    positions.push(i);
    characters.push(text[i]);
  }
  const at = (index: number) => positions[index] ?? text.length;
  return parseSpokenCitations(characters.join('')).map((citation) => ({
    ...citation,
    start: at(citation.start),
    end: at(citation.end),
    ranges: citation.ranges.map((range) => ({
      start: at(range.start),
      end: at(range.end),
    })),
  }));
}

function parseSpokenCitations(text: string): SpokenCitation[] {
  const allAnchors = patterns
    .flatMap(({ name, pattern }) =>
      Array.from(text.matchAll(pattern), (match) => ({
        ...name,
        start: match.index,
        end: match.index + match[0].length,
      })),
    )
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const anchors: Anchor[] = [];
  for (const anchor of allAnchors) {
    if (anchor.start < (anchors.at(-1)?.end ?? 0)) continue;
    if (
      /(?:\b(?:daf|sim[ao]n|seif|sif|katan|amud)|דף|סימן|סעיף|קטן|עמוד)\s*$/iu.test(
        text.slice(Math.max(0, anchor.start - 20), anchor.start),
      )
    )
      continue;
    anchors.push(anchor);
  }
  const citations: SpokenCitation[] = [];
  for (const [index, anchor] of anchors.entries()) {
    if (
      anchor.kind === 'commentary' ||
      anchor.kind === 'part' ||
      anchor.kind === 'author'
    )
      continue;
    let lastAnchor = anchor;
    let title = anchor.title;
    const nameRanges = [{ start: anchor.start, end: anchor.end }];
    const following = anchors[index + 1];
    if (anchor.kind === 'sectioned') {
      if (
        !following ||
        following.kind !== 'part' ||
        following.start - anchor.end > 180
      )
        continue;
      // Shulchan Arukh HaRav is a different work, not a title variant.
      if (/\bha\s*rav\b|הרב/iu.test(text.slice(anchor.end, following.start)))
        continue;
      title += ', ' + following.title;
      lastAnchor = following;
      nameRanges.push({ start: following.start, end: following.end });
    }
    const nextAnchor = anchors[index + (anchor.kind === 'sectioned' ? 2 : 1)];
    const end = Math.min(
      text.length,
      anchor.start + 450,
      lastAnchor.end + 240,
      nextAnchor?.start ?? Infinity,
    );
    let bounded = citationTokens(text, lastAnchor.end, end);
    if (anchor.kind === 'law') {
      const author = anchors[index - 1];
      if (author?.kind !== 'author' || anchor.start - author.end > 180)
        continue;
      nameRanges.unshift({ start: author.start, end: author.end });
      bounded = citationTokens(text, author.end, end);
    }
    const isTalmud = anchor.kind === 'talmud';
    const marker = isTalmud ? daf : anchor.kind === 'law' ? chapter : siman;
    let address = markerAddress(bounded, marker, 0, anchor.kind === 'law');
    const marked = !!address;
    if (!address) {
      let at = 0;
      if (bounded[at]?.text === ',') at++;
      address = readNumber(bounded, at);
      // Unmarked Hebrew prose after a title is not a number.
      if (
        address &&
        /^[א-ת]/u.test(bounded[at].text) &&
        !/[״"׳']/u.test(bounded[at].text)
      )
        address = null;
      if (
        address &&
        text.slice(lastAnchor.end, address.start).trim().replace(',', '')
      )
        address = null;
      if (
        address &&
        /^(?:minutes?|seconds?|hours?|days?|years?|percent|people|dollars?)$/iu.test(
          bounded[address.next]?.text || '',
        )
      )
        address = null;
    }
    let reversed = false;
    if (!address && isTalmud) {
      const previous = anchors[index - 1];
      const from = Math.max(previous?.end ?? 0, anchor.start - 100);
      const before = text.slice(from, anchor.start);
      if (!/[.!?;\n]/u.test(before)) {
        const tokens = citationTokens(text, from, anchor.start);
        const preceding = markerAddress(tokens, daf);
        if (preceding) {
          const withSide = sideAddress(tokens, preceding, true);
          if (
            /^[\s,]*(?:(?:in|on|of|masechet|maseches|tractate|מסכת|במסכת)\s*)*$/iu.test(
              text.slice(withSide.end, anchor.start),
            )
          ) {
            address = preceding;
            bounded = tokens;
            reversed = true;
          }
        }
      }
    }
    if (!address) continue;
    if (isTalmud) {
      address = sideAddress(bounded, address, marked || reversed);
      // A perek cannot become a daf. An explicitly cited daf can locate a Mishnah within Bavli.
      const prefix = text.slice(Math.max(0, anchor.start - 35), anchor.start);
      if (/(?:yerushalmi|ירושלמי)\s*(?:in|on|במסכת|מסכת)?\s*$/iu.test(prefix))
        continue;
      if (
        !marked &&
        /(?:mishn[ae]h?|משנה)\s*(?:in|on|במסכת|מסכת)?\s*$/iu.test(prefix)
      )
        continue;
      const previous = anchors[index - 1];
      if (
        previous?.kind === 'commentary' &&
        anchor.start - previous.end < 100 &&
        !/[.!?;\n]/u.test(text.slice(previous.end, anchor.start))
      ) {
        title = previous.title + ' on ' + title;
        nameRanges.unshift({ start: previous.start, end: previous.end });
      }
    }
    const locations = [{ start: address.start, end: address.end }];
    let location = address.value;
    const separator = bounded[address.next]?.text;
    if (/^(?:-|–|to|through|עד)$/iu.test(separator || '')) {
      let endpoint = readNumber(bounded, address.next + 1);
      if (!endpoint) continue;
      if (isTalmud) endpoint = sideAddress(bounded, endpoint, marked);
      if (
        isTalmud &&
        /[ab]$/u.test(address.value) !== /[ab]$/u.test(endpoint.value)
      ) {
        location = address.value.replace(/^(\d+)$/u, '$1a');
        endpoint = {
          ...endpoint,
          value: endpoint.value.replace(/^(\d+)$/u, '$1b'),
        };
      }
      location += '-' + endpoint.value;
      locations.push({ start: bounded[address.next].start, end: endpoint.end });
      address = endpoint;
    } else if (
      separator === ':' &&
      /^\d+$/u.test(bounded[address.next + 1]?.text || '')
    ) {
      const sub = readNumber(bounded, address.next + 1)!;
      location += ':' + sub.value;
      locations.push({ start: bounded[address.next].start, end: sub.end });
      address = sub;
    } else if (!isTalmud) {
      if (anchor.kind === 'law') {
        const sub = markerAddress(bounded, halacha, address.next);
        if (sub) {
          location += ':' + sub.value;
          locations.push({ start: sub.start, end: sub.end });
          address = sub;
        }
      }
      // Seif katan belongs to the named commentary, never the Shulchan Arukh seif.
      for (
        let i = address.next;
        anchor.kind !== 'law' && i < bounded.length;
        i++
      ) {
        let at = i + 1;
        const small = /^(?:sk|ס[״"׳']?ק)$/iu.test(bounded[i].text);
        if (!small && !seif.test(bounded[i].text)) continue;
        const isKatan = small || katan.test(bounded[at]?.text || '');
        if (!small && isKatan) at++;
        if (
          isKatan &&
          anchor.kind !== 'siman' &&
          anchor.title !== 'Turei Zahav on Shulchan Arukh'
        )
          break;
        const sub = readNumber(bounded, at);
        if (sub) {
          location += ':' + sub.value;
          locations.push({ start: bounded[i].start, end: sub.end });
          address = sub;
        }
        break;
      }
    }
    const ranges = [...nameRanges, ...locations].sort(
      (a, b) => a.start - b.start,
    );
    if (Math.max(anchor.end, address.end) - ranges[0].start > 450) continue;
    citations.push({
      ref: title + ' ' + location,
      category:
        title.includes(' on ') ||
        anchor.kind === 'siman' ||
        anchor.title.startsWith('Beit') ||
        anchor.title.startsWith('Turei')
          ? 'Commentary'
          : isTalmud
            ? 'Talmud'
            : title.startsWith('Responsa')
              ? 'Responsa'
              : 'Halakhah',
      start: ranges[0].start,
      end: Math.max(anchor.end, address.end),
      ranges,
    });
    if (citations.length >= 128) break;
  }
  return citations;
}

function citationTokens(text: string, start: number, end: number): Token[] {
  return Array.from(
    text
      .slice(start, end)
      .matchAll(
        /\d+[ab]?(?![\p{L}\p{N}])|[\p{L}]+(?:[״"׳'’][א-ת]+)*[״"׳'’]?|[:.,\-–]/giu,
      ),
    (match) => ({
      text: match[0].toLowerCase(),
      start: start + match.index,
      end: start + match.index + match[0].length,
    }),
  ).slice(0, 40);
}
