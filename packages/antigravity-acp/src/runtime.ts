import {
  mkdir,
  chmod,
  readFile,
  writeFile,
  stat,
  mkdtemp,
  rm,
  rename,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ACPClient } from './client.js';
import { Failure } from './errors.js';
import { removeConversations } from './session-cleanup.js';

export const release = {
  version: '1.2.1',
  x64: {
    archive: 'agy-acp-server-1.2.1-linux-x86_64.zip',
    sha256: '9fbf0bd584a26478161f637cabd75113f72541c842d148f578ef1a6a9edcb843',
  },
  arm64: {
    archive: 'agy-acp-server-1.2.1-linux-arm64.zip',
    sha256: '7e7ef4088bc185e1af4204029e0f4ec4210af20724f3ff262186ac0bcea6aa0e',
  },
};
export type RuntimeConfig = {
  directory: string;
  profile: string;
  scratch: string;
};

export async function prepareProfile(profile: string): Promise<void> {
  for (const path of [profile, join(profile, 'antigravity-acp')]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
  const settings = join(profile, 'antigravity-acp/settings.json');
  try {
    await writeFile(settings, '{"auth":{"type":"oauth-personal"}}\n', {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  await validateProfile(profile);
  await writeFile(
    join(profile, 'browser-helper'),
    '#!/bin/sh\nprintf \'__YUTORAH_AUTH_URL__%s\\n\' "$1" >&2\n',
    { mode: 0o700 },
  );
}
export async function validateProfile(profile: string): Promise<void> {
  for (const dir of [
    profile,
    join(profile, 'antigravity-acp'),
    join(profile, 'config'),
    join(profile, '.agents'),
  ]) {
    for (const name of [
      'settings.json',
      'mcp.json',
      'mcp_config.json',
      'hooks.json',
    ]) {
      const path = join(dir, name);
      let info;
      try {
        info = await stat(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Failure('configuration');
      }
      if (!info.isFile() || info.size > 1024 * 1024)
        throw new Failure('configuration');
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(await readFile(path, 'utf8'));
      } catch {
        throw new Failure('configuration');
      }
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Failure('configuration');
      for (const key of ['hooks', 'mcpServers', 'mcp_servers']) {
        const item = value[key];
        if (
          item != null &&
          (typeof item !== 'object' || Object.keys(item).length)
        )
          throw new Failure('configuration');
      }
      if (name === 'hooks.json' && Object.keys(value).length)
        throw new Failure('configuration');
      if (
        path === join(profile, 'antigravity-acp/settings.json') &&
        (value.auth as { type?: string } | undefined)?.type !== 'oauth-personal'
      )
        throw new Failure('configuration');
    }
  }
}
export async function withRuntime<T>(
  config: RuntimeConfig,
  signal: AbortSignal,
  operation: (client: ACPClient, workspace: string) => Promise<T>,
  onAuthorization?: (value: { url: URL; port: number }) => void,
): Promise<T> {
  await validateProfile(config.profile);
  await mkdir(config.scratch, { recursive: true, mode: 0o700 });
  const run = await mkdtemp(join(config.scratch, 'acp-'));
  const workspace = join(run, 'workspace'),
    temp = join(run, 'tmp');
  let client: ACPClient | undefined;
  const sessions = new Set<string>();
  try {
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(temp, { mode: 0o700 });
    client = new ACPClient(
      {
        executable: resolve(config.directory, 'agy_acp_server.par'),
        args: ['--uid='],
        cwd: workspace,
        version: release.version,
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          LANG: 'C.UTF-8',
          NODE_ENV: 'production',
          HOME: resolve(config.profile),
          GEMINI_HOME: resolve(config.profile),
          AGY_ACP_FORCE_FILE_STORAGE: '1',
          ANTIGRAVITY_HARNESS_PATH: resolve(
            config.directory,
            'localharness_external',
          ),
          BROWSER: `'${resolve(config.profile, 'browser-helper').replace(/'/g, `'"'"'`)}' %s`,
          TMPDIR: temp,
          PYTHONUNBUFFERED: '1',
        },
      },
      signal,
      onAuthorization,
      2000,
      async (id) => {
        sessions.add(id);
        const pending = join(run, 'sessions.json.next');
        await writeFile(
          pending,
          JSON.stringify({ version: 1, ids: [...sessions] }),
          { mode: 0o600 },
        );
        await rename(pending, join(run, 'sessions.json'));
      },
    );
    await client.initialize();
    return await operation(client, workspace);
  } finally {
    try {
      await client?.close();
    } finally {
      try {
        await removeConversations(config.profile, sessions);
      } finally {
        await rm(run, { recursive: true, force: true });
      }
    }
  }
}
