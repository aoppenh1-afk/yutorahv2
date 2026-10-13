# Should one prompt generate multiple notes?

Research date: October 13, 2026.

One prompt can contain several complete transcripts and request a separate note
for each. I would keep one transcript per request as the production default and
test batches of two and four before considering ten or twenty. There is a
plausible efficiency gain, but no measured batching gain for this pipeline yet.

## What the project currently does

The notes-only pipeline includes every VTT cue. `notesPrompt` supplies the full
Lectern notes contract and one complete source. `generateNotes` normalizes and
validates one Markdown outline and permits one repair request. The validator
requires exactly one top-level title, so concatenating multiple notes into the
current response would fail validation.

The managed VM supervisor selects ten concurrent jobs, starts jobs two seconds
apart, and requires at least 3 GiB available host memory before admitting another
job. Every job uses a separate OpenCode process, workspace, and session. The
runtime pins OpenCode 1.18.33, Muse Spark 1.3 Contributor Free, plan mode, and high
thinking. Each note has its own durable backup and publication checkpoint.

These are source and documented deployment findings. I did not inspect the live
VM or measure its current concurrency, memory pressure, or provider throttling.

Relevant files:

- [Generator and validator](../packages/transcription/src/notes.ts)
- [Per-note publication and recovery](../packages/notes-only/src/pipeline.ts)
- [OpenCode lifecycle and configuration](../packages/opencode-acp/src/runtime.ts)
- [Supervisor configuration](../deploy/notes-only/supervise.sh)
- [Concurrent queue](../deploy/notes-only/pool.mjs)
- [VM deployment record](notes-only-vm.md)

## Existing measurements

The October 8 benchmark used eight saved transcripts by one speaker, covering
lectures of 7.8 to 25.1 minutes. Muse completed all eight without structural
repairs. Mean generation time including setup and cleanup was 22.19 seconds.
Recalculating the individual request diagnostics gives 16.55 seconds inside the
prompt request and 5.64 seconds outside it, on average. The eight sequential
jobs took 177.54 seconds, including 45.12 seconds outside prompt execution.

Two independent requests launched concurrently finished in 22.38 seconds total.
This is evidence that concurrency worked in that short test, not a measurement
of sustained ten-worker throughput. The later VM record verifies six overlapping
jobs, but does not provide a controlled throughput comparison against batching.

The saved corpus contains 23,742 transcript words and 12,736 note words. Its
average note is 1,592 words. At the same average length, ten notes would produce
15,920 words and twenty would produce 31,840 words. These are extrapolated sizes,
not generated batch results or exact model token counts.

Each measured prompt repeats 25,014 UTF-8 bytes of contract and wrapper text.
Sending that once would reduce application prompt bytes by approximately 52%
for ten average transcripts or 55% for twenty, before adding batch instructions.
That is a real potential benefit. Byte savings are not measured token, latency,
quota, or billing savings, and existing provider caching may reduce the benefit.

The October 8 benchmark predates the current runtime identity `notes-3-high`.
Use fresh high-thinking single-note runs as the baseline for an experiment.

Sources: [benchmark method](../benchmarks/opencode-notes-20261008/README.md),
[individual request timings](../benchmarks/opencode-notes-20261008/opencode-results.json),
[source manifest](../benchmarks/opencode-notes-20261008/manifest.json), and
[concurrent check](../benchmarks/opencode-notes-20261008/concurrency-check.json).

## Why fewer requests might not finish sooner

An ordinary model response generates its output sequentially. Putting twenty
tasks into the prompt does not give the client twenty parallel output streams.
The model still has to write all twenty outlines. Research on LLM serving
distinguishes parallel prompt processing from sequential output decoding and
server batching of separate requests. Combining documents into one prompt is a
different operation from server batching.

Batching can save repeated setup, instructions, and request overhead. It may beat
serial single-note jobs. Against the existing concurrent pool, its longer response
can outweigh those savings. The direction and size of the change require a
measurement under the same worker, memory, and provider limits.

If the free provider limits requests per minute, smaller batches could help. If
it limits tokens or total compute, requesting fewer calls does not eliminate the
transcript and output work. The public OpenCode model page does not establish an
exact free-lane allowance for this workload. It currently lists the selected model
as free, so batching does not establish a dollar saving on the current route.

Sources: [Sarathi-Serve paper](https://arxiv.org/abs/2403.02310) and
[OpenCode model and pricing documentation](https://opencode.ai/v2/docs/console/models/).

## The output limit matters more than fitting the input

Meta documents a 1,048,576-token context window for Muse Spark. OpenCode's model
metadata lists a 131,072-token output capacity, while noting that some capability
metadata follows Spark 1.2 pending public 1.3 specifications.

However, OpenCode 1.18.33 defines a default output maximum of 32,000 tokens and
caps request output at the smaller of that value and the model limit. Its request
preparation applies that maximum. An experimental environment override exists,
but this project's isolated runtime launch does not pass it. Thus the catalog's
larger output capacity does not establish that this pipeline can return twenty
complete notes in a single response.

Twenty average notes are already about 31,840 words before response framing.
Words and tokens differ, especially for Hebrew text, Markdown, and reasoning.
Ten short lectures may fit; ten long lectures may not. A batch must reserve output
and reasoning headroom and respect the ACP client's separate 1 MiB prompt limit.
The project's 4 MiB collected-text limit and 15-minute request timeout are additional
application limits, not the primary issue for the short saved corpus.

Sources:

- [Meta model documentation](https://dev.meta.ai/docs/models)
- [OpenCode model metadata](https://github.com/anomalyco/models.dev/blob/dev/providers/opencode/models/muse-spark-1.3-contributor-free.toml)
- [Pinned output maximum](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/provider/transform.ts)
- [Pinned request preparation](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/session/llm/request.ts)
- [Experimental override](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/effect/runtime-flags.ts)
- [Local ACP limits](../packages/antigravity-acp/src/client.ts)

## Quality and recovery

Multiple related Torah lectures introduce opportunities to mix sources,
attributions, qualifications, and practical conclusions across notes. A model may
also shorten later notes to fit its response budget. Long-context research found
position-sensitive retrieval failures in evaluated models; that is a reason to
test this risk, not evidence that Muse will fail on these transcripts.

The current structural validator cannot reliably detect those mistakes. The
existing manual review already found occasional attribution and qualification
errors in single-note outputs. Batch evaluation must check each note against its
own transcript, including notes placed in the middle and at the end of the input.

A batching implementation would need an unambiguous ID-to-note response format,
an exact expected-ID check, and per-note normalization, validation, repair, backup,
and publication. Current tools are denied, so model-directed file writing is not
an available shortcut. A truncated response should preserve any complete,
validated notes and retry only missing or invalid notes. The current client
rejects non-`end_turn` stops before returning collected output, so partial recovery
would need explicit work. Avoid one all-or-nothing database commit for a batch.

Sources: [Lost in the Middle](https://arxiv.org/abs/2307.03172) and
[existing source-grounding review](../benchmarks/opencode-notes-20261008/quality-review.json).

## Recommended experiment

Keep the production pipeline unchanged while testing the same corpus with batch
sizes one, two, and four, using the current free model and confirmed high thinking.
Include longer lectures and multiple speakers, randomize transcript order, and
repeat runs. Compare equal numbers of notes with the current pool at matched
concurrency and also under equal VM resource limits. Small batches may allow more
work per process when memory admission is the actual bottleneck.

Measure validated, source-grounded notes per minute, time to first published note,
total request usage where exposed, repairs, omissions, truncations, peak host
memory, and work repeated after interruption. Shorter notes alone are not a speed
improvement. Expand to ten only if small batches improve throughput without losing
detail, and choose batch sizes by input/output budget rather than transcript count.

A second worthwhile experiment is reusing an OpenCode process for successive
jobs while creating a fresh isolated session for each transcript. This targets
the measured process overhead while retaining per-note context separation. The
current client keeps mutable session and output state, so sharing it concurrently
would require redesign; process reuse is not a configuration-only change.

No new live generation benchmark was run during this research. This checkout has
OpenCode 2.0.27 and lacks the pinned `opencode-notes` binary required by the existing
benchmark adapter. Existing timings and offline corpus calculations support the
recommendation, but do not prove a batching speedup or slowdown.

Graph navigation used Verify tier on generation `2026-10-13T04:02:21Z`. Coverage
metadata matched the relevant indexed source files. The deployment directory is
excluded from the graph; its supervisor and pool were read directly.
