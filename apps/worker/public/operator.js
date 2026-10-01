'use strict';
const el = (id) => document.getElementById(id);
let snapshot;
let directory;
let chosen;
let viewed;
let viewingNotes = false;
let refreshing = false;
let directoryPending;
let directoryRetryAt = 0;
let settingsDirty = false;
const names = {
  queued: 'Waiting',
  downloading: 'Downloading',
  preparing: 'Preparing audio',
  transcribing: 'Transcribing',
  merging: 'Merging',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  cleaning: 'Cleaning transcript',
  generating: 'Writing notes',
  starting: 'Starting',
  running: 'Running',
  stopped: 'Paused',
  waiting_quota: 'Waiting for usage reset',
  authenticating: 'Connecting',
  error: 'Needs attention',
};
async function api(path, data) {
  const response = await fetch('/api/operator/' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers:
      data === undefined
        ? {}
        : { 'Content-Type': 'application/json', 'X-Operator-Request': '1' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The operation failed.');
  return result;
}
function notice(text) {
  el('notice').textContent = text;
}
async function act(path, data = {}) {
  try {
    const result = await api(path, data);
    notice(
      path === 'scan'
        ? `Imported ${result.accepted} recordings from your selections.`
        : 'Saved.',
    );
    await refresh();
    return result;
  } catch (error) {
    notice(error.message);
  }
}
function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}
function button(text, click) {
  const item = node('button', text, 'secondary');
  item.type = 'button';
  item.addEventListener('click', click);
  return item;
}
function currentKind() {
  return document.querySelector('input[name=kind]:checked').value;
}
function choices() {
  el('choices').replaceChildren();
  const query = el('source-search').value.trim().toLocaleLowerCase();
  if (!directory || query.length < 2) return;
  const rows = directory[currentKind() === 'teacher' ? 'teachers' : 'series']
    .filter((v) => v.name.toLocaleLowerCase().includes(query))
    .slice(0, 30);
  for (const row of rows) {
    const b = button(row.name, () => {
      chosen = { ...row, kind: currentKind() };
      el('chosen-source').textContent = `Selected: ${row.name}`;
      el('source-search').value = row.name;
      el('choices').replaceChildren();
      el('add-selection').disabled = false;
    });
    b.append(node('small', row.count.toLocaleString() + ' shiurim'));
    el('choices').append(b);
  }
  if (!rows.length)
    el('choices').append(
      node('p', 'No matching sources. Try a shorter name.', 'hint'),
    );
}
async function loadDirectory() {
  if (directory || directoryPending || Date.now() < directoryRetryAt) return;
  directoryPending = api('directory')
    .then((value) => {
      directory = value;
      for (const teacher of directory.teachers) {
        const option = node('option', teacher.name);
        option.value = teacher.id;
        el('series-teacher').append(option);
      }
      el('source-search').placeholder = 'Search by name…';
      choices();
    })
    .catch((error) => {
      directoryRetryAt = Date.now() + 30000;
      notice('Could not load the source directory: ' + error.message);
    })
    .finally(() => {
      directoryPending = undefined;
    });
  await directoryPending;
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    snapshot = await api('status');
    el('workspace').hidden = false;
    const r = snapshot.runtime;
    el('session-state').textContent =
      `${r.activeSessions} of ${r.concurrency} Antigravity sessions active. Transcription and notes share these slots.`;
    el('run-state').textContent =
      r.state === 'waiting_quota' && r.resumeAt
        ? `Resumes automatically at ${new Date(r.resumeAt).toLocaleString()}`
        : names[r.state] || r.state;
    el('start').disabled =
      ['starting', 'running', 'authenticating'].includes(r.state) ||
      !r.runtimeInstalled ||
      (!r.connected && r.state !== 'waiting_quota') ||
      (!r.models.includes(snapshot.settings.model) &&
        r.state !== 'waiting_quota') ||
      settingsDirty ||
      !snapshot.targets.some((t) => t.enabled);
    el('stop').disabled = !['starting', 'running', 'waiting_quota'].includes(
      r.state,
    );
    el('connect').disabled =
      !r.runtimeInstalled || r.state === 'authenticating';
    el('check').disabled = el('connect').disabled;
    el('cancel-auth').hidden = r.state !== 'authenticating';
    const errors = {
      auth_required: 'Google sign-in is needed.',
      configuration: 'The runtime or selected model needs attention.',
      quota_exhausted:
        'Antigravity usage limit reached. The queue resumes automatically 5 hours and 1 minute after detection. Pause queue cancels the scheduled resume.',
      provider:
        'The provider could not finish the request. Check the connection and account quota.',
      timeout: 'The provider timed out.',
      process_exit:
        'The transcription engine exited. Check the runtime and retry.',
      cancelled: 'Sign-in cancelled.',
    };
    el('connection-state').textContent = !r.runtimeInstalled
      ? 'Install the Antigravity runtime on this VM to connect.'
      : r.error
        ? errors[r.error] || `Connection needs attention: ${r.error}`
        : r.connected
          ? 'Connected to Google.'
          : r.state === 'authenticating'
            ? 'Waiting for Google sign-in…'
            : 'Runtime installed. Connect your Google account.';
    el('auth-instructions').hidden = !r.authUrl;
    if (r.authUrl) {
      el('auth-link').href = r.authUrl;
      el('auth-tunnel').textContent =
        `ssh -N -L ${r.authPort}:127.0.0.1:${r.authPort} USER@VM`;
    }
    if (!settingsDirty && document.activeElement !== el('model')) {
      el('model').replaceChildren();
      for (const model of r.models.length
        ? r.models
        : [snapshot.settings.model]) {
        const option = node('option', model);
        option.value = model;
        el('model').append(option);
      }
      el('model').value = snapshot.settings.model;
      if (!el('model').value && r.models.length)
        el('model').value = r.models[0];
    }
    el('save-settings').disabled = !r.models.length;
    if (!settingsDirty && document.activeElement !== el('notes-enabled'))
      el('notes-enabled').checked = snapshot.settings.notes_enabled;
    el('selected-count').textContent = snapshot.targets.filter(
      (t) => t.enabled,
    ).length;
    const count = (status) =>
      snapshot.totals.find((t) => t.status === status)?.count || 0;
    el('queued-count').textContent = count('queued');
    el('completed-count').textContent = count('completed');
    el('audio-size').textContent =
      ((r.scratchBytes + r.conversationBytes) / 1048576).toFixed(1) + ' MB';
    if (
      !(
        el('targets').contains(document.activeElement) &&
        document.activeElement?.tagName === 'INPUT'
      )
    )
      renderTargets();
    renderJobs();
    el('scan').disabled =
      !r.connected ||
      r.state === 'authenticating' ||
      settingsDirty ||
      !r.models.includes(snapshot.settings.model) ||
      !snapshot.targets.some(
        (t) => t.enabled && t.imported < t.recording_limit,
      );
    void loadDirectory();
  } catch (error) {
    if (!el('workspace').hidden) notice(error.message);
  } finally {
    refreshing = false;
  }
}
function renderTargets() {
  el('targets').replaceChildren();
  if (!snapshot.targets.length)
    el('targets').append(
      node(
        'p',
        'No sources selected yet. Start with one teacher or series.',
        'empty',
      ),
    );
  for (const target of snapshot.targets) {
    const row = node('div', undefined, 'target');
    const title = node('div', undefined, 'target-title');
    title.append(
      node('strong', target.name),
      node(
        'p',
        `${target.kind === 'teacher' ? 'Teacher' : 'Series'}${target.teacher_filter ? ' · ' + (directory?.teachers.find((t) => t.id === target.teacher_filter)?.name || 'Teacher ' + target.teacher_filter) : ''} · ${target.imported} / ${target.recording_limit} imported${target.enabled ? '' : ' · Paused'}${target.error ? ' · Scan failed; retry import' : ''}`,
      ),
    );
    const limit = node('input');
    limit.type = 'number';
    limit.min = '1';
    limit.max = '10000';
    limit.value = target.recording_limit;
    limit.setAttribute('aria-label', 'Recording budget for ' + target.name);
    const save = (enabled) =>
      act('targets', {
        kind: target.kind,
        upstreamId: target.upstream_id,
        limit: Number(limit.value),
        enabled,
        teacherId: target.teacher_filter || undefined,
      });
    row.append(
      title,
      limit,
      button('Save budget', () => save(target.enabled)),
      button(target.enabled ? 'Pause selection' : 'Enable selection', () =>
        save(!target.enabled),
      ),
    );
    el('targets').append(row);
  }
}
function renderJobs() {
  el('jobs').replaceChildren();
  el('queue-empty').hidden = Boolean(snapshot.jobs.length);
  for (const job of snapshot.jobs) {
    const row = node('tr');
    const title = node('td');
    title.append(
      node('strong', job.title),
      node('small', `${job.teacher} · #${job.shiur_id}`),
    );
    const transcription = node(
      'td',
      job.status === 'queued' && !job.eligible
        ? 'Source not enabled'
        : names[job.status] || job.status,
    );
    if (job.error)
      transcription.append(node('small', job.error.code || 'Attempt failed'));
    if (job.chunks)
      transcription.append(node('small', `${job.chunks} saved chunks`));
    const notes = node(
      'td',
      job.notes_status
        ? names[job.notes_status] || job.notes_status
        : snapshot.settings.notes_enabled
          ? 'After transcription'
          : 'Not requested',
    );
    if (job.notes_error) notes.append(node('small', job.notes_error));
    const actions = node('td');
    if (job.status === 'completed')
      actions.append(button('Read', () => show(job.shiur_id)));
    if (['failed', 'cancelled'].includes(job.status))
      actions.append(
        button('Retry transcription', () =>
          act('jobs', { id: job.id, action: 'retry', kind: 'transcription' }),
        ),
      );
    if (!['completed', 'cancelled'].includes(job.status))
      actions.append(
        button('Cancel', () =>
          act('jobs', { id: job.id, action: 'cancel', kind: 'transcription' }),
        ),
      );
    if (['failed', 'cancelled'].includes(job.notes_status))
      actions.append(
        button('Retry notes', () =>
          act('jobs', { id: job.notes_id, action: 'retry', kind: 'notes' }),
        ),
      );
    row.append(title, transcription, notes, actions);
    el('jobs').append(row);
  }
}
async function show(id) {
  try {
    viewed = await api('content?id=' + encodeURIComponent(id));
    viewingNotes = false;
    el('content-title').textContent = viewed.title;
    content();
    el('content-dialog').showModal();
  } catch (error) {
    notice(error.message);
  }
}
function timestamp(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)
    .toString()
    .padStart(
      2,
      '0',
    )}:${Math.floor(s / 60) % 60 < 10 ? '0' : ''}${Math.floor(s / 60) % 60}:${(s % 60).toString().padStart(2, '0')}`;
}
function content() {
  el('content-text').textContent = viewingNotes
    ? viewed.notes?.markdown || 'Study notes are not completed yet.'
    : viewed.segments
        .map(
          (s) =>
            `[${timestamp(s.startMs)}] ${s.speaker ? s.speaker + ': ' : ''}${s.text}`,
        )
        .join('\n\n');
  el('download-content').disabled = viewingNotes && !viewed.notes?.markdown;
}
el('connect').addEventListener('click', () =>
  act('auth', { interactive: true }),
);
el('check').addEventListener('click', () =>
  act('auth', { interactive: false }),
);
el('cancel-auth').addEventListener('click', () => act('auth-cancel'));
el('start').addEventListener('click', () => act('start'));
el('stop').addEventListener('click', () => act('stop'));
el('scan').addEventListener('click', () => act('scan'));
el('refresh').addEventListener('click', refresh);
el('model').addEventListener('change', () => {
  settingsDirty = true;
});
el('notes-enabled').addEventListener('change', () => {
  settingsDirty = true;
});
el('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await act('settings', {
    model: el('model').value,
    notes_enabled: el('notes-enabled').checked,
    worker_enabled: snapshot.settings.worker_enabled,
  });
  if (result) {
    settingsDirty = false;
    await refresh();
  }
});
el('source-search').addEventListener('input', () => {
  chosen = undefined;
  el('add-selection').disabled = true;
  el('chosen-source').textContent = 'Select a source from the results.';
  choices();
});
for (const radio of document.querySelectorAll('input[name=kind]'))
  radio.addEventListener('change', () => {
    chosen = undefined;
    el('series-teacher-field').hidden = currentKind() !== 'series';
    el('source-search').value = '';
    el('choices').replaceChildren();
    el('chosen-source').textContent = 'Select a source from the results.';
    el('add-selection').disabled = true;
  });
el('target-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!chosen) return;
  await act('targets', {
    kind: chosen.kind,
    upstreamId: chosen.id,
    limit: Number(el('recording-limit').value),
    enabled: true,
    teacherId:
      chosen.kind === 'series'
        ? el('series-teacher').value || undefined
        : undefined,
  });
});
el('close-dialog').addEventListener('click', () =>
  el('content-dialog').close(),
);
el('show-transcript').addEventListener('click', () => {
  viewingNotes = false;
  content();
});
el('show-notes').addEventListener('click', () => {
  viewingNotes = true;
  content();
});
el('download-content').addEventListener('click', () => {
  const url = URL.createObjectURL(
    new Blob([el('content-text').textContent], {
      type: 'text/plain;charset=utf-8',
    }),
  );
  const a = node('a');
  a.href = url;
  a.download = `shiur-${viewed.id}-${viewingNotes ? 'notes.md' : 'transcript.txt'}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
void refresh();
setInterval(() => {
  if (!el('workspace').hidden) void refresh();
}, 3000);
