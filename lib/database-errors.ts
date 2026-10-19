/** PostgreSQL disk_full also covers Neon's project storage limit. */
export function isStorageCapacityError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '53100'
  );
}

/** Neon rejects connections with 53000 when an account or project quota is spent.
 * Other insufficient_resources errors share that SQLSTATE, so check the message. */
export function isDatabaseQuotaError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '53000' &&
    'message' in error &&
    typeof error.message === 'string' &&
    /exceeded the quota/i.test(error.message)
  );
}
