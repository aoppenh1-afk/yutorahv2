import { readFile, writeFile } from 'node:fs/promises';

const filename = process.argv[2];
let source = await readFile(filename, 'utf8');
const originalSource = source;
const marker = '// VM scheduling support v1';
if (
  !source.includes(marker) &&
  !source.includes('// VM concurrent notes support v2')
) {
  const replace = (before, after) => {
    if (!source.includes(before))
      throw new Error('Unsupported pipeline package.');
    source = source.replace(before, after);
  };
  // The shell runner holds a kernel lock before recovering an interrupted CLI.
  replace(
    'await readFile3(join3(lock, "owner.json"), "utf8")',
    `await readFile3(join3(lock, "owner.json"), "utf8").catch((error) => {
      if (error.code === "ENOENT" && process.env.YUTORAH_NOTES_LOCK_HELD === "1")
        return JSON.stringify({ pid: 0, hostname: "interrupted" });
      throw error;
    })`,
  );
  replace(
    '    let processed = 0;\n    while (processed < limit && !controller.aborted) {',
    `    ${marker}
    const runUntil = args.includes("--max-runtime-ms")
      ? Date.now() + integer("--max-runtime-ms", 1800000, 1000, 86400000)
      : Infinity;
    let processed = 0;
    while (processed < limit && !controller.aborted && Date.now() < runUntil) {`,
  );
  replace(
    'await delay2(6e4, void 0, { signal: controller });',
    'await delay2(Math.max(0, Math.min(6e4, runUntil - Date.now())), void 0, { signal: controller });',
  );
  replace(
    'await delay2(after, void 0, { signal: controller });',
    'await delay2(Math.max(0, Math.min(after, runUntil - Date.now())), void 0, { signal: controller });',
  );
}
const poolMarker = '// VM concurrent notes support v2';
if (!source.includes(poolMarker)) {
  const replace = (before, after) => {
    if (!source.includes(before))
      throw new Error('Unsupported concurrent pipeline package.');
    source = source.replace(before, after);
  };
  if (
    !source.includes(
      '`opencode:${config.version ?? OPENCODE_VERSION}:notes-3-high`',
    )
  )
    replace(
      '`opencode:${config.version ?? OPENCODE_VERSION}:notes-2`',
      '`opencode:${config.version ?? OPENCODE_VERSION}:notes-3-high`',
    );
  if (!source.includes('await select("effort", "high");'))
    replace(
      '    await select("model", model);\n    return [model];',
      `    await select("model", model);
    await select("effort", "high");
    for (const [id, value] of [["mode", "plan"], ["model", model], ["effort", "high"]])
      if (rows2(result.configOptions).find((o) => o.id === id)?.currentValue !== value)
        throw new Failure("configuration");
    return [model];`,
    );
  if (!source.includes('variant: "high"'))
    replace(
      '        model: FREE_NOTES_MODEL\n      }',
      '        model: FREE_NOTES_MODEL,\n        variant: "high"\n      }',
    );
  // Each job gets its own SDK connection; session state is not shared across lanes.
  replace(
    '    const pipeline = new NotesPipeline({',
    '    const createPipeline = () => new NotesPipeline({',
  );
  replace(
    '      queue,\n      store,\n      signal: controller,',
    '      queue,\n      store: new TiDBNotesStore(credential),\n      signal: controller,',
  );
  replace(
    '              await client.session(workspace, FREE_NOTES_MODEL);\n              return client.textPrompt(prompt);',
    `              await client.session(workspace, FREE_NOTES_MODEL);
              console.log(JSON.stringify({ id: job.id, status: "generating", model: FREE_NOTES_MODEL, thinking: "high" }));
              return client.textPrompt(prompt);`,
  );
  const start = source.indexOf('    // VM scheduling support v1');
  const end = source.indexOf(
    '    console.log(JSON.stringify({ jobs: queue.status() }));',
    start,
  );
  if (start < 0 || end < 0) throw new Error('Unsupported worker loop.');
  source =
    source.slice(0, start) +
    `    ${poolMarker}
    const result = await runNotesPool({
      queue,
      processJob: (job) => createPipeline().process(job),
      signal: controller,
      concurrency: integer("--concurrency", 6, 1, 10),
      limit,
      follow: args.includes("--follow"),
      runUntil: args.includes("--max-runtime-ms")
        ? Date.now() + integer("--max-runtime-ms", 1800000, 1000, 86400000)
        : Infinity,
      paceMs: integer("--pace-ms", 2000, 1000, 60000)
    });
    if (result.failed) process.exitCode = 1;
` +
    source.slice(end);
  replace(
    '  run --all --follow            Continue the queue, wait for quota resets',
    '  run --all --follow            Continue with up to ten high-thinking agents\n  --concurrency 1..10            Each agent gets one transcript; refill free slots',
  );
  source = 'import { runNotesPool } from "../pool.mjs";\n' + source;
}
// Upgrade the concurrency ceiling in packages already prepared for six lanes.
source = source
  .replace(
    'integer("--concurrency", 6, 1, 6)',
    'integer("--concurrency", 6, 1, 10)',
  )
  .replace(
    'Continue with six high-thinking agents',
    'Continue with up to ten high-thinking agents',
  )
  .replace(
    '--concurrency 1..6             ',
    '--concurrency 1..10            ',
  );
source = source.replace(
  'import { runNotesPool } from "../pool.mjs";',
  'import { runNotesPool, createMemoryAdmission } from "../pool.mjs";',
);
if (!source.includes('canAdmit: createMemoryAdmission(')) {
  const original = '    const result = await runNotesPool({\n      queue,';
  if (!source.includes(original))
    throw new Error('Unsupported pool configuration.');
  source = source.replace(
    original,
    original +
      '\n      canAdmit: createMemoryAdmission({ minAvailableMiB: integer("--min-free-memory-mib", 0, 0, 1048576) }),',
  );
}
if (!source.includes('  --min-free-memory-mib ')) {
  const original =
    '--concurrency 1..10            Each agent gets one transcript; refill free slots';
  if (!source.includes(original)) throw new Error('Unsupported pool help.');
  source = source.replace(
    original,
    original +
      '\\n  --min-free-memory-mib N        Wait for host memory before starting another agent',
  );
}
const catalogImport = 'import { vmCatalogText } from "../catalog-fetch.mjs";';
if (!source.includes(catalogImport)) {
  const original =
    'await boundedText(\n        `https://yutorah.org/api/search/get?${params}`,';
  if (!source.includes(original))
    throw new Error('Unsupported catalog implementation.');
  source =
    catalogImport +
    '\n' +
    source.replace(
      original,
      'await vmCatalogText(\n        `https://yutorah.org/api/search/get?${params}`,',
    );
}
// Replace the bundled implementations with the same parser/fetcher used in source.
// Do this on every install, including bundles already patched for concurrency.
const parserStart = source.indexOf('// lib/webvtt.mjs');
const parserEnd = source.indexOf(
  '\n// ',
  parserStart + '// lib/webvtt.mjs'.length,
);
const fetchMarker = '// lib/official-transcript.mjs';
const fetchStart = source.includes(fetchMarker)
  ? source.indexOf(fetchMarker)
  : source.indexOf('async function fetchOfficialVtt(');
const fetchEnd = source.indexOf('\n// ', fetchStart + 1);
if (parserStart < 0 || parserEnd < 0 || fetchStart < 0 || fetchEnd < 0)
  throw new Error('Unsupported transcript implementation.');
const parser = (
  await readFile(new URL('../../lib/webvtt.mjs', import.meta.url), 'utf8')
).replaceAll('export function ', 'function ');
const fetcher = (
  await readFile(
    new URL('../../lib/official-transcript.mjs', import.meta.url),
    'utf8',
  )
)
  .replace(/^import[^\n]+\n/, '')
  .replace('export async function ', 'async function ');
source =
  source.slice(0, fetchStart) +
  fetchMarker +
  '\n' +
  fetcher.trim() +
  '\n\n' +
  source.slice(fetchEnd);
source =
  source.slice(0, parserStart) +
  '// lib/webvtt.mjs\n' +
  parser.trim() +
  '\n\n' +
  source.slice(parserEnd);
if (!source.includes('secrets: [credential.username, credential.password]')) {
  const original = '    const result = await runNotesPool({\n      queue,';
  if (!source.includes(original))
    throw new Error('Unsupported pool configuration.');
  source = source.replace(
    original,
    original + '\n      secrets: [credential.username, credential.password],',
  );
}
if (source !== originalSource)
  await writeFile(filename, source, { mode: 0o600 });
