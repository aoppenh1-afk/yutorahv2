import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import ts from 'typescript';

// Byte budgets are deterministic CI checks. Runtime latency is measured by
// sampled vitals and browser fixtures, rather than timing assertions in CI.
const root = resolve(process.argv[2] || 'dist/client');
const files = new Map();
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(js|css)$/.test(path)) {
      const body = await readFile(path, 'utf8');
      files.set(path, { body, gzip: gzipSync(body).length });
    }
  }
}
await walk(join(root, '_next'));
assert.ok(files.size, 'A production client build is required.');
// The bulk notes worker is a separate build that bundles its own PDF renderer
// and starts only when a reader downloads a whole collection or series.
const workers = [...files].filter(([path]) =>
  /\/notes-bundle\.worker-[^/]+\.js$/.test(path),
);
for (const [path] of workers) files.delete(path);
const js = [...files].filter(([path]) => path.endsWith('.js'));
const css = [...files].filter(([path]) => path.endsWith('.css'));
const graph = new Set();
function visit(path, target = graph) {
  if (target.has(path) || !files.has(path)) return;
  target.add(path);
  if (!path.endsWith('.js')) return;
  const ast = ts.createSourceFile(
    path,
    files.get(path).body,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  for (const statement of ast.statements) {
    if (
      (!ts.isImportDeclaration(statement) &&
        !ts.isExportDeclaration(statement)) ||
      !statement.moduleSpecifier
    )
      continue;
    const specifier = statement.moduleSpecifier.text;
    if (specifier.startsWith('.'))
      visit(resolve(dirname(path), specifier), target);
    else if (specifier.startsWith('/')) visit(join(root, specifier), target);
  }
}
const manifest = JSON.parse(
  await readFile(join(root, 'vinext-client-entry-manifest.json'), 'utf8'),
);
visit(join(root, manifest.appBrowserEntry));
// RSC client references are loaded separately from the browser bootstrap.
// Include the default Home screen in this initial-page budget.
for (const [path] of js)
  if (
    /\/(torah-app|learning-home|layout)-[^/]+\.js$/.test(path) &&
    !path.includes('layout-segment')
  )
    visit(path);
const sum = (entries) =>
  entries.reduce((total, [, file]) => total + file.gzip, 0);
// File conversion is requested explicitly by Download. Keep its dependencies
// out of the reading budget, with a separate cap and a check for eager imports.
const exportGraph = new Set();
for (const [path] of js)
  if (/\/notes-(pdf|docx)-/.test(path)) visit(path, exportGraph);
const readingGraph = new Set();
for (const [path] of js) if (!exportGraph.has(path)) visit(path, readingGraph);
const exportOnly = new Set(
  [...exportGraph].filter((path) => !readingGraph.has(path)),
);
for (const path of exportOnly)
  assert.ok(!graph.has(path), `${path} must load only when downloading notes`);
const measurements = {
  initialHomeJs: sum([...files].filter(([path]) => graph.has(path))),
  totalJs: sum(js.filter(([path]) => !exportOnly.has(path))),
  notesExportJs: sum(js.filter(([path]) => exportOnly.has(path))),
  notesBundleWorkerJs: sum(workers),
  totalCss: sum(css),
  largestJsChunk: Math.max(
    ...js
      .filter(([path]) => !exportOnly.has(path))
      .map(([, file]) => file.gzip),
  ),
  applicationChunk: Math.max(
    ...js
      .filter(([path]) => /\/torah-app-/.test(path))
      .map(([, file]) => file.gzip),
  ),
};
const budgets = {
  initialHomeJs: 300_000,
  // Includes account SDKs, offline downloads and the shared search vocabulary.
  // 157 spelling groups and 69 subject bridges add a few KB of browser data.
  // Keep the initial-page and individual-chunk caps unchanged.
  // Inside the Shiur results and saved-search controls are deferred screens.
  // Allow their added code without increasing the initial-page budget.
  totalJs: 430_000,
  notesExportJs: 600_000,
  notesBundleWorkerJs: 500_000,
  totalCss: 50_000,
  largestJsChunk: 80_000,
  applicationChunk: 40_000,
};
assert.ok(
  Number.isFinite(measurements.applicationChunk),
  'The application chunk must be present.',
);
for (const [name, budget] of Object.entries(budgets))
  assert.ok(
    measurements[name] <= budget,
    `${name}: ${measurements[name]} gzip bytes exceeds ${budget}`,
  );
for (const [path] of files)
  if (
    /\/(transcript-reader|react-markdown|sources-panel|advanced-search|inside-shiur-search|saved-search-tools|search-scope|downloads-page|secondary-screens)-/.test(
      path,
    )
  )
    assert.ok(!graph.has(path), `${path} must remain lazy on Home`);
console.log(JSON.stringify({ gzipBytes: measurements, budgets }, null, 2));
