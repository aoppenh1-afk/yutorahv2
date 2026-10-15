import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateNotes,
  notesProfile,
  notesViolations,
  violationCode,
} from '../packages/notes-only/src/notes.js';

const englishSource =
  'We begin by defining meat and milk. The distinction matters because cooking creates a different prohibition. We must examine the original case before applying this rule. '.repeat(
    8,
  );
const hebrewProse =
  'תחילה אנו מגדירים את הדין ואת המקרה שבו הוא נוהג. לאחר מכן יש לברר את ההבדל בין שני המקרים ואת הטעם של כל שיטה. לבסוף נשארת השאלה תלויה בביאור דברי הראשונים. ';
const hebrewNote = (
  '# הגדרת הדין\n\n## שני המקרים\n\n' + hebrewProse.repeat(6)
).trim();
const englishNote =
  '# הגדרת הדין\n\n## The two cases\n\nWe begin by defining the דין. The distinction between these cases explains the argument and its consequence.'.trim();
const profile = notesProfile({
  model: 'free',
  runtime: 'test',
  language: 'hebrewEnglish',
  notesSkill: 'Write English explanatory prose with Hebrew terminology.',
});
const signal = new AbortController().signal;
const languageErrors = (markdown: string, source: string) =>
  notesViolations(markdown, source)
    .map(violationCode)
    .filter((code) => code === 'unexpected_hebrew');

void test('fully Hebrew notes from an English transcript fail validation (1186753 regression)', () => {
  assert.deepEqual(languageErrors(hebrewNote, englishSource), [
    'unexpected_hebrew',
  ]);
});
void test('English titles and headings cannot conceal a Hebrew-only body', () => {
  assert.deepEqual(
    languageErrors(
      '# Meat and milk\n\n## Introduction\n\n' + hebrewProse.repeat(6),
      englishSource,
    ),
    ['unexpected_hebrew'],
  );
});
void test('English/transliterated names and a URL do not make overwhelmingly Hebrew prose acceptable', () => {
  assert.deepEqual(
    languageErrors(
      hebrewNote + ' Rambam https://example.com/english-reference-title',
      englishSource,
    ),
    ['unexpected_hebrew'],
  );
});
void test('an entirely Hebrew response and repair are never approved for an English source', async () => {
  let calls = 0;
  await assert.rejects(
    generateNotes({
      profile,
      source: englishSource,
      signal,
      request: async () => {
        calls++;
        return hebrewNote;
      },
    }),
    /incomplete_output/,
  );
  assert.equal(calls, 2, 'only the existing single repair is allowed');
});
void test('a language violation requests English explanatory prose in the full-source repair', async () => {
  const prompts: string[] = [];
  const result = await generateNotes({
    profile,
    source: englishSource,
    signal,
    request: async (prompt, kind) => {
      prompts.push(prompt);
      return kind === 'generation' ? hebrewNote : englishNote;
    },
  });
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].includes(englishSource));
  assert.match(prompts[1], /English explanatory prose/);
  assert.equal(result.markdown, englishNote);
});
void test('an entirely Hebrew transcript permits Hebrew notes without a repair', async () => {
  const source = hebrewProse.repeat(12);
  let calls = 0;
  assert.deepEqual(languageErrors(hebrewNote, source), []);
  const result = await generateNotes({
    profile,
    source,
    signal,
    request: async () => {
      calls++;
      return hebrewNote;
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.markdown, hebrewNote);
});
void test('a mixed transcript with substantive English is not the Hebrew-source exception', () => {
  assert.deepEqual(
    languageErrors(hebrewNote, hebrewProse.repeat(5) + englishSource),
    ['unexpected_hebrew'],
  );
});
void test('normal English explanations retain Hebrew titles, terminology and quotations', () => {
  assert.deepEqual(
    languageErrors(
      englishNote +
        ' The source states “' +
        hebrewProse +
        '” and that supports the distinction.',
      englishSource,
    ),
    [],
  );
});
void test('missing language evidence never supplies the Hebrew-transcript exception', () => {
  assert.deepEqual(languageErrors(hebrewNote, '12345'), ['unexpected_hebrew']);
});
