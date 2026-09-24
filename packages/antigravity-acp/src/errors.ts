export type FailureCode =
  | 'cancelled'
  | 'timeout'
  | 'process_exit'
  | 'protocol'
  | 'off_task'
  | 'output_limit'
  | 'incomplete_output'
  | 'auth_required'
  | 'configuration'
  | 'provider'
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
