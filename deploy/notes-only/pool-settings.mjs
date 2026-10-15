import { readFile } from 'node:fs/promises';

// JSON values become separate arguments, never executable shell configuration.
const settings = await readFile(process.argv[2], 'utf8').then(JSON.parse);
const controls = [
  ['fetchers', '--fetchers', 1, 16],
  ['generators', '--concurrency', 1, 6],
  ['publishers', '--publishers', 1, 8],
];
for (const [name, , min, max] of controls) {
  if (
    !Number.isSafeInteger(settings[name]) ||
    settings[name] < min ||
    settings[name] > max
  )
    throw new Error(`Invalid pool setting: ${name}.`);
}
for (const [name, flag] of controls) console.log(`${flag}\n${settings[name]}`);
