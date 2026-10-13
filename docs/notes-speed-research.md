# Speeding up the notes pipeline while staying free

Research and experiments completed October 13, 2026. The owner reports about
300 completed notes per hour and requires free-only operation.

My first recommendation is to measure how many generation sessions are actually
busy on the VM, then remove runtime and scheduling overhead. I would build a
persistent OpenCode service with fresh, explicitly named sessions, maintain a
queue of complete transcripts ready for generation, and give each upstream its
own cooldown. A controlled medium-thinking trial is also worthwhile. The small
experiments below establish feasibility and one promising result, not a guaranteed
production speedup.

## What 300 notes per hour tells us

300 per hour is one completion every 12 seconds across the whole system. If ten
generation sessions are continuously occupied, it corresponds to about two
minutes per note. If notes take 30 seconds, that rate corresponds to about 2.5
continuously occupied generation sessions. Missing transcripts, database work,
quota waits, and memory admission complicate that comparison.

The configured concurrency ceiling is ten. It is not a measurement of ten busy
sessions. The worker refuses to admit another job when available host memory falls
below 3 GiB. It also applies a two-second gap to every candidate job, including
jobs that discover a missing transcript.

At the reported pace, 10,000 notes take about 33 hours and 100,000 take about
14 days of uninterrupted work. The catalog's 434,662 records are candidate
lectures, not 434,662 available transcripts or required notes.

## Experiments run during this research

All AI calls used the pinned OpenCode 1.18.33 binary and the exact
`opencode/muse-spark-1.3-contributor-free` model. The binary's SHA-256 matched the
official release asset digest. Both the main and helper model remained pinned to
the free model; tools stayed denied. No notes were published, production settings
were untouched, and the TiDB spending cap was unchanged. The generated notes are
research artifacts. All six generations passed the existing structural checks
without repair, and owned session cleanup completed.

### Medium versus high thinking

Each run received the same saved transcript and full current Lectern notes
contract. Effort was explicitly selected and confirmed before each prompt.
The short lecture ran medium then high; the longer lecture ran high then medium.

| Lecture | Medium seconds | High seconds | Medium words | High words |
| --- | ---: | ---: | ---: | ---: |
| Stripes on a Talis, 7.8 minutes | 31.64 | 31.62 | 1,016 | 887 |
| Beracha when making aliya, 25.1 minutes | 31.66 | 50.61 | 2,182 | 2,515 |

Medium made almost no timing difference on the short source. On the longer one,
it used 37.4% less elapsed time and returned 13.2% fewer words. Across both sources,
medium took 63.31 seconds versus high's 82.23 seconds. One run per case is too
little to establish a repeatable effect or a production throughput multiplier.

Source checks of the two effort variants retained the short shiur's three reasons
for stripes and the discussions of each color. Targeted checks of the longer
shiur retained the anonymous editor's attribution, the competing views, the
speaker's objections, the caveat against treating the building-related suggestion
as an established practical ruling, and the final new-fruit/new-talis approach.
Medium preserved the initial qualification about the Rav Kook account more
explicitly. It also changed the supplied milah citation from סימן ר״ס to
סימן רס״ה. That change needs source-fidelity review rather than being accepted
because it looks plausible. These are source checks, not an exhaustive quality
audit or independent verification of the underlying religious claims.

Meta documents that higher reasoning effort increases latency and that reasoning
tokens count against the response budget. That supports an effort experiment;
it does not establish that these notes require less thinking.
[Meta reasoning documentation](https://dev.meta.ai/docs/reasoning).

### Reusing one process with fresh sessions

The existing adapter successfully generated two independent high-thinking notes
in one process and one stable owned workspace, using a fresh session for each.
The second session's creation and configuration took just 53 milliseconds.

However, the two-note run took 90.71 seconds including shared startup and cleanup,
versus 82.23 seconds for the earlier separate-process high runs. The shared process
was 10.3% slower overall in this pilot. Its longer lecture's prompt took 66.17
seconds versus 45.44 seconds in the cold run. Request-time variation outweighed
the reduced lifecycle overhead. This establishes that fresh sessions in a shared
process work, not that they are faster overall or use less RAM on the VM.

A separate local check confirmed the current process cleanup waits approximately
two seconds even when the direct child has already exited. That grace period also
protects against surviving child processes. Do not simply remove it to chase
speed. Avoid paying it after every successful note by keeping the service alive.

### Public transcript availability and length

Twenty public catalog candidates were sampled without AI calls, with sequential
official VTT requests spaced one second apart. Page 1 yielded six transcripts,
two missing sources, and two network errors. Page 21 yielded ten transcripts out
of ten attempts. This small positional sample is not representative of the live
VM queue, and network errors were not counted as missing transcripts.

The page-21 available sources averaged 6,010 words and 35.7 minutes. Two were about
72 and 74 minutes long. The old eight-source benchmark averaged 2,968 transcript
words and covered only 7.8–25.1-minute lectures. Using its 22-second typical note
time to predict the current library's throughput would be misleading. Most
successful VTT fetches in the new sample took roughly 0.1–0.5 seconds; there were
also slow requests and failures.

The public catalog response has no transcript-availability field in the inspected
page. Its duration field was zero even for candidates with valid transcripts.
Do not skip zero-duration lectures or assume the catalog can supply reliable
duration-based routing without inspecting the transcript.

### Queue scheduling model

The actual `runNotesPool` was exercised with virtual time, synthetic 60-second
generation jobs, and 250-millisecond missing-source checks. It ran without models,
network, databases, retries, or memory limits.

With 600 queued candidates, 25% transcript availability, and the current 30-minute
worker deadline, it produced exactly 300 notes per simulated hour. The candidates
finished after about 21 minutes, then the worker waited until its deadline. A larger
candidate inventory reached about 436 per hour in the bounded simulation; supplying
only transcript-ready jobs reached about 594 per hour. These are explanations of
possible scheduling limits, not measurements of the VM or predictions of free-tier
capacity. The live source sample does not establish a 25% availability rate.

Artifacts and reproducible experiment scripts are in
[the experiment directory](../benchmarks/notes-speed-20261013/).

## Changes ranked by what I would investigate first

### 1. Ensure the configured generation capacity is actually usable

Measure active generation sessions separately from active jobs. Jobs fetching a
transcript, waiting on TiDB, or closing a process are not generating a note. Check
memory-admission events, available memory, runtime RSS, and provider cooldowns.
If only two or three sessions are usually generating despite the ten-session
ceiling, recovering unused capacity can matter much more than saving a few seconds
on a full ten-session pool. A scaling factor such as ten divided by three is only
an ideal limit; provider throughput and source size can prevent it.

Use a persistent service to reduce duplicated process state before raising the
concurrency ceiling. Keep admission tied to measured memory consumption. A lower
reserve or a larger ceiling helps only if the machine and free provider have
headroom. No amount of additional concurrency makes exhausted quota disappear.

### 2. Use a persistent runtime, named sessions, and stable prompt prefixes

Today every request initializes an empty Git workspace and a native process.
Cleanup then launches another OpenCode process to delete the session. OpenCode
already offers a persistent HTTP server with fresh-session creation, asynchronous
prompts, per-session status, and session deletion.
[Official server documentation](https://opencode.ai/docs/server/).

The pinned upstream runtime also starts an AI title-generation task for a new
default-named session, using the initial request as context. Our pipeline pins the
helper to Muse Free, so this is additional free-model work. A predefined session
title avoids that helper path. It does not change the source-derived heading inside
the note. This reduction has not been measured in a live named-session experiment.
[Pinned title-generation implementation](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/session/prompt.ts).

The current random workspace path appears in native system context before the
shared notes contract. Prefix caches stop matching at the first differing token.
A stable isolated workspace per service or lane, combined with a fresh conversation
for each note, should make more of the instructions reusable if the gateway
preserves caching. Confirm that with cached-token usage, rather than assuming it.
[Pinned native system context](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/session/system.ts),
[Meta prefix-caching documentation](https://dev.meta.ai/docs/prompt-caching?project_id=3275418322642662&team_id=1414417047270365).

The local shared-process pilot shows feasibility but no overall latency win. The
stronger reasons to try a persistent service on the VM are lower duplicated memory,
avoiding helper title requests, and removing per-note lifecycle work. Keep model
confirmation, denied tools, owned-session cleanup, and per-note publication checks.

### 3. Keep generation supplied with complete, ready transcripts

The supervisor fetches twenty catalog pages, at most 600 new IDs, then runs the
worker for thirty minutes before another discovery phase. Existing inventory can
bridge that gap. If it runs out, faster generation does not automatically trigger
more discovery, and missing transcripts receive the same two-second candidate
pacing as real note jobs.

A bounded transcript-fetch stage should resolve availability before consuming a
generation lane. Keep a small durable buffer of full sources, then pace model
starts separately from HTTP reads. Delete sources after durable note publication,
as the current pipeline does. Refill based on ready-buffer size rather than the
clock alone. This also avoids pre-generation TiDB reads for candidates confirmed
to have no transcript.

Increasing the catalog batch from twenty to a larger bounded page count is a
smaller first experiment if the ready queue is empty frequently. Preserve existing
HTTP pacing. Running the current catalog CLI and worker together is not a safe
configuration-only shortcut; they share a mutation lock. Concurrent discovery
needs one coordinator or a deliberate queue-interface change.

### 4. Separate cooldowns for YUTorah, Muse, and TiDB

Currently the same pool-wide admission delay can be triggered by a transcript HTTP
429/503, a database error carrying retry metadata, or Muse quota exhaustion. Retry
delay starts at at least two minutes on a first claimed job and grows with attempts.
This can stop unrelated stages even when they have useful work to do.

Respect Retry-After for the affected service, retain bounded backoff and jitter,
and record the cooldown's owner. During a YUTorah outage, generate from the ready
source buffer. During a TiDB outage, preserve completed local notes and pause only
publication while allowing a bounded local backlog. During a Muse outage, continue
source preparation within disk limits. This requires stage separation; it is not
permission to ignore provider waits or keep producing an unlimited backlog.

### 5. Test medium thinking on a larger, reviewed corpus

The 37% reduction on the longer source is the strongest favorable live timing
result from this research. The unchanged short-source time and the differing word
counts prevent a blanket conclusion. Repeat randomized pairs across multiple
speakers and longer lectures. Check developed arguments, opposing opinions,
exceptions, quotations, attribution, and citations against each source. Use a
separate experiment profile; keep high as the production default until the review
supports a change. A lower effort is still the same free model.

### 6. Optimize the prompt after caching is measured

The full notes contract is 24,533 UTF-8 bytes, and the measured wrapper plus contract
is 25,014 bytes per request. There are English-class examples, optional-visual
instructions, and revision guidance that initial shiur generation does not use.
A reviewed contract for this exact task could omit irrelevant material while
retaining the Hebrew terms, source boundary, lecture order, details, and Markdown
rules. Measure the effect after caching; fewer input bytes do not establish a
latency gain. Avoid making notes shorter merely to improve the throughput metric.

### 7. Make completed notes available where people need them first

Prioritize requested lectures, active learning series, and selected teachers over
an undifferentiated full-library import. Short ready lectures can fill gaps, but
use aging or reserved capacity so long lectures still finish. This changes which
notes become available sooner, not the total computation needed for the library.

## Other free options and their limits

OpenCode currently lists other zero-price models, including MiMo-V2.6-Flash Free
and Ling 3.1 Flash Free. They are legitimate candidates for a separate source-grounded
benchmark, not established replacements for Muse. Hebrew retention, complete
outlines, free-route acceptance, and sustained allowance must be tested. This
research did not call those models or alter the current Muse-only production rule.
[OpenCode model catalog](https://opencode.ai/v2/docs/console/models/).

Another machine only helps if host capacity is the bottleneck. It does not increase
a shared provider allowance by itself. Local inference is worth considering only
with already-available suitable hardware and an adequate Hebrew-capable model;
CPU inference and weaker notes are not established improvements here. Paid batch
APIs and paid infrastructure are outside the owner's requested scope.

## The next VM measurement

Collect a fifteen-minute window without restarting the worker or changing its
settings. Report completed notes, average and peak simultaneous generation
sessions, available RAM and runtime RSS, ready/deferred/running/missing job counts,
time without ready sources, source sizes, per-stage timings, repairs, and cooldown
events grouped by service. Current logs do not timestamp every stage, so identifying
generation versus fetching may need temporary bounded instrumentation.

Then choose the first change based on the finding: recover concurrency when memory
is limiting it; refill and prefetch when inventory is empty; isolate cooldowns when
one upstream stops unrelated work; review medium effort when long model responses
dominate. Compare the same representative source mix before and after, counting
validated full notes per hour and holding the free-only policy constant.

The research did not access the live VM. The 300/hour figure is owner-reported.
Provider latency and memory findings from the Mac are not VM measurements.
Sixteen existing pool checks passed, the scheduling model ran, all six live note
generations passed structural validation without repairs, and experiment lint
passed. Production code and settings were not changed.
