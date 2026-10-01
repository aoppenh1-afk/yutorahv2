/** Reviewed English word families. Avoid applying English stemming to names or
 * transliterated Torah terms; unknown words retain ordinary spelling matching.
 */
const nounBases =
  'parent guest candle blessing loan debt donation wedding vow oath mistake neighbor neighbour visitor meal object item animal fringe life'.split(
    ' ',
  );
const verbBases =
  'honor honour respect visit study learn pray cook light count mourn forgive welcome invite host raise educate save return help treat avoid waste charge pay wash stop'.split(
    ' ',
  );
const irregular: Record<string, string[]> = {
  child: ['child', 'children'],
  family: ['family', 'families'],
  life: ['life', 'lives'],
  person: ['person', 'people'],
  forgive: ['forgive', 'forgives', 'forgave', 'forgiven', 'forgiving'],
  pay: ['pay', 'pays', 'paid', 'paying'],
  light: ['light', 'lights', 'lit', 'lighted', 'lighting'],
  stop: ['stop', 'stops', 'stopped', 'stopping'],
};
const families = new Map<string, string[]>();
const register = (forms: string[]) => {
  for (const form of forms) {
    families.set(form, forms);
    if (!form.endsWith('s')) families.set(form + 's', forms);
  }
};
for (const base of nounBases)
  register([
    base,
    /[^aeiou]y$/.test(base)
      ? base.slice(0, -1) + 'ies'
      : /(?:s|ch|sh|x|z)$/.test(base)
        ? base + 'es'
        : base + 's',
  ]);
for (const base of verbBases) {
  const plural = /[^aeiou]y$/.test(base)
    ? base.slice(0, -1) + 'ies'
    : /(?:s|ch|sh|x|z)$/.test(base)
      ? base + 'es'
      : base + 's';
  const past = /[^aeiou]y$/.test(base)
    ? base.slice(0, -1) + 'ied'
    : base.endsWith('e')
      ? base + 'd'
      : base + 'ed';
  const participle = base.endsWith('e')
    ? base.slice(0, -1) + 'ing'
    : base + 'ing';
  register([base, plural, past, participle]);
}
for (const forms of Object.values(irregular)) register(forms);

export function englishWordForms(word: string): string[] {
  return families.get(word) ?? [word];
}
