export type FailureCode =
  | 'cancelled'
  | 'timeout'
  | 'process_exit'
  | 'protocol'
  | 'off_task'
  | 'output_limit'
  | 'incomplete_output'
  | 'auth_required'
  | 'quota_exhausted'
  | 'configuration'
  | 'provider'
  | 'storage_exhausted'
  | 'invalid_transcript'
  | 'invalid_audio'
  | 'download'
  | 'checkpoint'
  | 'lease_lost';

/** Messages are deliberately payload-free and safe to persist. */
export class Failure extends Error {
  constructor(public readonly code: FailureCode) {
    super(code);
    this.name = 'Failure';
  }
}
export function failure(error: unknown): Failure {
  // PostgreSQL disk_full also covers managed database storage caps. Do not
  // persist its message, which can include connection or query details.
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === '53100'
  )
    return new Failure('storage_exhausted');
  return error instanceof Failure ? error : new Failure('provider');
}
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof Failure
      ? signal.reason
      : new Failure('cancelled');
}
export function abortReason(signal: AbortSignal): Failure {
  return signal.reason instanceof Failure
    ? signal.reason
    : new Failure('cancelled');
}
