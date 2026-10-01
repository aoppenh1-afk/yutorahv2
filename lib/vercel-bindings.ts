import { d1HttpDatabase } from './d1-http';

// Vite replaces cloudflare:workers only in the Vercel build. These credentials
// stay in the server runtime and are never exposed through NEXT_PUBLIC_*.
export const env = {
  get DB() {
    return d1HttpDatabase({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
      databaseId: process.env.SEARCH_D1_DATABASE_ID || '',
      token: process.env.SEARCH_D1_API_TOKEN || '',
    });
  },
};
