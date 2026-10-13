'use client';
import { useEffect, useState } from 'react';
import type { Shiur } from './yutorah';
import { localRecording } from './downloads';
import { offlineAudioPath } from './download-contract';

/** Keep original media URLs in library sync. Local sources belong to this browser only. */
export function useRecordingSource(shiur: Shiur | null) {
  const [resolved, setResolved] = useState<{
    id: number;
    original: string;
    source: string;
  } | null>(null);
  const id = shiur?.id;
  const original = shiur?.audio;
  useEffect(() => {
    if (!id || !original) return;
    let live = true;
    let objectUrl: string | undefined;
    void (async () => {
      const recording = await localRecording(id);
      let source = original;
      if (recording?.headers.has('X-YUTorah-Complete')) {
        if (navigator.serviceWorker?.controller) source = offlineAudioPath(id);
        else {
          objectUrl = URL.createObjectURL(await recording.blob());
          source = objectUrl;
        }
      }
      if (live) setResolved({ id, original, source });
      else if (objectUrl) URL.revokeObjectURL(objectUrl);
    })();
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, original]);
  return resolved?.id === shiur?.id && resolved?.original === shiur?.audio
    ? resolved?.source
    : undefined;
}
