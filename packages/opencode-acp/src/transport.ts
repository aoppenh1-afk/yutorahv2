import { Agent, request, type IncomingMessage } from 'node:http';

const agent = new Agent({
  keepAlive: true,
  timeout: 0,
  maxSockets: 16,
  maxFreeSockets: 4,
});

/** The explicit signal owns both header and body deadlines. Fetch's independent five-minute header limit can abort valid inference. */
export async function loopbackJSON(
  url: string,
  options: {
    method: string;
    password: string;
    body?: unknown;
    signal: AbortSignal;
    maxBytes?: number;
  },
): Promise<unknown> {
  const target = new URL(url);
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    target.username ||
    target.password
  )
    throw new Error('Only the owned loopback server is allowed.');
  options.signal.throwIfAborted();
  const data =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(
      target,
      {
        method: options.method,
        agent,
        signal: options.signal,
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from('opencode:' + options.password).toString('base64'),
          'Content-Type': 'application/json',
          ...(data === undefined
            ? {}
            : { 'Content-Length': Buffer.byteLength(data) }),
        },
      },
      resolve,
    );
    req.once('error', reject);
    req.end(data);
  });
  try {
    if (
      !response.statusCode ||
      response.statusCode < 200 ||
      response.statusCode >= 300
    )
      throw Object.assign(new Error('OpenCode HTTP ' + response.statusCode), {
        status: response.statusCode,
        retryAfter: response.headers['retry-after'],
      });
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > (options.maxBytes ?? 16 * 1024 * 1024))
        throw new Error('Runtime response exceeds the byte limit.');
      chunks.push(buffer);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks, bytes),
    );
    return text ? JSON.parse(text) : null;
  } finally {
    if (!response.complete) response.destroy();
  }
}
