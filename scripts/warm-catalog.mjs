import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:5173' },
    collections: { type: 'string', default: '12' },
    teachers: { type: 'string', default: '4' },
    'max-minutes': { type: 'string', default: '6' },
  },
});
const base = new URL(values.url);
const token = process.env.TRENDING_REFRESH_TOKEN;
const collections = Number(values.collections),
  teachers = Number(values.teachers),
  minutes = Number(values['max-minutes']);
if (
  !['http:', 'https:'].includes(base.protocol) ||
  !token ||
  !Number.isSafeInteger(collections) ||
  collections < 0 ||
  collections > 200 ||
  !Number.isSafeInteger(teachers) ||
  teachers < 0 ||
  teachers > 50 ||
  !Number.isFinite(minutes) ||
  minutes < 1 ||
  minutes > 30
)
  throw new Error('Set TRENDING_REFRESH_TOKEN and choose valid cache budgets.');
const deadline = Date.now() + minutes * 60_000;
async function read(params) {
  const url = new URL('/api/catalog/refresh', base);
  url.search = new URLSearchParams(params).toString();
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
    redirect: 'error',
    signal: AbortSignal.timeout(
      Math.max(1, Math.min(60_000, deadline - Date.now())),
    ),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Cache warm returned HTTP ' + response.status);
  }
  return response.json();
}
const plan = await read({ kind: 'plan' });
let warmed = 0,
  partial = 0;
const queue = [
  ...plan.collections
    .slice(0, collections)
    .map((id) => ({ kind: 'collection', id })),
  ...plan.teachers.slice(0, teachers).map((id) => ({ kind: 'teacher', id })),
];
while (queue.length && Date.now() < deadline - 1000) {
  const { kind, id } = queue.shift();
  try {
    const result = await read({ kind, id: String(id) });
    if (result.complete) warmed++;
    else queue.push({ kind, id });
    await pause(100);
  } catch {
    partial++;
  }
}
console.log(
  JSON.stringify({
    warmed,
    partial,
    budgetReached: Date.now() >= deadline - 1000,
  }),
);
if (partial) process.exitCode = 2;
