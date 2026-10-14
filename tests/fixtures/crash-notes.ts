import { NotesQueue } from '../../packages/notes-only/src/queue.js';
import { NotesPipeline } from '../../packages/notes-only/src/pipeline.js';
import { join } from 'node:path';
const [root, point] = process.argv.slice(2);
const queue = new NotesQueue(join(root, 'queue.sqlite'));
const pipeline = new NotesPipeline({
  root,
  queue,
  identity: {
    profile: 'a'.repeat(64),
    generator: 'full immutable contract identity',
    route: 'acp-high',
    approved: true,
  },
  store: { get: async () => null, publish: async (note) => note },
  reconcileRuntime: async () => {},
  fetchTranscript: async () =>
    'WEBVTT\n\n00:00.000 --> 00:01.000\nFull source שלום\n',
  generate: async () => {
    if (point === 'before_commit') process.kill(process.pid, 'SIGKILL');
    return '# Complete\n\n## Teaching\n\nAll source content שלום.';
  },
});
queue.enqueue([{ id: '1' }]);
await pipeline.fetching(queue.claim('fetching')!, new AbortController().signal);
const accept = queue.accept.bind(queue);
queue.accept = (job, changes) => {
  if (point === 'after_accept') accept(job, changes);
  process.kill(process.pid, 'SIGKILL');
};
await pipeline.generating(
  queue.claim('generating')!,
  new AbortController().signal,
);
