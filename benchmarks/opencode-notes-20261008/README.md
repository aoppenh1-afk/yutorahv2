# OpenCode notes benchmark: eight YU Torah shiurim

Completed on October 8, 2026. Muse Spark 1.3 Contributor Free generated notes successfully for **8/8 shiurim**, with **zero repairs**, using the full existing Lectern notes skill. Gemini 3.8 Flash Medium also completed 8/8 without repairs.

Muse's median end-to-end notes time was **22.5 seconds**, versus **61.5 seconds** for Gemini: a **2.74× ratio of medians**, or **63.5% less time**. Muse was faster on each of the eight matched sources. This measures note generation, not additional shiurim per five-hour allowance.

## Paired results

| Shiur                                                           | Topic                                              | Audio minutes | Gemini notes seconds | Muse notes seconds | Gemini/Muse time |
| --------------------------------------------------------------- | -------------------------------------------------- | ------------: | -------------------: | -----------------: | ---------------: |
| [1117682](https://www.yutorah.org/lectures/lecture.cfm/1117682) | Stripes on a Talis                                 |           7.8 |                 61.4 |               15.0 |            4.08× |
| [1151241](https://www.yutorah.org/lectures/lecture.cfm/1151241) | The Beracha on Craisins (Cranberries)              |           8.4 |                 57.4 |               15.4 |            3.74× |
| [1122687](https://www.yutorah.org/lectures/lecture.cfm/1122687) | Ta'us Akum                                         |           9.4 |                 94.9 |               20.6 |            4.61× |
| [1056185](https://www.yutorah.org/lectures/lecture.cfm/1056185) | Making Turkish Coffee on Shabbos                   |           9.9 |                 61.5 |               19.0 |            3.24× |
| [1183432](https://www.yutorah.org/lectures/lecture.cfm/1183432) | Tevilas Keilim of a Kattan                         |          17.3 |                 77.0 |               25.8 |            2.99× |
| [1180975](https://www.yutorah.org/lectures/lecture.cfm/1180975) | Giving a Child Two Names                           |          20.5 |                 96.5 |               24.3 |            3.97× |
| [1181377](https://www.yutorah.org/lectures/lecture.cfm/1181377) | Eating Meat on Yom Tov                             |          22.5 |                 42.4 |               26.1 |            1.63× |
| [1181042](https://www.yutorah.org/lectures/lecture.cfm/1181042) | Saying a Beracha (She'hechiyanu) When Making Aliya |          25.1 |                 45.1 |               31.3 |            1.44× |

| Metric                    | Gemini 3.8 Flash Medium | Muse Contributor Free |
| ------------------------- | ----------------------: | --------------------: |
| Completed                 |                     8/8 |                   8/8 |
| Structural validation     |                     8/8 |                   8/8 |
| Repair calls              |                       0 |                     0 |
| Median end-to-end seconds |                    61.5 |                  22.5 |
| Mean end-to-end seconds   |                    67.0 |                  22.2 |
| Median prompt seconds     |                    52.2 |                  16.9 |
| Eight-job total seconds   |                   536.3 |                 177.5 |

## Method and runtime

Each final provider run received the same complete saved transcript and the unchanged full notes skill through the existing `notes-2` generator, with the same language branch, normalization, structural checks and one permitted repair. There was no audio download, audio transcription or cleanup-model call. End-to-end time includes ACP setup, generation, validation and native session cleanup; prompt time excludes setup and cleanup. Each source has one final measured run per provider. The runs were sequential within each provider and taken at different times, without randomized ordering or repeated latency estimates.

The source snapshot and contracts are pinned by SHA-256 in [manifest.json](manifest.json). Both providers' result hashes match those snapshots. Historical Gemini notes are references, not the paired baselines. Eight earlier Muse pilot runs and compatibility probes are excluded from this final comparison; the pilot artifacts are retained separately.

OpenCode Console login succeeded in the normal OpenCode 2.0.24 installation. Testing then identified an independent ACP configuration problem: v2 ignored the runtime's configuration. The adapter now pins the official **OpenCode 1.18.33** binary at a separate path, leaving the normal installation in place. See the [official release](https://github.com/anomalyco/opencode/releases/tag/v1.18.33) and the [upstream ACP regression](https://github.com/anomalyco/opencode/issues/52259). The Linux x64 archive SHA-256 used here is `e546123213ae47909a4268692aa4b94950d011afe9cac9938753a2194f1c16d5`.

The working route uses the native **plan** agent, with the entire notes skill and transcript included in the user request. Disabling native tool definitions or overriding the system prompt caused Zen free-tier rejection; the final configuration retains the native definitions and requires permission, while the ACP client rejects every tool call. Both generation and helper models are explicitly pinned to `opencode/muse-spark-1.3-contributor-free`, and the adapter confirms the selected model before inference. No paid model or Gemini fallback is configured. Native session deletion is acknowledged before scratch removal; retained pilot/probe sessions were subsequently recovered and deleted using only their owned ID ledgers.

The stable runtime's anonymous native free lane worked: **no Zen API key was required for these successful requests**. The Console account login remains saved separately. No billing setup, top-up or auto-reload was enabled by this work. Keep Zen auto-reload disabled if billing is configured. OpenCode currently lists this model at zero token price for a limited time; Contributor prompts and completions can train Meta models. See [Zen pricing and privacy](https://docs.opencode.ai/docs/zen/).

## Two concurrent jobs

Two full notes jobs (1117682 and 1183432) were launched together using the same saved sources and skill. Both passed structural checks without a repair or provider error. They finished in **22.4 seconds total**, individually **13.9** and **22.4 seconds**. See [concurrency-check.json](concurrency-check.json) (the retired outline-generation executable has been removed). This establishes that two simultaneous sessions worked in this short test, not sustained free-tier capacity.

## Source-grounding review

All eight final Muse/Gemini pairs were manually compared against their full saved transcripts for developed arguments, source-backed claims, qualifications, Hebrew/Aramaic terms, citations and lecture order. The review does not independently verify the audio or halachic accuracy of the transcript. Findings are recorded per shiur in [quality-review.json](quality-review.json).

Muse retains the central debates and practical conclusions and is generally more detailed. It also retains several qualifications Gemini drops, including the anonymous editor's authorship in the aliya shiur and the speaker's objections to two supporting arguments. It is a viable free notes candidate, with specific imperfections:

- In the craisins shiur, it omits the speaker's statement that he had not consulted Rav Schachter or Rav Sobolofsky.
- It sometimes rearranges related material, such as putting later illness-name citations into an earlier discussion.
- In the meat-on-Yom-Tov shiur, the closing summary groups differing views under wine as the primary joy, while the Yam Shel Shlomo discussion explicitly keeps meat primary. Its main section preserves the distinction.
- In that shiur, a parenthetical addition is grouped with Rambam's quoted wording without the speaker's explicit attribution caveat.
- Both providers lose some tentative attribution language in the two-names shiur. Gemini also guesses unstated amudim in several citations; Muse generally preserves the supplied precision, although it drops one supplied amud in the aliya shiur.

There is no claim of perfect notes or a numerical quality score. Automated validation checks structure and basic language preservation; they do not detect every omission, merged opinion or attribution error.

## Pipeline behavior and verification

The new notes worker has its own leader and two-session pool, independent of the five Gemini transcription sessions. Notes can continue when Google waits for its five-hour reset. Free-model throttling has its own bounded backoff; it does not trigger a paid fallback. Pending notes with an older provider/runtime are repinned without regenerating completed notes or altering live leases. Empty scans no longer cause repeated wakeups. Pausing stops both providers.

Validation passed on Node 24.20.0: **149 worker tests, zero failures or skips**, worker build, full TypeScript check, changed-file lint, shell syntax and diff whitespace. Tests cover provider/model rejection, denied tools, session cleanup/recovery, quota scheduling, restart during Google's saved wait, provider isolation, queue migration and completed-note preservation. Live native generation and the concurrent test also succeeded.

Muse Free is now the main pipeline's default notes provider. The production binary,
build and configuration are installed, and the service user's live free-model
check passed. **Queue activation remains gated by the production migration:**
the existing Neon database returns HTTP 402 for an exceeded quota and cannot
accept the migration connection. No production queue or schema changes were
applied. See the [rollout record and completion command](../../docs/transcription-muse-rollout.md)
and [operator guide](../../docs/transcription-operator.md#reducing-usage).

## Limits and artifacts

The corpus consists of eight Rabbi Aryeh Lebowitz lectures from 7.8 to 25.1 minutes. It does not establish behavior for other speakers, accents or hour-long lectures. No sustained Muse limit or extra shiur count per Google allowance was measured. Moving notes to this provider removes those generation requests from Google's allowance, but the size of the resulting throughput improvement must be measured on the running pipeline.

[Summary](summary.json), [Gemini results](gemini-results.json), [Muse results](opencode-results.json), [quality review](quality-review.json), [concurrency test](concurrency-check.json), [cleanup check](cleanup-check.json) and [source manifest](manifest.json). Each final source includes raw generation, normalized notes and a per-run result. Artifacts contain no credentials or audio.

To resume the corpus without repeating completed runs, use Node 22.13+ and the pinned `opencode-notes` executable on PATH:

```sh
npm run notes:benchmark -- --provider opencode --reuse-corpus
npx tsx benchmarks/opencode-notes-20261008/concurrency-check.ts
```

The first command checks source/profile fingerprints and skips completed results. The second deliberately reruns the two-job live concurrency check.
