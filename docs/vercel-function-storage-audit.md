# Vercel function storage audit

Investigated October 15, 2026. The bundle optimization is applied locally in
`vite.config.ts`. No deployment, retention change, or deployment deletion was
performed for this investigation.

## Findings

The email concerns stored deployment bundles. Vercel counts Function bundles in
each deployed region, and retained deployments keep contributing to storage.
Usage is measured in GB-months using each project's daily maximum stored amount.
A deletion therefore does not erase earlier daily usage. See
[Vercel's storage accounting](https://vercel.com/docs/deployment-storage).

Authenticated, fully paginated Vercel API reads found 204 retained deployments
across the team `senderopp-8687s-projects`. Of those, 172 belonged to `yutorah`:
165 ready and 7 errored, with 108 production-targeted and 64 preview deployments.
The project policy reports 30-day retention for production, preview, canceled,
and errored deployments. The production deployment inspected used one Function
in `iad1`.

The email's 75% figure was not independently verified. The detailed usage API
returned `plan_upgrade_required` for this Hobby team, and the preview browser
was not logged into Vercel. Deployment counts alone cannot establish how much
of the team's quota each project uses.

## Measured optimization

Two Vercel builds from the same isolated source snapshot produced:

| Measurement | Baseline | With exclusions |
| --- | ---: | ---: |
| Function files, raw bytes | 111,325,664 | 28,651,724 |
| Function files | 2,875 | 770 |
| Traced dependencies | 222 | 136 |

The change removes 82,673,940 bytes per local build, a 74.26% reduction.
These are local macOS ARM64 output sizes, not Vercel's Linux bundle size or a
guaranteed percentage reduction in the team's billed usage.

Vinext 1.0.0-beta.5 copies its default `serverExternalPackages` list into Nitro's
`traceDeps`. Nitro treats positive package names as forced inclusions, so
installed development tools enter the function even without server imports.
The initial external trace inputs were only `pg` and `tslib`, but the forced
list pulled in TypeScript, Playwright, webpack, ts-morph, PostCSS, and associated
build binaries.

The Vercel Nitro configuration now excludes those six development packages using
the supported `!package` selectors. Database, document export, and image runtime
dependencies remain available. No dependencies were uninstalled. See
[Nitro's trace configuration](https://nitro.build/config#tracedeps).

Validation passed in an isolated checkout because the shared checkout was being
changed by another process:

- `npm run build:vercel`, client performance budgets, config lint and formatting.
- All seven existing notes PDF/DOCX export tests.
- Five smoke checks against the packaged Function copied outside the checkout
  and its development dependencies: Home and Privacy render HTML; transcript
  export, shiur validation, and source feature routes return expected responses.

Build logs and file manifests are under `outputs/vercel-storage-audit/`.

## Next actions

1. Deploy the bundle change through the normal release process. Compare the
   deployed Function's Resources size with the preceding release, then review
   Functions Storage for the same project and date range.
2. Consider 7-day preview retention and 14-day production retention after choosing
   the required review and rollback windows. Keep current production, useful
   rollback releases, and active previews. At the initial snapshot, 63 ready
   YUTorah deployments were older than seven days, including 22 previews; these
   counts do not account for aliases or other protection exceptions.
3. Avoid deployments for changes limited to documentation, tests, or the separate
   notes worker. The inspected production release was triggered by a player-test
   change, and preview history also included documentation commits. Add a checked
   ignore-build rule only after defining which shared files affect the website.

Vercel's retention worker and protection exceptions can delay deletion. Current
aliases and active branch previews can keep deployments beyond the configured
window. See [deployment retention](https://vercel.com/docs/deployment-retention)
and [storage optimization](https://vercel.com/docs/deployment-storage/optimize).
