import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';

/** Generate a versioned, minimal shell from the emitted client import graph. */
const candidates = process.argv.slice(2);
if (!candidates.length)
  candidates.push('dist/client', '.vercel/output/static', '.output/public');
let builds = 0;
for (const input of candidates) {
  const root = resolve(input);
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(join(root, 'vinext-client-entry-manifest.json'), 'utf8'),
    );
  } catch {
    continue;
  }
  const files = new Map();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.set(path, await readFile(path));
    }
  }
  await walk(join(root, '_next'));
  const selected = new Set();
  function visit(path, target = selected) {
    if (target.has(path) || !files.has(path)) return;
    target.add(path);
    if (!path.endsWith('.js')) return;
    const ast = ts.createSourceFile(
      path,
      files.get(path).toString(),
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
  visit(join(root, manifest.appBrowserEntry));
  for (const path of files.keys()) {
    if (
      /\/(torah-app|layout|offline-support)-[^/]+\.js$/.test(path) &&
      !path.includes('layout-segment')
    )
      visit(path);
    if (/\.(css|woff2?)$/.test(path)) selected.add(path);
  }
  // RSC loads framework client references dynamically. Static imports alone
  // miss next/link and layout context chunks, even though cold hydration needs them.
  // Cache application modules, while keeping PDF/DOCX exporters out of the shell.
  const exporters = new Set();
  for (const path of files.keys())
    if (/\/notes-(pdf|docx)-/.test(path)) visit(path, exporters);
  for (const path of files.keys())
    if (path.endsWith('.js') && !exporters.has(path)) visit(path);
  const assets = [...selected]
    .map((path) => '/' + relative(root, path).replaceAll('\\', '/'))
    .sort();
  assets.push(
    '/images/yutorah-wordmark.png',
    '/icons/yutorah-192.png',
    '/icons/yutorah-512.png',
    '/apple-touch-icon.png',
  );
  const worker = await readFile('public/sw.js', 'utf8');
  const version = createHash('sha256')
    .update(worker)
    .update(assets.join('\n'))
    .digest('hex')
    .slice(0, 16);
  const config = { version, assets };
  await writeFile(
    join(root, 'sw.js'),
    'self.__YUTORAH_SHELL__ = ' + JSON.stringify(config) + ';\n' + worker,
  );
  builds++;
  console.log(
    `Offline shell: ${assets.length} assets in ${input}, version ${version}`,
  );
}
if (!builds)
  throw new Error('No production client build found for the offline shell.');
