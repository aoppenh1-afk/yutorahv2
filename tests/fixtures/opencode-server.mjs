import { createServer } from 'node:http';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { join } from 'node:path';

// Model Bun's embedded-library extraction: files survive even a graceful exit.
// The fallback stays in the fixture workspace so failing tests never litter /tmp.
const temp =
  process.env.BUN_TMPDIR ??
  process.env.TMPDIR ??
  join(process.cwd(), 'uncontained-temp');
mkdirSync(temp, { recursive: true });
writeFileSync(
  join(temp, `.fixture-${process.pid}.so`),
  'embedded native library',
);
appendFileSync(
  join(process.cwd(), 'native-launches.jsonl'),
  JSON.stringify({
    command: process.argv[2],
    tmpdir: process.env.TMPDIR ?? null,
    bunTmpdir: process.env.BUN_TMPDIR ?? null,
    library: join(temp, `.fixture-${process.pid}.so`),
  }) + '\n',
);
if (process.argv[2] === '--version') {
  console.log(process.env.OPENCODE_FIXTURE_BAD_VERSION ? 'invalid' : '1.18.33');
  process.exit(0);
}
const model = 'deepseek-v4.1-flash-free';
const paths = Object.fromEntries(
  [
    ['/session', 'post'],
    ['/session/status', 'get'],
    ['/session/{sessionID}', 'delete'],
    ['/session/{sessionID}/abort', 'post'],
    ['/permission', 'get'],
    ['/permission/{requestID}/reply', 'post'],
  ].map(([path, method]) => [path, { [method]: {} }]),
);
paths['/session/{sessionID}/message'] = {
  post: {
    requestBody: {
      content: {
        'application/json': {
          schema: {
            properties: {
              variant: { type: 'string' },
              agent: { type: 'string' },
              model: { properties: { providerID: {}, modelID: {} } },
              parts: {},
            },
          },
        },
      },
    },
  },
};
const server = createServer((request, response) => {
  const auth =
    'Basic ' +
    Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString(
      'base64',
    );
  if (request.headers.authorization !== auth) {
    response.writeHead(401).end();
    return;
  }
  let value;
  if (request.url === '/global/health')
    value = {
      healthy: true,
      version: process.env.OPENCODE_FIXTURE_BAD_HEALTH ? 'invalid' : '1.18.33',
    };
  else if (request.url === '/doc') value = { paths };
  else if (request.url === '/config')
    value = JSON.parse(
      readFileSync(join(process.cwd(), 'opencode.json'), 'utf8'),
    );
  else if (request.url === '/config/providers')
    value = {
      providers: [
        {
          id: 'opencode',
          models: {
            [model]: {
              id: model,
              providerID: 'opencode',
              status: 'active',
              variants: { high: {} },
              cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            },
          },
        },
      ],
    };
  else if (request.url === '/session') value = [];
  else {
    response.writeHead(404).end();
    return;
  }
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(value));
});
server.listen(0, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${server.address().port}`);
});
