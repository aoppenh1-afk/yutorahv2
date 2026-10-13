'use client';
import { useEffect } from 'react';
import { registerOfflineWorker } from '@/lib/offline-client';
export function OfflineSupport() {
  useEffect(() => {
    // Development assets are intentionally not cached. Verify offline behavior in a production build.
    if (process.env.NODE_ENV === 'production')
      void registerOfflineWorker().catch(() => {});
  }, []);
  return null;
}
