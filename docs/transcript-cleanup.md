# Transcript filler cleanup

Research checked October 2, 2026:

- [Deepgram filler-word documentation](https://developers.deepgram.com/docs/filler-words) strips `uh` and `um` by default for readability, while preserving responses such as `uh-huh`.
- [AssemblyAI filler-word documentation](https://www.assemblyai.com/docs/pre-recorded-audio/include-filler-words) also removes fillers by default, with an option to preserve disfluencies.

For this English/Hebrew archive, we use a conservative deterministic publishing
pass: remove standalone `um`, `uh`, and `erm`, including stretched spellings.
Keep `like`, `so`, `well`, `you know`, `I mean`, `ah`, and `hmm`; those can carry
meaning. Preserve compounds, quoted standalone filler words, uppercase acronyms,
Hebrew words, repetitions, and false starts. This narrow policy is our application
choice, rather than a claim that a regular expression can identify every disfluency.

Cleanup runs after chunk overlap merging and again at the storage boundary.
Accepted raw chunks and their digests stay unchanged, including on resume. No
extra model calls, audio processing, or fingerprint changes are needed. Surviving
segments keep their exact timestamps, language, and speaker. Filler-only segments
are omitted; a wholly empty result fails validation. Full text and adjacent-segment
search windows are built from the cleaned segments together.

## Existing transcripts

Build the worker, load the operator's write `DATABASE_URL` into the environment,
and inspect a dry run:

```sh
npm run worker:build
npm run worker -- clean-transcripts
```

Apply with a private backup location outside the checkout:

```sh
npm run worker -- clean-transcripts --apply --backup-dir /var/backups/yutorah
```

The command visits every stored transcript version in pages of 100, with one
transaction per transcript. Before writing a changed record, it saves the original
transcript row and all segment rows (including search fields) as a private JSON
file in a new run directory. A backup failure aborts that transaction. Each update
atomically replaces full text and segments, recalculates phrase windows, and lets
PostgreSQL refresh generated search vectors. IDs, job state, notes associations,
metadata, timestamps, and raw checkpoints remain intact. Existing generated study
notes are independent documents and are not regenerated.

The command reports scanned/changed counts and omitted segment counts. Run the dry
run again afterward: `changed: 0` confirms that all visited records satisfy this
policy. It is safe to repeat the command. If a process stops, earlier completed
transactions retain their backups; rerunning handles the remaining records.

For recovery, use the original JSON to restore its transcript text and segment
rows together in a transaction, preserving `transcript_id` and `segment_index`.
Keep backups private: they contain the original lecture text.

## Production cleanup, October 2, 2026

The production pass scanned all 563 stored transcripts and updated 119, removing
4,804 hesitation tokens. Every changed record has an original JSON backup under
`/var/backups/yutorah/filler-cleanup-20261002`. The independent readback audit checked
all 18,452 segments, confirmed zero remaining cleanup candidates, and verified
full-text consistency and every segment's normalized search text and phrase window.
For changed transcripts, IDs, fingerprints, creation dates, timestamps, speakers,
and language matched the backed-up originals. No segments needed removal.

The private `verification.json` in that backup directory records the audit totals.
The public production transcript endpoint for shiur 1189252 returned HTTP 200 with
cleaned text matching its timestamped segments. This pass updated stored content;
the automatic publishing change takes effect when the worker runs this code.
