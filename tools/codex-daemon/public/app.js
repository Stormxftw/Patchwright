const state = {
  filter: 'all',
  selectedRunId: null,
  outputMode: 'events',
  runs: []
};

const elements = {
  connection: document.querySelector('#connection'),
  lastTick: document.querySelector('#lastTick'),
  activeWorkers: document.querySelector('#activeWorkers'),
  currentErrors: document.querySelector('#currentErrors'),
  totalRuns: document.querySelector('#totalRuns'),
  latestEvent: document.querySelector('#latestEvent'),
  timeline: document.querySelector('#timeline'),
  workerList: document.querySelector('#workerList'),
  output: document.querySelector('#output'),
  selectedRunLabel: document.querySelector('#selectedRunLabel')
};

function formatTime(value) {
  if (!value) {
    return 'Waiting';
  }
  return new Intl.DateTimeFormat([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value));
}

function relativeAge(value) {
  if (!value) {
    return '';
  }
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  return `${Math.round(minutes / 60)}h ago`;
}

function elapsed(startedAt, endedAt) {
  if (!startedAt) {
    return '-';
  }
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const totalSeconds = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function statusClass(status) {
  const normalized = String(status ?? '').toLowerCase();
  if (normalized.includes('running') || normalized.includes('verifying') || normalized.includes('changes')) {
    return 'running';
  }
  if (normalized.includes('failed') || normalized.includes('blocked')) {
    return 'failed';
  }
  return '';
}

function visibleRuns() {
  if (state.filter === 'active') {
    return state.runs.filter((run) => run.active);
  }
  if (state.filter === 'done') {
    return state.runs.filter((run) => !run.active);
  }
  return state.runs;
}

function renderStats(snapshot) {
  elements.lastTick.textContent = snapshot.daemon.latestTickAt
    ? `${formatTime(snapshot.daemon.latestTickAt)} (${relativeAge(snapshot.daemon.latestTickAt)})`
    : 'Waiting';
  elements.activeWorkers.textContent = String(snapshot.daemon.activeRunCount);
  elements.currentErrors.textContent = String(snapshot.daemon.currentErrorCount ?? 0);
  elements.totalRuns.textContent = String(snapshot.daemon.totalRunCount);
  elements.latestEvent.textContent = snapshot.daemon.latestEvent;
}

function renderTimeline(events) {
  elements.timeline.innerHTML = events
    .map((event) => {
      const kind = event.recovered
        ? 'recovered'
        : event.type?.includes('error') || event.type === 'fatal_error'
        ? 'error'
        : event.type === 'draft_pr_opened' || event.type === 'codex_finished'
          ? 'done'
          : '';
      return `
        <li class="timeline-item ${kind}">
          <div class="timeline-time">${escapeHtml(formatTime(event.timestamp))}</div>
          <div class="timeline-label">${escapeHtml(event.label)}</div>
        </li>
      `;
    })
    .join('');
}

function commandChips(run) {
  const verification = new Map((run.verification ?? []).map((item) => [item.command, item.exitCode]));
  const commands = run.validationCommands?.length ? run.validationCommands : ['fallback verification'];
  return commands
    .map((command) => {
      const exitCode = verification.get(command);
      const passClass = exitCode === 0 ? ' pass' : '';
      const suffix = Number.isInteger(exitCode) ? ` exit ${exitCode}` : '';
      return `<span class="chip${passClass}">${escapeHtml(command)}${escapeHtml(suffix)}</span>`;
    })
    .join('');
}

function renderWorkers() {
  const runs = visibleRuns();
  if (!runs.length) {
    elements.workerList.innerHTML = '<div class="empty-state">No runs match this view yet.</div>';
    return;
  }

  if (!state.selectedRunId && runs[0]) {
    state.selectedRunId = runs[0].runId;
    loadRunOutput(state.selectedRunId);
  }

  elements.workerList.innerHTML = runs
    .map((run) => {
      const issue = run.issueNumber ? `#${run.issueNumber}` : 'Unassigned';
      const changedCount = run.changedFiles?.length ?? 0;
      const selected = run.runId === state.selectedRunId ? ' selected' : '';
      const active = run.active ? ' active-run' : '';
      return `
        <article class="worker-card${active}${selected}" data-run-id="${escapeHtml(run.runId)}">
          <div class="worker-main">
            <div>
              <span class="issue">${escapeHtml(issue)}</span>
              <span class="status ${statusClass(run.status)}">${escapeHtml(run.status ?? 'recorded')}</span>
            </div>
            <div class="worker-meta">${escapeHtml(run.workerRole ?? 'worker')}<br>${escapeHtml(relativeAge(run.updatedAt))}</div>
          </div>
          <div class="worker-grid">
            <div class="worker-field"><span>Packet</span><strong>${escapeHtml(run.packetStatus ?? '-')}</strong></div>
            <div class="worker-field"><span>Branch</span><strong>${escapeHtml(run.branch ?? '-')}</strong></div>
            <div class="worker-field"><span>Elapsed</span><strong>${escapeHtml(elapsed(run.startedAt, run.completedAt))}</strong></div>
            <div class="worker-field"><span>Exit</span><strong>${escapeHtml(run.exitCode ?? '-')}</strong></div>
          </div>
          <div class="chips">${commandChips(run)}</div>
          <div class="worker-footer">
            <div>${changedCount} changed file${changedCount === 1 ? '' : 's'}</div>
            <div>${run.prUrl ? `<a href="${escapeHtml(run.prUrl)}" target="_blank" rel="noreferrer">Open PR</a>` : escapeHtml(run.runId)}</div>
          </div>
        </article>
      `;
    })
    .join('');
}

function renderSnapshot(snapshot) {
  state.runs = snapshot.runs;
  if (state.selectedRunId && !state.runs.some((run) => run.runId === state.selectedRunId)) {
    state.selectedRunId = state.runs[0]?.runId ?? null;
  }
  renderStats(snapshot);
  renderTimeline(snapshot.recentEvents);
  renderWorkers();
}

function formatOutputEvent(event) {
  const prefix = event.item?.id ? `[${event.item.id}] ` : '';
  if (event.item?.type === 'command_execution') {
    const exit = Number.isInteger(event.item.exit_code) ? ` exit ${event.item.exit_code}` : '';
    const output = event.item.aggregated_output ? `\n${event.item.aggregated_output}` : '';
    return `${prefix}${event.item.command ?? 'command'} ${event.item.status ?? ''}${exit}${output}`.trim();
  }
  if (event.item?.type === 'agent_message') {
    return `${prefix}${event.item.text ?? ''}`.trim();
  }
  return `${prefix}${event.type ?? ''}`.trim();
}

async function loadRunOutput(runId) {
  if (!runId) {
    elements.output.textContent = 'Select a worker to inspect its live output.';
    elements.selectedRunLabel.textContent = 'Select a worker';
    return;
  }

  const response = await fetch(`/api/run?id=${encodeURIComponent(runId)}`);
  const data = await response.json();
  const run = state.runs.find((item) => item.runId === runId);
  elements.selectedRunLabel.textContent = run?.issueNumber ? `Issue #${run.issueNumber}` : runId;
  elements.output.textContent =
    state.outputMode === 'final'
      ? data.finalMessage || 'No final message recorded yet.'
      : data.events.map(formatOutputEvent).join('\n\n') || 'No worker event stream recorded yet.';
}

function connectStream() {
  const source = new EventSource('/api/events');
  source.addEventListener('open', () => {
    elements.connection.textContent = 'Live';
    elements.connection.className = 'connection live';
  });
  source.addEventListener('snapshot', (event) => {
    renderSnapshot(JSON.parse(event.data));
    if (state.selectedRunId) {
      loadRunOutput(state.selectedRunId).catch(() => {});
    }
  });
  source.addEventListener('error', () => {
    elements.connection.textContent = 'Reconnecting';
    elements.connection.className = 'connection error';
  });
}

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab === button));
    renderWorkers();
  });
});

document.querySelectorAll('.output-tab').forEach((button) => {
  button.addEventListener('click', () => {
    state.outputMode = button.dataset.output;
    document.querySelectorAll('.output-tab').forEach((tab) => tab.classList.toggle('active', tab === button));
    loadRunOutput(state.selectedRunId).catch(() => {});
  });
});

elements.workerList.addEventListener('click', (event) => {
  const card = event.target.closest('.worker-card');
  if (!card) {
    return;
  }
  state.selectedRunId = card.dataset.runId;
  renderWorkers();
  loadRunOutput(state.selectedRunId).catch(() => {});
});

document.querySelector('#refreshButton').addEventListener('click', async () => {
  const response = await fetch('/api/status');
  renderSnapshot(await response.json());
  await loadRunOutput(state.selectedRunId);
});

connectStream();
