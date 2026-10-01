import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const [behavior = 'normal', marker = ''] = process.argv.slice(2);
const parallel = behavior === 'pipeline_parallel';
const record = (event, extra = {}) => appendFileSync(marker, JSON.stringify({ event, pid: process.pid, workspace: process.cwd(), ...extra }) + '\n');
if (parallel) {
  record('opened');
  process.once('exit', () => record('closed'));
  process.once('SIGTERM', () => process.exit(0));
}
if (behavior === 'ready_on_close') {
  setInterval(() => {}, 1000);
  process.once('SIGTERM', () => {
    writeFileSync(marker, 'ready');
    process.exit(0);
  });
}
const model = 'gemini-3.8-flash-high';
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const update = (kind, text = '', sessionId = 'fixture') =>
  send({
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: kind, content: { type: 'text', text } },
    },
  });
createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  if (!req.method) {
    if (marker && req.id === 99) writeFileSync(marker, JSON.stringify(req));
    return;
  }
  let result = {};
  if (req.method === 'initialize') {
    if (behavior === 'early_permission') {
      send({
        id: 99,
        method: 'session/request_permission',
        params: { options: [{ kind: 'allow_once', optionId: 'yes' }] },
      });
      return;
    }
    result = {
      protocolVersion: 1,
      agentInfo: { name: 'antigravity-acp', version: '1.2.1' },
      authMethods: [{ id: 'oauth-personal' }],
      agentCapabilities: { promptCapabilities: { audio: true } },
    };
  } else if (req.method === 'authenticate' && behavior === 'auth') {
    const url =
      'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=fixture&redirect_uri=http%3A%2F%2F127.0.0.1%3A34567%2F';
    process.stderr.write(
      'Open the following link to authenticate the ACP server: ' + url + '\n',
    );
    return;
  } else if (req.method === 'session/new') {
    result = {
      sessionId: 'fixture',
      modes: {
        availableModes: [{ id: behavior === 'bad_mode' ? 'yolo' : 'default' }],
      },
      configOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: model,
          options: [{ value: model, name: model }],
        },
      ],
    };
    if (behavior === 'session_storage') {
      const id = randomUUID();
      const profile = join(process.env.GEMINI_HOME, 'antigravity-acp');
      mkdirSync(join(profile, 'conversations'), { recursive: true });
      mkdirSync(join(profile, 'brain', id), { recursive: true });
      for (const suffix of ['.db', '.db-wal', '.db-shm', '.meta'])
        writeFileSync(join(profile, 'conversations', id + suffix), 'stored audio fixture');
      writeFileSync(join(profile, 'brain', id, 'artifact'), 'stored session fixture');
      result.sessionId = id;
    }
  } else if (req.method === 'echo') {
    setTimeout(
      () => send({ id: req.id, result: { value: req.params.value } }),
      req.params.delay,
    );
    return;
  } else if (req.method === 'session/prompt') {
    if (behavior === 'crash') process.exit(23);
    if (behavior === 'child') {
      const c = spawn(
        process.execPath,
        ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
        { stdio: 'ignore' },
      );
      writeFileSync(marker, String(c.pid));
      setInterval(() => {}, 1000);
      return;
    }
    if (behavior === 'hang') {
      setInterval(() => {}, 1000);
      return;
    }
    if (behavior === 'oversized_line') {
      process.stdout.write('x'.repeat(9 * 1024 * 1024));
      return;
    }
    if (['tool_call', 'tool_call_update'].includes(behavior)) update(behavior);
    if (['permission', 'input'].includes(behavior)) {
      send({
        id: 99,
        method:
          behavior === 'permission'
            ? 'session/request_permission'
            : 'extension/user_input',
        params: {},
      });
    }
    const blocks = req.params.prompt;
    const text = blocks.find((b) => b.type === 'text')?.text ?? '';
    const audio = blocks.find((b) => b.type === 'audio');
    if (parallel) {
      record('prompt', { kind: audio ? 'audio' : text.includes('<transcription-contract>') ? 'cleanup' : 'notes' });
      const respond = () => {
        if (!existsSync(marker + '.release')) { setTimeout(respond, 20); return; }
        update('agent_message_chunk', audio ? '[00:01] The גמ׳ asks on תוס׳.\n[00:04] Student: What about רש״י?' : text.includes('<transcription-contract>') ? 'The גמ׳ asks on תוס׳. The student asks about רש״י.' : '# The question on תוס׳\n\n## The גמ׳ and the student\n\n- **גמ׳:** asks on תוס׳\n    - **Student:** asks about רש״י');
        send({ id: req.id, result: { stopReason: 'end_turn' } });
      };
      respond();
      return;
    }
    if ((behavior.startsWith('generation') || behavior==='pipeline_all') && !audio) {
      const cleanup = text.includes('<transcription-contract>');
      const repair = text.includes('<draft-notes>');
      if(marker)appendFileSync(marker,`${cleanup?'cleanup':repair?'repair':'notes'}\n`);
      if(behavior==='generation_tool')update('tool_call');
      const output=cleanup?'The גמ׳ asks on תוס׳. The student asks about רש״י.':behavior==='generation_invalid'||behavior==='generation_repair'&&!repair?'# Notes\n\nToo short.':'# The question on תוס׳\n\n## The גמ׳ and the student\n\n- **גמ׳:** asks on תוס׳\n    - **Student:** asks about רש״י';
      update('agent_message_chunk',output);
      send({id:req.id,result:{stopReason:'end_turn'}});
      return;
    }
    const audioBytes = audio && Buffer.from(audio.data, 'base64');
    if (
      !audio ||
      (['pipeline_audio','pipeline_all'].includes(behavior)
        ? audioBytes.toString('ascii', 0, 4) !== 'RIFF'
        : audioBytes.toString() !== 'fixture audio') ||
      !audio.mimeType.startsWith('audio/')
    )
      process.exit(51);
    const skillHash = ['pipeline_audio','pipeline_all'].includes(behavior) ? marker : process.env.EXPECT_SKILL_HASH;
    if (skillHash) {
      const start =
        text.indexOf('Instructions from /lectern-transcription:\n') +
        'Instructions from /lectern-transcription:\n'.length;
      const end = text.indexOf('\n\nApply the included', start);
      if (
        createHash('sha256').update(text.slice(start, end)).digest('hex') !==
        skillHash
      )
        process.exit(52);
    }
    update('agent_thought_chunk', 'PRIVATE_THOUGHT_MUST_NOT_ESCAPE');
    update('agent_message_chunk', 'WRONG_SESSION', 'other');
    const output =
      behavior === 'oversized'
        ? 'x'.repeat(4 * 1024 * 1024 + 1)
        : '[00:01] The גמ׳ asks on תוס׳.\n[00:04] Student: What about רש״י?';
    if (behavior === 'fragmented') {
      const payload = Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'fixture',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: output },
            },
          },
        }) + '\n',
      );
      for (let i = 0; i < payload.length; i += 7)
        process.stdout.write(payload.subarray(i, i + 7));
    } else update('agent_message_chunk', output);
    result = {
      stopReason: behavior === 'truncated' ? 'max_tokens' : 'end_turn',
    };
  }
  if (req.id !== undefined) send({ id: req.id, result });
});
