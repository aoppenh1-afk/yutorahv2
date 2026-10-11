import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transcriptionPrompt } from '../../../packages/transcription/src/prompt.js';
import {
  cleanupPrompt,
  generateNotes,
  notesProfile,
  notesPrompt,
} from '../../../packages/transcription/src/notes.js';
import { defaultSettings } from '../../../packages/transcription/src/types.js';

const transcriptionSkill = await readFile(
  'packages/transcription/skills/lectern-transcription/SKILL.md',
  'utf8',
);
const notesSkill = await readFile(
  'packages/transcription/skills/lectern-notes/SKILL.md',
  'utf8',
);
const profile = notesProfile({
  model: defaultSettings.model,
  language: 'hebrewEnglish',
  runtime: 'orthography-test',
  transcriptionSkill,
  notesSkill,
});
const source = 'He davened in שול with his חברותא from the ישיבה.';
const outline =
  '# Davening in shul\n\n## His chavrusa\n\n- He davened in shul with his chavrusa from the yeshiva';
const signal = new AbortController().signal;

void test('native audio, cleanup, notes, and repair receive the English-spelling exceptions and quotation rule', () => {
  const prompts = [
    transcriptionPrompt(transcriptionSkill, defaultSettings, 'shiur.wav', 0, 1),
    cleanupPrompt(profile, source),
    notesPrompt(profile, source),
    notesPrompt(profile, source, '# Incomplete', ['Use ## sections']),
  ];
  for (const prompt of prompts) {
    const rule = prompt
      .split('\n')
      .find(
        (line) =>
          line.includes('keep `davening`') || line.includes('Keep `davening`'),
      );
    assert.ok(rule, 'English spelling rule reaches every generation stage');
    for (const term of [
      'davening',
      'leining',
      'bentching',
      'shul',
      'yahrzeit',
      'yeshiva',
      'chavrusa',
      'daven',
      'davened',
      'lein',
      'leined',
    ])
      assert.ok(rule.includes('`' + term + '`'), term);
    assert.match(rule, /English spelling/);
    assert.match(rule, /Preserve Hebrew wording in source quotations/);
  }
});

void test('notes from official Hebrew-spelled everyday words accept English spelling without a repair', async () => {
  let requests = 0;
  let saved = '';
  const result = await generateNotes({
    profile,
    source,
    signal,
    saveCleaned: async (text) => {
      saved = text;
    },
    request: async (prompt) => {
      requests++;
      assert.ok(prompt.includes(source));
      return outline;
    },
  });
  assert.equal(requests, 1);
  assert.equal(saved, source);
  assert.equal(result.markdown, outline);
});

void test('legacy cleanup and structural repair accept English spelling for everyday shiur terms', async () => {
  const legacy = notesProfile(profile, 'notes-1');
  const cleaned = 'He davened in shul with his chavrusa from the yeshiva.';
  let requests = 0;
  const result = await generateNotes({
    profile: legacy,
    source,
    signal,
    saveCleaned: async (text) => assert.equal(text, cleaned),
    request: async (prompt) => {
      requests++;
      if (requests === 1) {
        assert.ok(prompt.includes(source));
        return cleaned;
      }
      assert.ok(prompt.includes(cleaned));
      if (requests === 2) return '# Davening in shul';
      assert.match(prompt, /<draft-notes>/);
      return outline;
    },
  });
  assert.equal(requests, 3);
  assert.equal(result.cleaned, cleaned);
  assert.equal(result.markdown, outline);
});

void test('source quotations and other Hebrew Torah terms survive notes normalization', async () => {
  const quotedSource = 'He davened in shul. The גמ׳ uses the wording "ישיבה".';
  const quotedOutline =
    '# Davening in shul\n\n## The גמ׳\n\n- He davened in shul\n- **גמ׳:** uses the wording "ישיבה"';
  const result = await generateNotes({
    profile,
    source: quotedSource,
    signal,
    saveCleaned: async () => {},
    request: async (prompt) => {
      assert.ok(prompt.includes(quotedSource));
      return quotedOutline;
    },
  });
  assert.equal(result.markdown, quotedOutline);
});
