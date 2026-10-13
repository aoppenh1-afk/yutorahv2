# Larger changes for scaling free note generation

Research date: October 13, 2026. Constraints: keep provider spending at zero,
preserve detailed source-grounded notes, and improve on the owner-reported
300 notes per hour. This extends the earlier runtime and batching research.

The strongest larger opportunity is to reduce how much full-note writing the
most capable model performs. A queue can improve utilization, but it cannot supply
unlimited free inference capacity. A material step beyond the current pace could
come from a faster approved model for routine lectures, drafting plus targeted
corrections, reuse of identical sources, or a different note representation that
code expands. Each changes a different part of the workload and needs a different
evaluation.

## What providers and large processing systems actually do

### Batch independent requests inside the inference engine

Ray's documented LLM processing system accepts batches of dataset rows, separates
preprocessing from inference, prefetches work, and scales inference replicas.
BatchLLM research groups separate requests with shared prefixes and schedules
prefill and decoding to use GPU resources efficiently. Individual prompts and
outputs remain separate even when their computation shares a GPU batch.
This is a model-serving operation. A prompt containing twenty lectures still asks
one sequence to generate the notes; it does not expose the provider's GPU scheduler.
[Ray LLM processing](https://docs.ray.io/en/latest/data/working-with-llms.html),
[BatchLLM paper](https://arxiv.org/abs/2412.03594).

For us, the usable principle is one persistent transport with many independent
sessions and bounded work in flight. Keep a ready queue and refill slots as they
finish. Balance input/output workload and actual memory use rather than assuming
one agent process equals one unit of useful capacity. Installing Ray on this VM
is not necessary to apply those principles, and a free API client cannot configure
the provider's GPU scheduler.

### Reuse processed input and accelerate token generation

vLLM caches computation for shared input prefixes. Its documentation explicitly
limits that benefit to prefill; generating long answers still takes decoding work.
Its speculative decoding uses proposals and target-model verification to accelerate
token production inside the serving engine. These are useful tools for a provider
or a self-hosted model, not controls exposed by our current Muse API adapter.
[Prefix-caching limits](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/),
[Speculative decoding](https://docs.vllm.ai/en/latest/features/speculative_decoding/).

OpenAI's latency guidance likewise identifies output generation as a major cost
in time. Its Predicted Outputs feature accelerates responses when supplied text
already matches much of the eventual output. That feature belongs to supported
OpenAI models; this research found no corresponding control for our Muse Free
route. The transferable idea is to avoid generating text we already possess.
[Latency guidance](https://developers.openai.com/api/docs/guides/latency-optimization),
[Predicted Outputs](https://developers.openai.com/api/docs/guides/predicted-outputs).

### Route work according to difficulty and specialize models

Anthropic documents workflows that route distinct task categories to suitable
models. RouteLLM research evaluates learned routing between stronger and weaker
models. These sources establish routing as an evaluated design pattern, not a
quality or speed guarantee for Torah notes.
[Anthropic workflows](https://www.anthropic.com/engineering/building-effective-agents),
[RouteLLM](https://arxiv.org/abs/2406.18665).

### Use separate bulk and interactive processing

Claude's batch interface accepts independent requests for asynchronous processing.
It offers discounted pricing and a batch completion window, not free unlimited
capacity or a promise of lower individual latency. This is evidence of how bulk
work is packaged, rather than a recommendation to leave our free-only constraint.
[Claude batch processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing).

## Options worth testing in our pipeline

### 1. A routine route and a difficult-lecture route

Try a faster free model or a lower-effort Muse profile on a held-out corpus.
Reserve high-thinking Muse generation for cases where the faster route fails
source-quality evaluation. Lecture length, transcript readability, language mix,
quotation density, and disagreement structure can inform a router, but they are
not reliable quality certificates. A short lecture can contain a difficult argument.

Compare the outputs against the full sources. Do not accept a model's own confidence
as sufficient evidence. A conservative first version can always verify fast-route
drafts against their complete transcript, then reduce unnecessary verification only
after human-reviewed results establish an acceptable error rate. Measure both
missed errors and the fraction of drafts that need full regeneration.

The earlier two-source experiment found a favorable medium-effort result on one
longer lecture, but no timing gain on the short lecture. It does not establish
which kinds of shiurim can use a faster route. Multiple free routes also do not
automatically mean independent quotas. Keep an explicit allowlist of verified
zero-price model IDs and no paid fallback.

### 2. Let Muse correct a draft instead of writing every word

Prepare a complete draft with a small local model or another approved free route.
Give Muse the full transcript and draft. Ask for a short, structured list of
missing arguments, attribution errors, citation problems, and exact replacements.
Code applies replacements, validates the resulting full outline, and saves it.

The possible advantage is a short capable-model response instead of thousands
of tokens of regenerated prose. This is application-level draft review, not
lossless speculative decoding. The reviewer can miss an omission, the draft can
be poor, and patches can conflict. The combined draft-and-review pipeline could
be slower than direct generation. A full-regeneration escape path is necessary.

Evaluate large-model output tokens per accepted note, overall accepted notes per
hour, draft-stage capacity, and missed source details. If the local drafter is
slower than the cloud generator, it becomes the pipeline's bottleneck even when
the Muse correction is short. A faster first token is not the success metric.

### 3. Generate a note plan and let code assemble the text

Represent the transcript as immutable, source-addressable passages. The model
returns a heading tree, claim relationships, selected passage IDs, and genuinely
new paraphrases. Code expands references into exact quotations or source text,
applies the required Markdown nesting, and produces the final note. The displayed
artifact remains a full note; internal references never become reader-facing IDs.

There are two versions with different promises:

- Reuse verbatim material while preserving our existing note wording. This is a
  conservative optimization with limited room in the measured corpus.
- Produce more extractive notes by arranging source passages into an outline.
  This could reduce model output more, but changes the writing style and may retain
  transcript filler. Coverage, readability, and cross-passage reasoning need review.

An offline experiment encoded the existing eight Muse notes as literal text mixed
with references to exact source spans of at least 64 Unicode characters. Expansion
reproduced every note exactly. Encoded output fell from 88,169 to 82,185 UTF-8 bytes,
a 6.8% reduction overall. The best individual note fell by 14.8%; one grew slightly
because it had no suitable long copied passages.

This experiment knows the completed note before encoding it. It does not test
whether the model can select correct references, the extra input needed to label
passages, actual token savings, or speed. It argues against expecting an immediate
several-fold gain merely from copying long quotes in our current prose style.
Source-addressable assembly is a more substantial research direction if we are
willing to compare alternative representations without losing developed content.

[Reproducible encoder](../benchmarks/notes-scale-20261013/span-reuse-probe.py),
[measured results](../benchmarks/notes-scale-20261013/span-reuse-probe.json).

### 4. Parallelize exceptionally long lectures by chapter

Use official chapter boundaries where available, or first establish a source-backed
topic map. Generate sections concurrently and combine them in lecture order. Each
section needs sufficient surrounding context to retain later qualifications,
cross-references, and the final resolution of earlier questions. Where resources
permit, provide the same complete transcript as a cacheable prefix and assign each
request a different target range.

This reduces the time to one completed long note if independent section requests
can run simultaneously. It may increase total requests, reasoning, repeated input,
and review work. It can also take slots away from other lectures. Consequently it
may help a requested 80-minute shiur while reducing library-wide notes per hour.
Benchmark both metrics, and apply it to outliers rather than assuming every lecture
needs sectioning. Avoid naïve stitching that loses a dispute crossing a boundary.

### 5. Reuse identical content and upstream study material

Our current per-ID lookup prevents regenerating a published shiur. A separate
canonical text hash could identify identical transcripts under different IDs or
with different cue timestamps. Reuse a verified note only when the complete text,
language, and generation contract match. Preserve each ID's provenance and raw-source
hash. Similar topics, titles, or nearly identical text are insufficient; a changed
negation or qualification matters.

The size of this opportunity is the duplicate rate in the actual corpus, which is
unmeasured. If duplicates are rare, hashing saves very little generation. If official
text revisions become a future requirement, source-addressable sections could also
support recomputing affected sections, with a whole-note consistency check.

The official API already provides summaries and chapter titles/summaries. A live
read during this research retrieved a 91-word summary for shiur 1190357 alongside
2,552 transcript word entries and three chapters. A summaries request for two IDs
returned about 1.2 kB. This can supply an immediate, explicitly labeled official
summary or a drafting scaffold. It is far shorter than our detailed Lectern notes
and is not evidence that the full note can be skipped without changing the product.

[Official full record](https://api.yutorah.org/transcriptions/shiur/1190357),
[official summaries API](https://api.yutorah.org/transcriptions/summaries?shiurIds=1190357&shiurIds=1190833),
[earlier verified endpoint and batching investigation](official-yutorah-api-research.md).

The official full-record endpoint supports multi-ID retrieval, but its repeated
word timing/probability arrays make responses substantially larger than VTT. Batch
source ingestion by response-size and memory budgets, not just ID count. A faster
HTTP ingestion path helps only when the generation queue is starving.

### 6. Train a narrow note-producing model from reviewed pairs

Over time, collect matched full transcripts and reviewed notes, including difficult
cases and known errors. Use a fixed held-out set split by lecture series or speaker
to avoid misleading results from near-duplicate examples. A small model trained
specifically for the output style could need less prompting and less inference work
than a general coding agent.

MLX LM supports quantized models, local generation, and low-rank fine-tuning on
Apple silicon. The local machine inspected during this research is an Apple M3
with 8 GiB RAM. That supports considering a small experiment, not assuming that
large-model, long-context training or a many-worker local service will fit or be
fast. No model was downloaded or trained. Existing hardware would avoid new API
fees, but suitability, Hebrew quality, and throughput remain unmeasured.
[MLX LM](https://github.com/ml-explore/mlx-lm).

Do not use every generated note as truth. The prior source review already found
qualification and attribution errors. Training should use curated pairs rather
than teach those mistakes to a smaller model. This is a longer-term investment,
not the first change to ship for today's backlog.

### 7. Route across genuinely independent, approved free capacity

If another zero-price provider/model passes the same quality evaluation, distribute
work according to its observed latency and published allowance. Retain per-provider
limits and cooldowns. A second machine helps a client-side memory limit; it does
not expand a shared upstream allowance by itself. Do not assume different API keys
or model names create independent capacity. This research made no new-account,
alternative-provider, or quota-expansion changes.

### 8. Reduce waiting for the notes people actually request

Use an interactive priority lane alongside the bulk queue. Serve official source
material immediately and generate the full note for requested or likely-to-be-used
lectures first. Bulk processing continues in remaining capacity. This can make a
specific note available sooner without increasing total inference throughput.
If complete library coverage is the requirement, prioritization cannot remove
the remaining work; it changes completion order.

## Recommended experimental order

First establish effective generation concurrency and whether time is dominated by
model output, waiting for sources, memory admission, or provider allowance. Then:

1. Measure exact-source duplicate rate and add inexpensive reuse where justified.
2. Compare a faster free route and Muse effort profiles on reviewed full lectures.
3. Prototype draft-plus-corrections and compare it with direct full generation.
4. Test chapter parallelization on long requested lectures, measuring total throughput
   as well as individual latency.
5. Evaluate source-addressable assembly only with explicit readability and coverage
   criteria. Treat the 6.8% conservative copying result as a measured limit of that
   encoding, not a promised latency improvement.
6. Consider specialization after enough reviewed pairs and suitable existing compute
   are available.

Use accepted, complete, source-grounded notes per hour and per available model
budget as the main measures. Total request count, file count, bytes, first-token
time, and raw completion counts can each improve while actual usefulness declines.
For a large gain, reduce expensive work per accepted note or increase legitimate
usable capacity. Merely changing where generated text is written does neither.

This is research. The new span experiment and public metadata reads do not change
the production pipeline. The live VM's bottleneck and the proposed models' quality
remain unresolved. The earlier measured effort and process-reuse results are in
[notes-speed-research.md](notes-speed-research.md).
