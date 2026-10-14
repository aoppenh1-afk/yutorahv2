import { FREE_NOTES_MODEL, MODEL_ID } from './constants.js';
export { MODEL_ID } from './constants.js';
import {
  PipelineFailure,
  type RequestEvidence,
} from '../../notes-only/src/control.js';
export type Catalog = {
  providers?: Array<{
    id: string;
    models?: Record<
      string,
      {
        id: string;
        providerID: string;
        status: string;
        variants?: { high?: unknown };
        cost?: {
          input: number;
          output: number;
          cache?: { read: number; write: number };
        };
      }
    >;
  }>;
};
export type RuntimePart = { type: string; text?: string };
export type RuntimeMessage = {
  info: {
    id?: string;
    sessionID?: string;
    role: string;
    agent?: string;
    model?: { providerID: string; modelID: string; variant?: string };
    modelID?: string;
    providerID?: string;
    variant?: string;
    cost?: number;
    tokens?: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
    error?: { name: string; data?: { statusCode?: number; message?: string } };
    time?: { completed?: number };
    finish?: string;
  };
  parts?: RuntimePart[];
};
export function assertFreeCatalog(value: Catalog) {
  const provider = value.providers?.find((p) => p.id === 'opencode');
  const model = provider?.models?.[MODEL_ID];
  const cost = model?.cost;
  if (
    !model ||
    model.status !== 'active' ||
    model.providerID !== 'opencode' ||
    model.id !== MODEL_ID ||
    !model.variants?.high
  )
    throw new PipelineFailure('configuration', 'muse', 0, true);
  if (
    !cost ||
    [cost.input, cost.output, cost.cache?.read, cost.cache?.write].some(
      (x) => x !== 0,
    )
  )
    throw new PipelineFailure('paid_route', 'muse', 0, true);
  return model;
}
export function messageEvidence(
  messages: RuntimeMessage[],
  sessionID: string,
): RequestEvidence {
  const users = messages.filter((m) => m.info?.role === 'user');
  const assistants = messages.filter((m) => m.info?.role === 'assistant');
  if (
    users.length !== 1 ||
    users[0].info.sessionID !== sessionID ||
    !assistants.length ||
    users[0].info.agent !== 'plan' ||
    users[0].info.model?.providerID !== 'opencode' ||
    users[0].info.model?.modelID !== MODEL_ID ||
    users[0].info.model?.variant !== 'high'
  )
    throw new PipelineFailure('unconfirmed_identity', 'muse', 0, true);
  const sum = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    identity: FREE_NOTES_MODEL + ':plan:high',
  };
  for (const m of assistants) {
    const i = m.info;
    if (
      i.sessionID !== sessionID ||
      i.modelID !== MODEL_ID ||
      i.providerID !== 'opencode' ||
      i.agent !== 'plan' ||
      (i.variant && i.variant !== 'high')
    )
      throw new PipelineFailure('unconfirmed_identity', 'muse', 0, true);
    if (i.cost !== 0) throw new PipelineFailure('paid_route', 'muse', 0, true);
    if (m.parts?.some((p) => ['tool', 'subtask', 'agent'].includes(p.type)))
      throw new PipelineFailure('off_task');
    if (i.error) {
      const status = i.error.data?.statusCode;
      throw Object.assign(new Error(i.error.data?.message ?? i.error.name), {
        status,
      });
    }
    const t = i.tokens;
    if (
      !t ||
      [t.input, t.output, t.reasoning, t.cache?.read, t.cache?.write].some(
        (v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0,
      )
    )
      throw new PipelineFailure('unconfirmed_identity', 'muse', 0, true);
    sum.input += t.input;
    sum.output += t.output;
    sum.reasoning += t.reasoning;
    sum.cacheRead += t.cache.read;
    sum.cacheWrite += t.cache.write;
  }
  const last = assistants.at(-1)!.info;
  if (
    !last.time?.completed ||
    !['stop', 'end_turn'].includes(last.finish ?? '')
  )
    throw new PipelineFailure('incomplete_output');
  return { ...sum, helperRequests: Math.max(0, assistants.length - 1) };
}
