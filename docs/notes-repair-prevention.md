# Avoiding unnecessary notes repairs

The October 16 investigation replayed a frozen sample of 30 recent first-response validation failures. Twenty-five were genuinely wrong-language drafts. Four exposed a quotation-parser bug, and one contained only invisible direction formatting. The sample was selected from failures, so these proportions do not estimate the overall production repair rate.

The old regular expression treated the mark inside Hebrew abbreviations such as רש״י and רמב״ם as a quotation boundary. That accidentally protected intervening prose from unvocalized-term normalization, forcing a full-source model repair. It could also split a real quotation at an internal abbreviation and alter quoted vowel marks.

`presentation-4` uses a shared short-quotation parser for normalization and source validation. It ignores abbreviation marks between Hebrew letters, including adjacent vowel marks. The existing 240-character, single-line quotation boundary and verbatim source requirement remain. Ordinary prose loses only vowel/cantillation marks; real quotations retain their wording, and unsupported vocalized quotations still fail. Logical-order direction controls are removed without changing letters, word order or punctuation. Raw model responses remain private and immutable.

Replay against the original raw responses makes all five mechanical cases pass without inference while all 25 wrong-language drafts still fail. Regression tests first reproduced unnecessary second requests and corrupted quotation normalization, then passed with the fix. Existing language, source, runtime identity, zero-cost, cleanup and publication checks remain enforced.

Two prompt changes were tested and rejected. Each trial compared the original and a candidate on the same eight frozen complete official transcripts: six sources with earlier language failures and two first-pass controls. Source, full user contract, profile, free Muse model and High effort stayed fixed. Paired order alternated, with two concurrent sessions and conservative memory admission. Production was paused under its mutation lock; trial output stayed local, and every owned trial session was deleted.

| Candidate | Original responses needing repair | Candidate responses needing repair | Mean original request | Mean candidate request |
| --- | --- | --- | --- | --- |
| Longer final language/checking reminder | 3/8 | 3/8 | 31.1 seconds | 55.1 seconds |
| Short final language-only reminder | 0/8 | 0/8 | 44.3 seconds | 60.3 seconds |

Neither candidate demonstrated a benefit; the production prompt remains unchanged. These small trials also show provider/output variability: the same baseline had different language outcomes in the two rounds. Structural acceptance does not establish source fidelity or human acceptance, and no sustained throughput improvement is inferred from these trials.

Validation: 130 tests passed, one optional live-catalog test skipped; TypeScript, targeted lint and whitespace checks passed. Private frozen sources, prompts, raw responses, request evidence and results live under `STATE/upgrades/repair-prevention-*`. The normalizer update preserves existing notes, artifacts, queue checkpoints, credentials, regeneration epoch, four-worker qualification and the 3 GiB floor.
