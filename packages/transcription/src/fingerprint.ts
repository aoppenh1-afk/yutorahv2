import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { checkAbort } from '../../antigravity-acp/src/errors.js';
import { versions, type Settings } from './types.js';

export const digest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
}
export const objectDigest = (value: unknown) => digest(canonical(value));
export async function hashFile(
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash('sha256');
  for await (const data of createReadStream(path)) {
    checkAbort(signal);
    hash.update(data);
  }
  return hash.digest('hex');
}
export function fingerprint(input: {
  jobId: string;
  shiurId: string;
  audioHash: string;
  durationMs: number;
  skillHash: string;
  runtime: string;
  settings: Settings;
  preparationIdentity: string;
}): string {
  return objectDigest({ ...input, versions });
}
