import { d1HttpDatabase } from './d1-http';
import { managedSearchDatabase } from './search-postgres';

let fallback:
  | {
      accountId: string;
      databaseId: string;
      token: string;
      db: ReturnType<typeof d1HttpDatabase>;
    }
  | undefined;
function fallbackDatabase() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  const databaseId = process.env.SEARCH_D1_DATABASE_ID || '';
  const token = process.env.SEARCH_D1_API_TOKEN || '';
  if (
    !fallback ||
    fallback.accountId !== accountId ||
    fallback.databaseId !== databaseId ||
    fallback.token !== token
  )
    fallback = {
      accountId,
      databaseId,
      token,
      db: d1HttpDatabase({ accountId, databaseId, token }),
    };
  return fallback.db;
}

// Vite replaces cloudflare:workers only in the Vercel build. These credentials
// stay in the server runtime and are never exposed through NEXT_PUBLIC_*.
export const env = {
  get SEARCH_INDEX_TRANSFER_ENABLED() {
    return process.env.SEARCH_INDEX_TRANSFER_ENABLED;
  },
  get SEARCH_INDEX_TRANSFER_TOKEN() {
    return process.env.SEARCH_INDEX_TRANSFER_TOKEN;
  },
  get DB() {
    if (process.env.SEARCH_DATABASE_URL) return managedSearchDatabase();
    return fallbackDatabase();
  },
};
