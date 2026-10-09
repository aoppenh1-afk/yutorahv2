import { invalidTranscript, parseVtt } from './webvtt.mjs';

/** Fetch only official VTT; transport failures remain retryable. */
export async function fetchOfficialVtt(id, signal, fetchImpl = fetch) {
  const response = await fetchImpl(
    `https://api.yutorah.org/transcriptions/shiur/${id}/vtt`,
    {
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    },
  );
  if (response.status === 404 || response.status === 204) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    const error = Object.assign(new Error(`Upstream HTTP ${response.status}`), {
      code: `transcript_http_${response.status}`,
      status: response.status,
    });
    const value = response.headers.get('Retry-After');
    if (value !== null) {
      error.retryAfter = value;
      const seconds = Number(value);
      const after = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(value) - Date.now();
      if (Number.isFinite(after)) error.retryAfterMs = Math.max(0, after);
    }
    throw error;
  }
  if (!response.body) throw invalidTranscript('Empty transcript response.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024)
        throw invalidTranscript('Transcript exceeds the byte limit.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidTranscript('Transcript is not valid UTF-8.');
  }
  if (!text.trim()) return null;
  const cues = parseVtt(text);
  if (cues.length > 5000) throw invalidTranscript('Too many transcript cues.');
  return cues.length ? text : null;
}
