/** PostgreSQL disk_full also covers Neon's project storage limit. */
export function isStorageCapacityError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '53100'
  );
}
