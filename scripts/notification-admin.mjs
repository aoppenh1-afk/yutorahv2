import { readFile } from 'node:fs/promises';

export async function notificationCredentials() {
  const path = process.env.NOTIFICATION_CREDENTIALS_FILE;
  const file = path ? JSON.parse(await readFile(path, 'utf8')) : {};
  return {
    ...file,
    projectRef: process.env.SUPABASE_PROJECT_REF ?? file.projectRef,
    projectUrl: process.env.SUPABASE_URL ?? file.projectUrl,
    anonKey: process.env.SUPABASE_ANON_KEY ?? file.anonKey,
    serviceRoleKey:
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? file.serviceRoleKey,
  };
}
export async function notificationAdmin() {
  let token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token && process.env.SUPABASE_SESSION_FILE)
    token = JSON.parse(
      await readFile(process.env.SUPABASE_SESSION_FILE, 'utf8'),
    ).access_token;
  if (!token)
    throw new Error(
      'Set SUPABASE_ACCESS_TOKEN or SUPABASE_SESSION_FILE. Keep secrets outside the repository.',
    );
  const credentials = await notificationCredentials();
  if (!credentials.projectRef)
    throw new Error(
      'Set SUPABASE_PROJECT_REF or NOTIFICATION_CREDENTIALS_FILE.',
    );
  const request = async (path, options = {}) => {
    const response = await fetch(
      'https://api.supabase.com/v1/projects/' + credentials.projectRef + path,
      {
        ...options,
        headers: { Authorization: 'Bearer ' + token, ...options.headers },
      },
    );
    if (!response.ok)
      throw new Error(
        'Supabase management request ' +
          path +
          ' failed with HTTP ' +
          response.status,
      );
    const body = await response.text();
    return body ? JSON.parse(body) : null;
  };
  const query = (sql) =>
    request('/database/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    });
  return { credentials, request, query };
}
export const sqlLiteral = (value) =>
  "'" + String(value).replace(/'/g, "''") + "'";
