'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getAccountClient } from '@/lib/account-client';

// A module-level promise also makes Strict Mode's repeated effect harmless.
let exchange: Promise<void> | undefined;
export default function AuthCallback() {
  const [error, setError] = useState('');
  useEffect(() => {
    let mounted = true;
    exchange ??= (async () => {
      const params = new URLSearchParams(window.location.search);
      if (params.has('error'))
        throw new Error(
          'Google sign-in was cancelled or could not finish. Please try again.',
        );
      const code = params.get('code');
      if (!code)
        throw new Error(
          'The sign-in link is incomplete. Please try signing in again.',
        );
      const db = await getAccountClient();
      const flowId = params.get('sb_flow_id');
      const { error } = await db.auth.exchangeCodeForSession(
        code,
        flowId ? { flowId } : undefined,
      );
      if (error)
        throw new Error(
          'Sign-in could not finish in this browser. Open YUTorah and try again.',
        );
      window.history.replaceState({}, '', window.location.pathname);
      window.location.replace('/?view=following');
    })();
    void exchange.catch((e) => {
      if (mounted) setError(e instanceof Error ? e.message : 'Sign-in failed.');
    });
    return () => {
      mounted = false;
    };
  }, []);
  return (
    <main className="auth-callback">
      <h1>{error ? 'Sign-in could not finish' : 'Finishing sign-in…'}</h1>
      <p role={error ? 'alert' : 'status'}>
        {error || 'Your teacher follows will be ready shortly.'}
      </p>
      {error && <Link href="/">Back to YUTorah</Link>}
    </main>
  );
}
