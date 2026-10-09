export function invalidTranscript(message: string): Error & {
  code: 'invalid_transcript';
};

export function parseVtt(
  input: string,
): Array<{ startMs: number; endMs: number; text: string }>;
