# Patched braces dependency

`yutorah-braces-3.0.4-yutorah.0.tgz` is a private local fork of
[micromatch/braces PR #72](https://github.com/micromatch/braces/pull/72), pinned to
commit `28d440b5dd449dbf1fe6f3506cf94ecca4d02660`. This is an unmerged contributor
patch, not an official braces release.

[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) affects
published braces versions through 3.0.3, with no patched release available as of
2026-10-04. Deeply nested patterns can exhaust the recursive AST walkers. The
patch caps parser and walker depth at 100 and detects cycles in parent traversal.
Normal glob expansion and file matching remain covered by regression tests.

The archive retains upstream JavaScript, README and MIT license unchanged. Only
the package manifest is adjusted: private fork name/version and provenance are
added; development dependencies, scripts and documentation tooling are removed.
The lockfile records archive integrity. No install scripts or network downloads
are needed to use the committed archive.

Rebuild it with `node scripts/package-braces-patch.mjs`. The script verifies the
SHA-256 of the pinned upstream source before packing. The upstream test suite
passed all 904 tests; the repo audit also runs crash regressions against the
installed dependency before the unchanged `npm audit --audit-level=high` check.

The direct development dependency lets the override reference `$braces` and
resolve the local archive from the project root. All transitive consumers use
the same patched copy. Replace the archive and override with a maintained
upstream version when an official fix becomes available; retain the regressions.
