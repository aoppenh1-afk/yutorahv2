import type { RawShiur } from './api-types';
import { plain } from './yutorah';

/** Read the public catalog description, never a client-supplied extraction input. */
export function sourceDescription(raw: RawShiur, id: string) {
  if (String(raw.shiurID ?? raw.shiurid) !== id)
    throw new Error('The catalog returned a different shiur.');
  return { description: plain(raw.shiurDescription ?? raw.shiurdescription) };
}
