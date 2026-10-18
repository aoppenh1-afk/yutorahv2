import { createInterface } from 'node:readline';
import {
  appendFileSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
const behavior =
  process.env.OPENCODE_FIXTURE_BEHAVIOR ?? process.argv[2] ?? 'normal';
const marker = process.env.OPENCODE_FIXTURE_MARKER;
if (marker) {
  const temp =
    process.env.BUN_TMPDIR ??
    process.env.TMPDIR ??
    join(process.cwd(), 'uncontained-temp');
  mkdirSync(temp, { recursive: true });
  const library = join(temp, `.fixture-${process.pid}.so`);
  writeFileSync(library, 'embedded native library');
  appendFileSync(
    marker,
    JSON.stringify({
      method: 'native-temp',
      command: process.argv[2],
      tmpdir: process.env.TMPDIR ?? null,
      bunTmpdir: process.env.BUN_TMPDIR ?? null,
      library,
    }) + '\n',
  );
}
if (process.argv[2] === 'session' && process.argv[3] === 'delete') {
  if (process.env.OPENCODE_FIXTURE_FAIL_DELETE_MARKER) {
    try {
      readFileSync(process.env.OPENCODE_FIXTURE_FAIL_DELETE_MARKER);
      process.exit(1);
    } catch {}
  }
  if (marker)
    appendFileSync(
      marker,
      JSON.stringify({ method: 'session/delete', sessionId: process.argv[4] }) +
        '\n',
    );
  process.exit(0);
}
const model = 'opencode/deepseek-v4.1-flash-free';
let selectedModel = 'opencode/exo-free';
let mode = 'build';
let effort = 'minimal';
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const record = (method, extra = {}) =>
  marker && appendFileSync(marker, JSON.stringify({ method, ...extra }) + '\n');
const options = () => [
  {
    id: 'model',
    currentValue: selectedModel,
    options: [
      { value: behavior === 'missing_model' ? 'opencode/paid-model' : model },
    ],
  },
  {
    id: 'effort',
    currentValue: effort,
    options: [{ value: behavior === 'missing_effort' ? 'minimal' : 'high' }],
  },
  {
    id: 'mode',
    currentValue: mode,
    options: [{ value: behavior === 'missing_mode' ? 'build' : 'plan' }],
  },
];
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (!request.method) return;
  record(request.method, request.params);
  let result = {};
  if (request.method === 'initialize') {
    result = {
      protocolVersion: 1,
      agentInfo: {
        name: behavior === 'wrong_identity' ? 'antigravity-acp' : 'OpenCode',
        version: '1.18.33',
      },
      agentCapabilities: { promptCapabilities: { image: true } },
      authMethods: [{ id: 'opencode-login' }],
    };
  } else if (request.method === 'session/new') {
    result = { sessionId: 'opencode-fixture', configOptions: options() };
  } else if (request.method === 'session/set_config_option') {
    if (request.params.configId === 'mode') mode = request.params.value;
    if (request.params.configId === 'model' && behavior !== 'unconfirmed_model')
      selectedModel = request.params.value;
    if (
      request.params.configId === 'effort' &&
      behavior !== 'unconfirmed_effort'
    )
      effort = request.params.value;
    if (request.params.configId === 'effort' && behavior === 'changed_model')
      selectedModel = 'opencode/paid-model';
    result = { configOptions: options() };
  } else if (request.method === 'session/prompt') {
    if (behavior === 'quota' || behavior === 'auth') {
      send({
        id: request.id,
        error: {
          code: behavior === 'quota' ? 429 : 401,
          message:
            behavior === 'quota'
              ? 'Rate limit exceeded'
              : 'Authentication required',
        },
      });
      return;
    }
    if (behavior === 'tool') {
      send({
        method: 'session/update',
        params: {
          sessionId: 'opencode-fixture',
          update: { sessionUpdate: 'tool_call', toolCallId: 'tool' },
        },
      });
      return;
    }
    if (behavior === 'hang') return;
    if (selectedModel !== model || mode !== 'plan' || effort !== 'high') {
      send({
        id: request.id,
        error: { code: 500, message: 'Model or mode was not pinned' },
      });
      return;
    }
    let config;
    try {
      config = JSON.parse(
        readFileSync(join(process.cwd(), 'opencode.json'), 'utf8'),
      );
    } catch {}
    if (config)
      record('config', {
        model: config.model,
        small_model: config.small_model,
        agentModel: config.agent.plan.model,
        permission: config.permission,
      });
    send({
      method: 'session/update',
      params: {
        sessionId: 'opencode-fixture',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: '# דין חזרה\n\n## The גמ׳\n\n- **גמ׳:** introduces חזרה\n    - **Student:** asks about רש״י',
          },
        },
      },
    });
    result = { stopReason: 'end_turn' };
  }
  send({ id: request.id, result });
});
