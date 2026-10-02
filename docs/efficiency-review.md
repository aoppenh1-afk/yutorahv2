# Efficiency review

Reviewed on October 2, 2026. This pass covered repository structure, frontend state and rendering, metadata and transcript search, storage adapters, worker scheduling, transcription, dependencies, and build configuration. Changes preserve the existing interface and ranking rules.

## Implemented

| Area | Change | Benefit |
| --- | --- | --- |
| Recommendations | Build membership sets and normalize interests once per ranking call. Remove the redundant deduplication set after `mergeShiurim`. | Avoid repeated history, saved-item, and topic scans for every candidate. |
| Browser rendering | Memoize result filtering, the loaded-item collection, and related recommendations. Bind keyboard handlers to the active recording and stable playback callback. | Audio time updates no longer repeat these calculations or reinstall the keyboard listener. |
| Upstream requests | Share concurrent cacheable requests; clear failed requests; keep fresh scan pages outside the response cache. | Fewer duplicate downloads. Archive scans cannot evict cached directories with immediately expired responses. |
| Search counts | Count candidates and refined matches in one aggregate query. | One database read and candidate traversal instead of two; both counts use the same query snapshot. |
| Dead code | Remove 49 generated UI modules outside the application's dependency closure. Retain the 11 used components and their dependencies. | 6,006 lines of unused source removed. |
| Dependencies | Remove eight unused direct dependencies and update the lockfile. | npm removed 72 installed packages. Versions of retained packages did not change. |

The removed direct dependencies are `@shadcn/react`, `cmdk`, `date-fns`, `embla-carousel-react`, `input-otp`, `react-day-picker`, `react-resizable-panels`, and `recharts`. The active Base UI controls, shadcn stylesheet, Markdown reader, database adapters, and deployment tooling remain.

Recommendation output matched the original implementation in 400 generated scenarios with fixed ranking time. A local fixture with 600 candidates, 200 saved items, 200 history entries, and 80 follows took a median of 16.61 ms before and 0.86 ms after, across 25 timed calls following five warm-up calls. This measures the ranking function, not page load speed. Recommendation scores, explanations, completion filtering, metadata merging, and teacher interleaving were compared.

## Further opportunities

These need separate validation before implementation:

1. **Separate playback state from the main app.** `app/torah-app.tsx` holds navigation, search, dialogs, personal library actions, and the audio hook in one large component. Memoization removes avoidable calculations, but time updates still render the parent. Put playback state in a dedicated provider and let the player subscribe to position changes independently. Verify keyboard shortcuts, queue advancement, Media Session handlers, and persistence across navigation.
2. **Load the transcript reader when needed.** The Cloudflare client build still has a main app chunk of about 526 KB minified, 164 KB gzipped. The reader statically imports Markdown rendering. Splitting that dependency is a candidate for reducing initial download and parse work. Measure both initial loading and first opening of a transcript, with an accessible loading state.
3. **Fetch one worker selection instead of every selection.** `scanSelections` repeatedly calls `SelectionStore.targets()` and finds one row, including inside the recording loop. That query also counts jobs for every target. A query for the current target could reduce database work. Keep the existing live checks of enabled state, teacher filter, and recording budget; do not replace them with stale cached state. Test concurrent operator edits against disposable PostgreSQL.

The worker's sequential durable writes, bounded concurrency, search completeness checks, and checkpoint recovery remain intact. Increasing concurrency or skipping intermediate writes requires evidence that cancellation, quotas, budgets, and crash recovery still work.

## Evidence and validation

The review used a fresh graph for this checkout, caller/callee traces, complexity queries, and coverage checks. Partial JSX and SQL ranges were inspected directly. Generated UI removals were also checked through a TypeScript AST walk of source references and the transitive component dependency closure. Graph coverage is best effort; this review does not establish that every remaining export is used.

- Lint, TypeScript checking, worker compilation, and formatting checks pass.
- Search tests pass, including SQLite-backed complete pagination and refinements.
- Learning/discovery tests pass, including a new ranking-preservation case.
- Six upstream caching/concurrency tests pass through `npm run test:api`.
- Transcription-control tests pass.
- Cloudflare and Vercel builds pass.
- Desktop preview renders live content; learning preferences open and close.
- All 20 player regression checks pass using `PLAYWRIGHT_CHANNEL=chrome npm run test:player`, including mobile viewports, closing during loading, details sheets, and portrait fallbacks.

The broader worker run has environment limitations. Linux tunnel tests require `/proc`, Linux utilities, and passwordless sudo. Two audio tests and the audio implementation use `/usr/bin/ffmpeg` and `/usr/bin/ffprobe`; this macOS machine installs them under Homebrew. Four PostgreSQL integration tests skip without `TEST_DATABASE_URL`. A worker run excluding the tunnel file passed 51 tests, failed the two Linux-path audio tests, and skipped those four database tests. Production database integration and deployment have not been validated by this pass.
