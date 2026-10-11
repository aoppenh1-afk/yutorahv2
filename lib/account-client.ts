'use client';
import { accountConfig } from './account-config';

async function createAccountClient() {
  // Import only Auth and PostgREST. Storage and Realtime are unnecessary here.
  const [{ AuthClient }, { PostgrestClient }] = await Promise.all([
    import('@supabase/auth-js'),
    import('@supabase/postgrest-js'),
  ]);
  const auth = new AuthClient({
    url: accountConfig.url + '/auth/v1',
    headers: { apikey: accountConfig.publishableKey },
    storageKey:
      'sb-' + new URL(accountConfig.url).hostname.split('.')[0] + '-auth-token',
    flowType: 'pkce',
    detectSessionInUrl: false,
    persistSession: true,
    autoRefreshToken: true,
  });
  const authorizedFetch: typeof fetch = async (input, init) => {
    const { data, error } = await auth.getSession();
    if (error) throw error;
    const headers = new Headers(init?.headers);
    headers.set('apikey', accountConfig.publishableKey);
    headers.set(
      'Authorization',
      'Bearer ' + (data.session?.access_token ?? accountConfig.publishableKey),
    );
    return fetch(input, { ...init, headers });
  };
  const rest = new PostgrestClient(accountConfig.url + '/rest/v1', {
    fetch: authorizedFetch,
  });
  return {
    auth,
    from: rest.from.bind(rest),
    rpc: rest.rpc.bind(rest),
    functions: {
      invoke: async (
        name: string,
        options: { body: { subscriptionId: string | null } },
      ) => {
        try {
          const response = await authorizedFetch(
            accountConfig.url + '/functions/v1/' + name,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(options.body),
            },
          );
          const data = (await response.json()) as {
            sent?: number;
            error?: string;
          };
          return {
            data,
            error: response.ok
              ? null
              : new Error(data.error ?? 'Notification request failed'),
          };
        } catch (e) {
          return {
            data: null,
            error:
              e instanceof Error ? e : new Error('Notification request failed'),
          };
        }
      },
    },
  };
}
let client: ReturnType<typeof createAccountClient> | undefined;
export function getAccountClient() {
  client ??= createAccountClient();
  return client;
}
