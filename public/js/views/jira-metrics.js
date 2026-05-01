import { getData, saveData, jiraSearch, uid, CUSTOM_FIELDS } from '../api.js';
import { renderDoughnut, renderIssueTable, renderRollupTable, groupIssuesBy, DEFAULT_COLUMNS, escHtml } from '../charts.js';
import { makeSortable } from '../drag-sort.js';

const PAGE_SIZE = 50;

const GROUP_BY_LABELS = {
  'assignee':    'Assignee',
  'qa-engineer': 'QA Engineer',
  'status':      'Status',
  'priority':    'Priority',
  'issuetype':   'Issue Type',
};

let state = {
  queries:         [],
  runtime:         {},        // { [queryId]: { lastRun, lastCount } }
  editingQueryId:  null,
  jiraBaseUrl:     null,
  pagination:      {},        // { [queryId]: { pageTokens: [''] } }
  issueCache:      {},        // { [queryId]: issue[] }
  jiraFields:      null,      // cached from GET /api/jira/field (null = not yet fetched / failed)
  formColumns:     [],        // working column list while form is open
  dashboardLayout: { columns: [[], [], []] },
  gridColumns:     3,         // 1 | 2 | 3
  layoutEditMode:  false,
  layoutSnapshot:  null,      // { columns: deep copy, gridColumns: number }
  queriesExpanded: false,     // saved-queries panel collapse state
};

// ── Drag state (module-level) ─────────────────────────────────────────────────

let dragSrcId = null;  // dashboard card drag

// ── Layout migration ──────────────────────────────────────────────────────────

/** Accepts saved settings and returns a normalised { columns: [[], [], []] } object. */
function migrateLayout(saved) {
  if (!saved) return { columns: [[], [], []] };
  if (Array.isArray(saved.columns)) {
    // New format — pad to 3 columns if needed
    while (saved.columns.length < 3) saved.columns.push([]);
    return { columns: saved.columns };
  }
  // Old format { left: [], right: [] }
  return { columns: [saved.left || [], saved.right || [], []] };
}

// ── Render ────────────────────────────────────────────────────────────────────

export function render() {
  return `
    <div class="page-header flex-between">
      <div>
        <div class="page-title">JIRA Metrics</div>
        <div class="page-subtitle">Save JQL queries and run them against your JIRA project</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <button class="btn btn-secondary btn-sm" id="btn-refresh-all">↻ Refresh All</button>
        <button class="btn btn-secondary btn-sm" id="btn-edit-layout">Edit Layout</button>
        <div id="layout-col-selector" style="display:none;align-items:center;gap:4px;">
          <span style="font-size:11px;color:var(--text-muted);white-space:nowrap;">Columns:</span>
          <button class="btn btn-secondary btn-sm" id="btn-cols-1">1</button>
          <button class="btn btn-secondary btn-sm" id="btn-cols-2">2</button>
          <button class="btn btn-secondary btn-sm" id="btn-cols-3">3</button>
        </div>
        <button class="btn btn-primary btn-sm"   id="btn-save-layout"   style="display:none;">Save Layout</button>
        <button class="btn btn-secondary btn-sm" id="btn-cancel-layout" style="display:none;">Cancel</button>
      </div>
    </div>

    <div id="jira-alert"></div>

    <div class="card" style="margin-bottom:16px;">
      <div style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border);">
        <span style="font-size:12px;font-weight:600;white-space:nowrap;">Jira Base URL</span>
        <span id="jira-url-display" style="font-size:12px;color:var(--text-muted);flex:1;"></span>
        <span style="font-size:11px;color:var(--text-muted);">Used for issue links. API connection configured in .env.</span>
        <button class="btn btn-secondary btn-sm" id="btn-edit-jira-url">Edit</button>
      </div>
      <div id="jira-url-edit" style="display:none;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--border);">
        <input class="form-input" id="jira-url-input" placeholder="https://yourcompany.atlassian.net" style="flex:1;font-size:12px;" />
        <button class="btn btn-primary btn-sm" id="btn-save-jira-url">Save</button>
        <button class="btn btn-secondary btn-sm" id="btn-cancel-jira-url">Cancel</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px;">
      <div class="card-header">
        <button class="card-title-toggle" id="btn-toggle-queries">
          <span id="queries-chevron">▶</span> Saved Queries <span id="queries-count"></span>
        </button>
        <button class="btn btn-primary btn-sm" id="btn-new-query">+ New Query</button>
      </div>

      <div id="query-form" style="display:none;" class="form-panel">
        <div class="form-panel-title" id="form-panel-title">New Query</div>
        <div class="form-row form-row-2">
          <div class="form-group">
            <label class="form-label">Name</label>
            <input class="form-input" id="q-name" placeholder="e.g. My Open Issues" />
          </div>
          <div class="form-group">
            <label class="form-label">Description (optional)</label>
            <input class="form-input" id="q-desc" placeholder="What does this query track?" />
          </div>
        </div>
        <div class="form-group" style="margin-bottom:12px;">
          <label class="form-label">JQL</label>
          <textarea class="form-textarea" id="q-jql" style="min-height:80px;font-family:monospace;font-size:12px;"></textarea>
          <div class="form-hint">Paste any valid JQL from JIRA saved filters.</div>
        </div>
        <div class="form-row form-row-2">
          <div class="form-group">
            <label class="form-label">Display As</label>
            <select class="form-select" id="q-display-type">
              <option value="pie">Pie Chart</option>
              <option value="rollup">Rollup</option>
              <option value="table">Table</option>
            </select>
          </div>
          <div class="form-group" id="group-by-group" style="display:none;">
            <label class="form-label">Group By</label>
            <select class="form-select" id="q-group-by">
              <option value="assignee">Assignee</option>
              <option value="issuetype">Issue Type</option>
              <option value="priority">Priority</option>
              <option value="qa-engineer">QA Engineer</option>
              <option value="status">Status</option>
            </select>
          </div>
        </div>
        <div id="rollup-config-group" style="display:none;margin-bottom:16px;">
          <div class="form-row form-row-2" style="margin-bottom:12px;">
            <div class="form-group">
              <label class="form-label">Primary Group Field</label>
              <select class="form-select" id="q-rollup-primary-field"><option value="">Select field…</option></select>
            </div>
            <div class="form-group">
              <label class="form-label">Primary Sort</label>
              <select class="form-select" id="q-rollup-primary-sort">
                <option value="alpha-asc">A → Z</option>
                <option value="alpha-desc">Z → A</option>
                <option value="sum-asc">Sum ↑ (low first)</option>
                <option value="sum-desc">Sum ↓ (high first)</option>
              </select>
            </div>
          </div>
          <div class="form-row form-row-2" style="margin-bottom:12px;">
            <div class="form-group">
              <label class="form-label">Secondary Group Field</label>
              <select class="form-select" id="q-rollup-secondary-field"><option value="">— None —</option></select>
            </div>
            <div class="form-group">
              <label class="form-label">Secondary Interval</label>
              <select class="form-select" id="q-rollup-secondary-interval">
                <option value="raw">Raw Value</option>
                <option value="week">Group by Week</option>
                <option value="month">Group by Month</option>
              </select>
            </div>
          </div>
          <div class="form-row form-row-2" style="margin-bottom:12px;">
            <div class="form-group">
              <label class="form-label">Secondary Sort</label>
              <select class="form-select" id="q-rollup-secondary-sort">
                <option value="alpha-asc">A → Z</option>
                <option value="alpha-desc">Z → A</option>
                <option value="sum-asc">Sum ↑ (low first)</option>
                <option value="sum-desc">Sum ↓ (high first)</option>
              </select>
            </div>
            <div class="form-group" id="q-rollup-weekstart-group" style="display:none;">
              <label class="form-label">Week starts on</label>
              <select class="form-select" id="q-rollup-weekstart">
                <option value="sunday">Sunday</option>
                <option value="monday">Monday</option>
              </select>
            </div>
          </div>
          <div class="form-row form-row-2">
            <div class="form-group">
              <label class="form-label">Sum Field</label>
              <select class="form-select" id="q-rollup-sum-field"><option value="">Select field…</option></select>
            </div>
            <div class="form-group" style="display:flex;align-items:center;gap:8px;padding-top:22px;">
              <input type="checkbox" id="q-rollup-hours" style="width:16px;height:16px;cursor:pointer;" />
              <label for="q-rollup-hours" class="form-label" style="margin:0;cursor:pointer;">Display as hours</label>
            </div>
          </div>
        </div>
        <div id="columns-config-group" class="form-group" style="margin-bottom:16px;">
          <label class="form-label">Columns to display</label>
          <div id="columns-sortable-list" class="columns-sortable-list"></div>
          <div class="form-hint">
            Drag to reorder.
            <span id="columns-fields-error" style="display:none;margin-left:4px;color:var(--text-muted);">
              <span id="fields-error-msg"></span>(field list may be incomplete — JIRA field API requires admin access)
            </span>
          </div>
          <select class="form-select" id="q-add-column" style="margin-top:8px;font-size:12px;">
            <option value="">Add column…</option>
          </select>
        </div>
        <div class="form-actions">
          <button class="btn btn-secondary btn-sm" id="btn-cancel-query">Cancel</button>
          <button class="btn btn-primary btn-sm"   id="btn-save-query">Save Query</button>
        </div>
      </div>

      <div id="query-list" style="display:none;"></div>
    </div>

    <div class="dashboard-grid" id="query-results-list">
      <div class="dashboard-col" id="dashboard-col-0"></div>
      <div class="dashboard-col" id="dashboard-col-1"></div>
      <div class="dashboard-col" id="dashboard-col-2"></div>
    </div>
  `;
}

// ── Init ──────────────────────────────────────────────────────────────────────

export async function init() {
  const [queries, runtime, config, settings] = await Promise.all([
    getData('jql-queries'),
    getData('runtime'),
    fetch('/api/config/status').then(r => r.json()),
    getData('jira-settings'),
  ]);
  state.queries        = queries || [];
  state.runtime        = runtime || {};
  state.jiraBaseUrl    = settings?.baseUrl || config.jiraBaseUrl;
  state.dashboardLayout = migrateLayout(settings?.dashboardLayout);
  state.gridColumns    = settings?.gridColumns || 3;

  renderQueryList();
  renderAllResultCards();
  applyGridColumns(state.gridColumns);
  bindFormEvents();
  bindUrlConfigEvents();
  bindLayoutEditEvents();
  document.getElementById('btn-refresh-all')?.addEventListener('click', runAllQueries);

  runAllQueries();
}

// ── Query List ────────────────────────────────────────────────────────────────

function renderQueryList() {
  const el = document.getElementById('query-list');
  if (!el) return;

  // Update toggle count
  const countEl = document.getElementById('queries-count');
  if (countEl) countEl.textContent = `(${state.queries.length})`;

  if (state.queries.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title">No saved queries</div>
        <div class="empty-state-desc">Click "+ New Query" to add your first JQL query.</div>
      </div>`;
  } else {
    const sorted = [...state.queries].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    el.innerHTML = `<div class="query-list">${sorted.map(queryItemHtml).join('')}</div>`;
    sorted.forEach(q => {
      document.getElementById(`edit-${q.id}`)?.addEventListener('click', () => openEditForm(q));
      document.getElementById(`del-${q.id}`)?.addEventListener('click',  () => deleteQuery(q.id));
    });
  }

  updateQueryListVisibility();
}

function queryItemHtml(q) {
  const rt      = state.runtime[q.id];
  const lastRun = rt?.lastRun
    ? `Last run: ${new Date(rt.lastRun).toLocaleDateString()} · ${rt.lastCount ?? '?'} issues`
    : 'Never run';
  const typeBadge = q.displayType === 'pie'
    ? `<span class="badge badge-blue"   style="font-size:10px;">Pie · ${q.groupBy || 'assignee'}</span>`
    : q.displayType === 'rollup'
    ? `<span class="badge badge-orange" style="font-size:10px;">Rollup</span>`
    : `<span class="badge badge-gray"   style="font-size:10px;">Table</span>`;

  return `
    <div class="query-item" id="query-item-${q.id}">
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;">
          <span class="query-item-name">${escHtml(q.name)}</span>
          ${typeBadge}
        </div>
        ${q.description ? `<div class="query-item-meta">${escHtml(q.description)}</div>` : ''}
        <div class="query-item-meta" id="lastrun-${q.id}">${lastRun}</div>
      </div>
      <div class="query-item-actions">
        <button class="btn btn-secondary btn-sm" id="edit-${q.id}">Edit</button>
        <button class="btn btn-danger btn-sm"    id="del-${q.id}">Delete</button>
      </div>
    </div>`;
}

// ── Result Cards ──────────────────────────────────────────────────────────────

function renderAllResultCards() {
  if (state.queries.length === 0) {
    for (let i = 0; i < 3; i++) {
      const col = document.getElementById(`dashboard-col-${i}`);
      if (col) col.innerHTML = '';
    }
    return;
  }

  syncLayoutWithQueries();

  const cardHtml = q => {
    const jiraSearchUrl = (state.jiraBaseUrl && q.jql)
      ? `${state.jiraBaseUrl}/issues/?jql=${encodeURIComponent(q.jql)}`
      : null;
    const titleEl = jiraSearchUrl
      ? `<a class="card-title table-link" href="${jiraSearchUrl}" target="_blank" draggable="false" title="Open in JIRA">${escHtml(q.name)}</a>`
      : `<span class="card-title">${escHtml(q.name)}</span>`;
    return `
    <div class="card result-card" id="result-card-${q.id}" data-query-id="${q.id}">
      <div class="card-header">
        ${titleEl}
        <button class="btn btn-secondary btn-sm" id="btn-refresh-${q.id}">↻ Refresh</button>
      </div>
      <div id="results-body-${q.id}">
        <div class="loading-state">Loading...</div>
      </div>
      <div class="pagination" id="results-pagination-${q.id}" style="display:none;">
        <span class="pagination-info" id="pagination-info-${q.id}"></span>
        <button class="btn btn-secondary btn-sm" id="btn-prev-${q.id}">Prev</button>
        <button class="btn btn-secondary btn-sm" id="btn-next-${q.id}">Next</button>
      </div>
    </div>`;
  };

  const cardMap = {};
  state.queries.forEach(q => { cardMap[q.id] = cardHtml(q); });

  for (let i = 0; i < 3; i++) {
    const col = document.getElementById(`dashboard-col-${i}`);
    if (!col) continue;
    col.innerHTML = (state.dashboardLayout.columns[i] || [])
      .filter(id => cardMap[id])
      .map(id => cardMap[id])
      .join('');
  }

  state.queries.forEach(q => {
    document.getElementById(`btn-refresh-${q.id}`)?.addEventListener('click', () => runQuery(q));
  });
}

/** Move existing card DOM nodes into the correct columns without destroying content. */
function renderCardColumns() {
  const cards = {};
  document.querySelectorAll('.result-card').forEach(card => {
    cards[card.dataset.queryId] = card;
  });

  for (let i = 0; i < 3; i++) {
    const col = document.getElementById(`dashboard-col-${i}`);
    if (!col) continue;
    (state.dashboardLayout.columns[i] || []).forEach(id => {
      if (cards[id]) col.appendChild(cards[id]);
    });
  }
}

async function runAllQueries() {
  await Promise.all(state.queries.map(q => runQuery(q)));
}

// ── Form ──────────────────────────────────────────────────────────────────────

function bindFormEvents() {
  document.getElementById('btn-toggle-queries')?.addEventListener('click', () => {
    state.queriesExpanded = !state.queriesExpanded;
    updateQueryListVisibility();
  });

  document.getElementById('btn-new-query')?.addEventListener('click', () => {
    // Auto-expand the queries panel when opening the form
    if (!state.queriesExpanded) {
      state.queriesExpanded = true;
      updateQueryListVisibility();
    }
    state.editingQueryId = null;
    document.getElementById('form-panel-title').textContent = 'New Query';
    document.getElementById('btn-save-query').textContent   = 'Save Query';
    resetFormFields();
    document.getElementById('query-form').style.display = 'block';
    loadJiraFieldsAndRefreshDropdown();
  });

  document.getElementById('btn-cancel-query')?.addEventListener('click', resetForm);
  document.getElementById('btn-save-query')?.addEventListener('click',  saveQuery);

  document.getElementById('q-display-type')?.addEventListener('change', e => {
    const type = e.target.value;
    document.getElementById('group-by-group').style.display       = type === 'pie'    ? 'flex'  : 'none';
    document.getElementById('columns-config-group').style.display = type === 'table'  ? 'block' : 'none';
    document.getElementById('rollup-config-group').style.display  = type === 'rollup' ? 'block' : 'none';
    if (type === 'table') {
      if (!state.formColumns.length) state.formColumns = [...DEFAULT_COLUMNS];
      renderFormColumnList();
      loadJiraFieldsAndRefreshDropdown();
    } else if (type === 'rollup') {
      loadJiraFieldsAndPopulateRollupSelects();
    }
  });

  document.getElementById('q-rollup-secondary-interval')?.addEventListener('change', e => {
    updateRollupSecondarySortOptions(e.target.value);
    const wsg = document.getElementById('q-rollup-weekstart-group');
    if (wsg) wsg.style.display = e.target.value === 'week' ? '' : 'none';
  });

  document.getElementById('q-add-column')?.addEventListener('change', e => {
    const select = e.target;
    const opt    = select.selectedOptions[0];
    if (!opt?.value) return;
    state.formColumns.push({ id: opt.value, name: opt.dataset.name, schemaType: opt.dataset.type });
    renderFormColumnList();
    refreshAddColumnDropdown();
    select.value = '';
  });
}

function openEditForm(query) {
  state.editingQueryId = query.id;
  document.getElementById('form-panel-title').textContent = 'Edit Query';
  document.getElementById('btn-save-query').textContent   = 'Update Query';

  document.getElementById('q-name').value         = query.name;
  document.getElementById('q-desc').value         = query.description || '';
  document.getElementById('q-jql').value          = query.jql;
  document.getElementById('q-display-type').value = query.displayType || 'table';
  document.getElementById('q-group-by').value     = query.groupBy    || 'assignee';

  const displayType = query.displayType || 'table';
  document.getElementById('group-by-group').style.display       = displayType === 'pie'    ? 'flex'  : 'none';
  document.getElementById('columns-config-group').style.display = displayType === 'table'  ? 'block' : 'none';
  document.getElementById('rollup-config-group').style.display  = displayType === 'rollup' ? 'block' : 'none';

  if (displayType === 'table') {
    state.formColumns = query.columns ? [...query.columns] : [...DEFAULT_COLUMNS];
    renderFormColumnList();
    loadJiraFieldsAndRefreshDropdown();
  } else if (displayType === 'rollup') {
    state.formColumns = [...DEFAULT_COLUMNS];
    loadJiraFieldsAndPopulateRollupSelects().then(() => {
      const cfg = query.rollupConfig || {};
      const sel = id => document.getElementById(id);
      if (sel('q-rollup-primary-field'))      sel('q-rollup-primary-field').value      = cfg.primaryGroup           || '';
      if (sel('q-rollup-secondary-field'))    sel('q-rollup-secondary-field').value    = cfg.secondaryGroup          || '';
      if (sel('q-rollup-sum-field'))          sel('q-rollup-sum-field').value          = cfg.sumField               || '';
      if (sel('q-rollup-primary-sort'))       sel('q-rollup-primary-sort').value       = cfg.primarySort            || 'alpha-asc';
      if (sel('q-rollup-hours'))              sel('q-rollup-hours').checked            = cfg.displayAsHours         || false;
      if (sel('q-rollup-secondary-interval')) sel('q-rollup-secondary-interval').value = cfg.secondaryGroupInterval || 'raw';
      if (sel('q-rollup-weekstart'))          sel('q-rollup-weekstart').value          = cfg.weekStart              || 'sunday';
      // Update sort options to match the restored interval, then set the saved sort value
      updateRollupSecondarySortOptions(cfg.secondaryGroupInterval || 'raw');
      if (sel('q-rollup-secondary-sort'))     sel('q-rollup-secondary-sort').value     = cfg.secondarySort          || 'alpha-asc';
      const wsg = sel('q-rollup-weekstart-group');
      if (wsg) wsg.style.display = (cfg.secondaryGroupInterval === 'week') ? '' : 'none';
    });
  } else {
    state.formColumns = [...DEFAULT_COLUMNS];
  }

  document.getElementById('query-form').style.display = 'block';
  document.getElementById('query-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function resetForm() {
  state.editingQueryId = null;
  document.getElementById('query-form').style.display = 'none';
  resetFormFields();
}

function resetFormFields() {
  ['q-name', 'q-desc', 'q-jql'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('q-display-type').value = 'table';
  document.getElementById('group-by-group').style.display       = 'none';
  document.getElementById('columns-config-group').style.display = 'block';
  document.getElementById('rollup-config-group').style.display  = 'none';
  // Reset rollup selects
  ['q-rollup-primary-field', 'q-rollup-secondary-field', 'q-rollup-sum-field'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const intervalEl = document.getElementById('q-rollup-secondary-interval');
  if (intervalEl) intervalEl.value = 'raw';
  updateRollupSecondarySortOptions('raw');
  const primarySortEl = document.getElementById('q-rollup-primary-sort');
  if (primarySortEl) primarySortEl.value = 'alpha-asc';
  const secSortEl = document.getElementById('q-rollup-secondary-sort');
  if (secSortEl) secSortEl.value = 'alpha-asc';
  const wsg = document.getElementById('q-rollup-weekstart-group');
  if (wsg) wsg.style.display = 'none';
  const wsEl = document.getElementById('q-rollup-weekstart');
  if (wsEl) wsEl.value = 'sunday';
  const hoursCb = document.getElementById('q-rollup-hours');
  if (hoursCb) hoursCb.checked = false;
  state.formColumns = [...DEFAULT_COLUMNS];
  renderFormColumnList();
  refreshAddColumnDropdown();
}

async function saveQuery() {
  const name        = document.getElementById('q-name').value.trim();
  const jql         = document.getElementById('q-jql').value.trim();
  const desc        = document.getElementById('q-desc').value.trim();
  const displayType = document.getElementById('q-display-type').value;
  const groupBy     = document.getElementById('q-group-by').value;

  if (!name || !jql) { showAlert('Name and JQL are required.', 'warn'); return; }

  const columns = displayType === 'table' ? [...state.formColumns] : undefined;

  let rollupConfig;
  if (displayType === 'rollup') {
    rollupConfig = {
      primaryGroup:            document.getElementById('q-rollup-primary-field').value,
      primarySort:             document.getElementById('q-rollup-primary-sort').value             || 'alpha-asc',
      secondaryGroup:          document.getElementById('q-rollup-secondary-field').value          || null,
      secondaryGroupInterval:  document.getElementById('q-rollup-secondary-interval').value       || 'raw',
      secondarySort:           document.getElementById('q-rollup-secondary-sort').value           || 'alpha-asc',
      weekStart:               document.getElementById('q-rollup-weekstart').value                || 'sunday',
      sumField:                document.getElementById('q-rollup-sum-field').value,
      displayAsHours:          document.getElementById('q-rollup-hours').checked,
    };
    if (!rollupConfig.secondaryGroup) rollupConfig.secondaryGroup = null;
    if (!rollupConfig.primaryGroup || !rollupConfig.sumField) {
      showAlert('Rollup requires a Primary Group Field and a Sum Field.', 'warn');
      return;
    }
  }

  const editingId = state.editingQueryId;

  if (editingId) {
    state.queries = state.queries.map(q => {
      if (q.id !== editingId) return q;
      const updated = { ...q, name, description: desc, jql, displayType, groupBy };
      if (displayType === 'table') {
        if (columns !== undefined) updated.columns = columns; else delete updated.columns;
        delete updated.rollupConfig;
      } else if (displayType === 'rollup') {
        updated.rollupConfig = rollupConfig;
        delete updated.columns;
      } else {
        delete updated.columns;
        delete updated.rollupConfig;
      }
      return updated;
    });
  } else {
    const newQuery = { id: uid(), name, description: desc, jql, displayType, groupBy, created: new Date().toISOString() };
    if (displayType === 'table' && columns)   newQuery.columns      = columns;
    if (displayType === 'rollup' && rollupConfig) newQuery.rollupConfig = rollupConfig;
    state.queries = [...state.queries, newQuery];
  }

  await saveData('jql-queries', state.queries);
  resetForm();
  renderQueryList();
  renderAllResultCards();
  applyGridColumns(state.gridColumns);

  // Restore cached results for queries already loaded
  state.queries.forEach(q => {
    if (q.displayType === 'pie' || !state.issueCache[q.id]) return;
    const el = document.getElementById(`results-body-${q.id}`);
    if (!el) return;
    if (q.displayType === 'rollup') {
      renderRollupTable(el, state.issueCache[q.id], q.rollupConfig || {});
    } else {
      renderIssueTable(el, state.issueCache[q.id], { jiraBaseUrl: state.jiraBaseUrl, columns: q.columns });
    }
  });

  const affected = editingId
    ? state.queries.find(q => q.id === editingId)
    : state.queries[state.queries.length - 1];
  if (affected) runQuery(affected);
}

async function deleteQuery(id) {
  if (!confirm('Delete this query?')) return;
  state.queries = state.queries.filter(q => q.id !== id);
  state.dashboardLayout.columns.forEach((col, i) => {
    state.dashboardLayout.columns[i] = col.filter(colId => colId !== id);
  });
  await Promise.all([saveData('jql-queries', state.queries), saveSettings()]);
  document.getElementById(`result-card-${id}`)?.remove();
  renderQueryList();
}

// ── Form — Column Config ──────────────────────────────────────────────────────

function renderFormColumnList() {
  const container = document.getElementById('columns-sortable-list');
  if (!container) return;

  const single = state.formColumns.length === 1;
  makeSortable(container, state.formColumns, {
    renderRow: (col, i) => `
      <span class="column-row-name">${escHtml(col.name)}</span>
      <button class="btn-icon remove-col" data-col-idx="${i}"
        ${single ? 'disabled' : ''} title="Remove column">✕</button>`,
    onReorder: newCols => {
      state.formColumns = newCols;
      renderFormColumnList();
      refreshAddColumnDropdown();
    },
  });

  container.querySelectorAll('.remove-col:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      state.formColumns.splice(parseInt(btn.dataset.colIdx, 10), 1);
      renderFormColumnList();
      refreshAddColumnDropdown();
    });
  });
}

// ── Query List Visibility ─────────────────────────────────────────────────────

function updateQueryListVisibility() {
  const list    = document.getElementById('query-list');
  const chevron = document.getElementById('queries-chevron');
  if (list)    list.style.display    = state.queriesExpanded ? 'block' : 'none';
  if (chevron) chevron.textContent   = state.queriesExpanded ? '▼' : '▶';
}

// ── Fields Error Helpers ──────────────────────────────────────────────────────

function showFieldsError() {
  const el = document.getElementById('columns-fields-error');
  if (!el) return;
  el.style.display = 'inline';
  if (lastFieldsError) {
    const msgEl = el.querySelector('#fields-error-msg');
    if (msgEl) msgEl.textContent = lastFieldsError + ' — ';
  }
}

function clearFieldsError() {
  const el = document.getElementById('columns-fields-error');
  if (el) el.style.display = 'none';
}

let lastFieldsError = '';

// Standard JIRA fields used as a fallback when /rest/api/3/field returns 403.
const KNOWN_FIELDS = [
  { id: 'summary',         name: 'Summary',           schema: { type: 'string' } },
  { id: 'status',          name: 'Status',             schema: { type: 'status' } },
  { id: 'priority',        name: 'Priority',           schema: { type: 'priority' } },
  { id: 'issuetype',       name: 'Issue Type',         schema: { type: 'issuetype' } },
  { id: 'assignee',        name: 'Assignee',           schema: { type: 'user' } },
  { id: 'reporter',        name: 'Reporter',           schema: { type: 'user' } },
  { id: 'created',         name: 'Created',            schema: { type: 'datetime' } },
  { id: 'updated',         name: 'Updated',            schema: { type: 'datetime' } },
  { id: 'duedate',         name: 'Due Date',           schema: { type: 'date' } },
  { id: 'resolutiondate',  name: 'Resolved',           schema: { type: 'datetime' } },
  { id: 'resolution',      name: 'Resolution',         schema: { type: 'string' } },
  { id: 'description',     name: 'Description',        schema: { type: 'string' } },
  { id: 'labels',          name: 'Labels',             schema: { type: 'array' } },
  { id: 'components',      name: 'Components',         schema: { type: 'array' } },
  { id: 'fixVersions',     name: 'Fix Versions',       schema: { type: 'array' } },
  { id: 'versions',        name: 'Affects Versions',   schema: { type: 'array' } },
  { id: 'timespent',       name: 'Time Spent',         schema: { type: 'number' } },
  { id: 'timeestimate',    name: 'Time Estimate',      schema: { type: 'number' } },
  { id: CUSTOM_FIELDS.SPRINT,       name: 'Sprint',       custom: true, schema: { type: 'array', custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
  { id: CUSTOM_FIELDS.QA_ENGINEER,  name: 'QA Engineer',  custom: true, schema: { type: 'array', items: 'user' } },
  { id: 'customfield_14515',         name: 'Capex Task',   custom: true, schema: { type: 'option' } },
];

/** Build a field list from the static known list + any extra fields observed in the issue cache. */
function buildFallbackFields() {
  const knownIds = new Set(KNOWN_FIELDS.map(f => f.id));
  const extra = [];
  for (const issues of Object.values(state.issueCache)) {
    if (!issues?.length) continue;
    for (const fieldId of Object.keys(issues[0].fields || {})) {
      if (!knownIds.has(fieldId)) {
        knownIds.add(fieldId);
        extra.push({ id: fieldId, name: fieldId, custom: true, schema: {} });
      }
    }
    break;
  }
  return [...KNOWN_FIELDS, ...extra]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

async function loadJiraFields() {
  if (state.jiraFields !== null) return;
  lastFieldsError = '';
  try {
    const res = await fetch('/api/jira/field');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`HTTP ${res.status}: ${body.error || res.statusText}`);
    }
    const raw = await res.json();
    if (!Array.isArray(raw)) throw new Error('Unexpected response format');
    state.jiraFields = raw
      .filter(f => f.navigable !== false)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  } catch (err) {
    // /rest/api/3/field requires admin scope — fall back to known fields + cache.
    // No retry; the fallback list is usable.
    lastFieldsError = `${err.message} — using built-in field list`;
    state.jiraFields = buildFallbackFields();
  }
}

async function loadJiraFieldsAndRefreshDropdown() {
  const select = document.getElementById('q-add-column');
  if (!select) return;

  clearFieldsError();

  if (state.jiraFields === null) {
    // Show loading state inside the select while fetching
    select.disabled = true;
    select.innerHTML = '<option value="">Loading fields…</option>';
    await loadJiraFields();
  }

  // loadJiraFields always sets jiraFields (API result or fallback list)
  if (lastFieldsError) showFieldsError();
  refreshAddColumnDropdown();
}

function updateRollupSecondarySortOptions(interval) {
  const sortSel = document.getElementById('q-rollup-secondary-sort');
  if (!sortSel) return;
  const prev   = sortSel.value;
  const isDate = interval === 'week' || interval === 'month';
  if (isDate) {
    sortSel.innerHTML = `
      <option value="date-asc">Oldest first</option>
      <option value="date-desc">Newest first</option>`;
    if (prev === 'date-asc' || prev === 'date-desc') sortSel.value = prev;
  } else {
    sortSel.innerHTML = `
      <option value="alpha-asc">A → Z</option>
      <option value="alpha-desc">Z → A</option>
      <option value="sum-asc">Sum ↑ (low first)</option>
      <option value="sum-desc">Sum ↓ (high first)</option>`;
    if (['alpha-asc','alpha-desc','sum-asc','sum-desc'].includes(prev)) sortSel.value = prev;
  }
}

async function loadJiraFieldsAndPopulateRollupSelects() {
  if (state.jiraFields === null) await loadJiraFields();
  const fields = state.jiraFields || buildFallbackFields();
  const options = fields
    .map(f => `<option value="${escHtml(f.id)}">${escHtml(f.name)}</option>`)
    .join('');

  const primarySel   = document.getElementById('q-rollup-primary-field');
  const secondarySel = document.getElementById('q-rollup-secondary-field');
  const sumSel       = document.getElementById('q-rollup-sum-field');
  if (primarySel)   primarySel.innerHTML   = `<option value="">Select field…</option>${options}`;
  if (secondarySel) secondarySel.innerHTML = `<option value="">— None —</option>${options}`;
  if (sumSel)       sumSel.innerHTML       = `<option value="">Select field…</option>${options}`;
}

function refreshAddColumnDropdown() {
  const select = document.getElementById('q-add-column');
  if (!select || !state.jiraFields) return;

  select.disabled = false;
  const currentIds = new Set(state.formColumns.map(c => c.id));
  const options = state.jiraFields
    .filter(f => !currentIds.has(f.id))
    .map(f => {
      const safeName = f.name.replace(/"/g, '&quot;');
      return `<option value="${escHtml(f.id)}" data-name="${safeName}" data-type="${deriveSchemaType(f)}">${escHtml(f.name)}</option>`;
    }).join('');

  select.innerHTML = `<option value="">Add column…</option>${options}`;
}

function deriveSchemaType(field) {
  const schema = field.schema;
  if (!schema) return 'string';
  if (schema.custom?.includes('gh-sprint')) return 'sprint';
  switch (schema.type) {
    case 'user':      return 'user';
    case 'status':    return 'status';
    case 'priority':  return 'priority';
    case 'issuetype': return 'issuetype';
    case 'date':      return 'date';
    case 'datetime':  return 'datetime';
    case 'number':    return 'number';
    case 'array':     return schema.items === 'user' ? 'array:user' : 'array';
    default:          return 'string';
  }
}

// ── Run Query ─────────────────────────────────────────────────────────────────

async function runQuery(query, page = 0) {
  if (page === 0) state.pagination[query.id] = { pageTokens: [''] };

  const resultsBody = document.getElementById(`results-body-${query.id}`);
  if (!resultsBody) return;

  resultsBody.innerHTML = '<div class="loading-state">Running query...</div>';
  document.getElementById(`results-pagination-${query.id}`).style.display = 'none';
  clearAlert();

  try {
    if (query.displayType === 'pie') {
      const issues  = await fetchAllIssues(query.jql);
      const grouped = groupIssuesBy(issues, query.groupBy || 'assignee');
      renderDoughnut(resultsBody, grouped, {
        total:       issues.length,
        fieldLabel:  GROUP_BY_LABELS[query.groupBy] || query.groupBy,
        jiraBaseUrl: state.jiraBaseUrl,
        baseJql:     query.jql,
        groupBy:     query.groupBy || 'assignee',
      });
      await recordLastRun(query, issues.length);
    } else if (query.displayType === 'rollup') {
      const cfg = query.rollupConfig || {};
      // Explicitly request the group/sum fields so they're included in the response
      const rollupFields = [cfg.primaryGroup, cfg.secondaryGroup, cfg.sumField]
        .filter(Boolean)
        .filter(id => id !== 'key');
      const issues = await fetchAllIssues(query.jql, { fields: rollupFields });
      state.issueCache[query.id] = issues;
      renderRollupTable(resultsBody, issues, cfg);
      await recordLastRun(query, issues.length);
    } else {
      const pageTokens = state.pagination[query.id]?.pageTokens || [''];
      const token      = pageTokens[page] || undefined;

      // Only pass explicit fields when columns are configured; empty = API default set
      const fields = query.columns?.length
        ? query.columns.map(c => c.id).filter(id => id !== 'key')
        : [];

      const data = await jiraSearch(query.jql, { nextPageToken: token, maxResults: PAGE_SIZE, fields });

      if (data.nextPageToken) {
        state.pagination[query.id].pageTokens[page + 1] = data.nextPageToken;
      }

      state.issueCache[query.id] = data.issues;

      // The cursor-based search/jql endpoint may omit total. Infer it when possible:
      // if this is the last page we know the exact total from the page offset + count.
      const total = data.total ?? (data.isLast ? page * PAGE_SIZE + data.issues.length : undefined);

      renderIssueTable(resultsBody, data.issues, {
        jiraBaseUrl: state.jiraBaseUrl,
        pageStart:   page * PAGE_SIZE + 1,
        total,
        columns:     query.columns,
      });
      renderPagination(data, query, page);
      await recordLastRun(query, total ?? data.issues.length);
    }
  } catch (err) {
    resultsBody.innerHTML = `<div class="alert alert-error">JIRA error: ${escHtml(err.message)}</div>`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchAllIssues(jql, { maxTotal = 5000, fields = [] } = {}) {
  let allIssues = [], nextPageToken;
  while (allIssues.length < maxTotal) {
    const data    = await jiraSearch(jql, { nextPageToken, maxResults: 100, fields });
    allIssues     = [...allIssues, ...data.issues];
    nextPageToken = data.nextPageToken;
    if (data.isLast || !nextPageToken) break;
  }
  return allIssues;
}

async function recordLastRun(query, count) {
  state.runtime[query.id] = { lastRun: new Date().toISOString(), lastCount: count };
  await saveData('runtime', state.runtime);
  const metaEl = document.getElementById(`lastrun-${query.id}`);
  if (metaEl) metaEl.textContent = `Last run: ${new Date().toLocaleDateString()} · ${count} issues`;
}

function renderPagination(data, query, page) {
  if (data.isLast && page === 0) return;
  const paginationEl = document.getElementById(`results-pagination-${query.id}`);
  if (!paginationEl) return;
  paginationEl.style.display = 'flex';
  document.getElementById(`pagination-info-${query.id}`).textContent =
    `Page ${page + 1}${data.isLast ? ' (last page)' : ''}`;
  const btnPrev = document.getElementById(`btn-prev-${query.id}`);
  const btnNext = document.getElementById(`btn-next-${query.id}`);
  btnPrev.disabled = page === 0;
  btnNext.disabled = data.isLast;
  btnPrev.onclick  = () => runQuery(query, page - 1);
  btnNext.onclick  = () => runQuery(query, page + 1);
}

// ── Jira URL Config ───────────────────────────────────────────────────────────

function bindUrlConfigEvents() {
  updateUrlDisplay();

  document.getElementById('btn-edit-jira-url')?.addEventListener('click', () => {
    document.getElementById('jira-url-input').value = state.jiraBaseUrl || '';
    document.getElementById('jira-url-edit').style.display = 'flex';
  });

  document.getElementById('btn-cancel-jira-url')?.addEventListener('click', () => {
    document.getElementById('jira-url-edit').style.display = 'none';
  });

  document.getElementById('btn-save-jira-url')?.addEventListener('click', async () => {
    const url = document.getElementById('jira-url-input').value.trim().replace(/\/+$/, '');
    state.jiraBaseUrl = url || null;
    await saveSettings();
    document.getElementById('jira-url-edit').style.display = 'none';
    updateUrlDisplay();
    rerenderTableResults();
  });
}

function updateUrlDisplay() {
  const el = document.getElementById('jira-url-display');
  if (el) el.textContent = state.jiraBaseUrl || 'No base URL set';
}

function rerenderTableResults() {
  state.queries.forEach(q => {
    if (q.displayType === 'pie') return;
    const cached = state.issueCache[q.id];
    if (!cached) return;
    const el = document.getElementById(`results-body-${q.id}`);
    if (!el) return;
    if (q.displayType === 'rollup') {
      renderRollupTable(el, cached, q.rollupConfig || {});
    } else {
      renderIssueTable(el, cached, { jiraBaseUrl: state.jiraBaseUrl, columns: q.columns });
    }
  });
}

// ── Dashboard Layout — Grid Column Count ──────────────────────────────────────

/**
 * Change the active column count. Redistributes cards from newly-hidden columns
 * into the shortest remaining active column. Updates CSS, visibility, and button
 * styles. Does NOT save — committed only on "Save Layout".
 */
function applyGridColumns(count) {
  // Redistribute cards from columns being hidden
  if (count < state.gridColumns) {
    for (let i = count; i < 3; i++) {
      state.dashboardLayout.columns[i].forEach(id => {
        const activeCols = state.dashboardLayout.columns.slice(0, count);
        const shortest   = activeCols.reduce((minIdx, col, j) =>
          col.length < activeCols[minIdx].length ? j : minIdx, 0);
        activeCols[shortest].push(id);
      });
      state.dashboardLayout.columns[i] = [];
    }
    renderCardColumns();
  }

  state.gridColumns = count;

  // Drive grid column count via CSS custom property
  const grid = document.getElementById('query-results-list');
  if (grid) grid.style.setProperty('--dashboard-cols', count);

  // Show/hide column containers
  for (let i = 0; i < 3; i++) {
    const col = document.getElementById(`dashboard-col-${i}`);
    if (col) col.style.display = i < count ? '' : 'none';
  }

  // Refresh button highlight (only visible during edit mode)
  updateColSelectorButtons();
}

function updateColSelectorButtons() {
  [1, 2, 3].forEach(n => {
    const btn = document.getElementById(`btn-cols-${n}`);
    if (!btn) return;
    btn.className = `btn btn-sm ${n === state.gridColumns ? 'btn-primary' : 'btn-secondary'}`;
  });
}

// ── Dashboard Layout — Edit Mode ──────────────────────────────────────────────

function bindLayoutEditEvents() {
  document.getElementById('btn-edit-layout')?.addEventListener('click',   enterLayoutEdit);
  document.getElementById('btn-save-layout')?.addEventListener('click',   saveLayout);
  document.getElementById('btn-cancel-layout')?.addEventListener('click', cancelLayoutEdit);

  [1, 2, 3].forEach(n => {
    document.getElementById(`btn-cols-${n}`)?.addEventListener('click', () => applyGridColumns(n));
  });

  // Delegate all drag events on all three column containers
  for (let i = 0; i < 3; i++) {
    const col = document.getElementById(`dashboard-col-${i}`);
    if (!col) continue;
    col.addEventListener('dragstart',  handleDashboardDragStart);
    col.addEventListener('dragend',    handleDashboardDragEnd);
    col.addEventListener('dragover',   handleDashboardDragOver);
    col.addEventListener('dragleave',  handleDashboardDragLeave);
    col.addEventListener('drop',       handleDashboardDrop);
  }
}

function enterLayoutEdit() {
  state.layoutEditMode = true;
  state.layoutSnapshot = {
    columns:    state.dashboardLayout.columns.map(col => [...col]),
    gridColumns: state.gridColumns,
  };

  document.getElementById('btn-edit-layout').style.display     = 'none';
  document.getElementById('btn-save-layout').style.display     = '';
  document.getElementById('btn-cancel-layout').style.display   = '';
  document.getElementById('layout-col-selector').style.display = 'flex';

  updateColSelectorButtons();

  // Only highlight currently visible columns
  for (let i = 0; i < state.gridColumns; i++) {
    document.getElementById(`dashboard-col-${i}`)?.classList.add('layout-edit-mode');
  }

  state.queries.forEach(q => {
    const card = document.getElementById(`result-card-${q.id}`);
    if (!card) return;
    card.setAttribute('draggable', 'true');
    const header = card.querySelector('.card-header');
    if (header && !header.querySelector('.drag-handle')) {
      const handle = document.createElement('span');
      handle.className = 'drag-handle';
      handle.textContent = '⠿';
      handle.setAttribute('aria-hidden', 'true');
      header.insertBefore(handle, header.firstChild);
    }
  });
}

function exitLayoutEdit() {
  state.layoutEditMode = false;
  state.layoutSnapshot = null;

  document.getElementById('btn-edit-layout').style.display     = '';
  document.getElementById('btn-save-layout').style.display     = 'none';
  document.getElementById('btn-cancel-layout').style.display   = 'none';
  document.getElementById('layout-col-selector').style.display = 'none';

  for (let i = 0; i < 3; i++) {
    document.getElementById(`dashboard-col-${i}`)?.classList.remove('layout-edit-mode');
  }

  clearDropIndicators();

  state.queries.forEach(q => {
    const card = document.getElementById(`result-card-${q.id}`);
    if (!card) return;
    card.removeAttribute('draggable');
    card.querySelector('.card-header .drag-handle')?.remove();
  });
}

async function saveLayout() {
  await saveSettings();
  exitLayoutEdit();
}

function cancelLayoutEdit() {
  // Restore card positions and column count from snapshot
  state.dashboardLayout.columns = state.layoutSnapshot.columns;
  renderCardColumns();
  // Restore grid count (applyGridColumns handles CSS + visibility; no redistribution
  // since we're restoring, not reducing — we assign directly then apply visuals only)
  state.gridColumns = state.layoutSnapshot.gridColumns;
  const grid = document.getElementById('query-results-list');
  if (grid) grid.style.setProperty('--dashboard-cols', state.gridColumns);
  for (let i = 0; i < 3; i++) {
    const col = document.getElementById(`dashboard-col-${i}`);
    if (col) col.style.display = i < state.gridColumns ? '' : 'none';
  }
  exitLayoutEdit();
}

// ── Dashboard Layout — Drag and Drop ─────────────────────────────────────────

function handleDashboardDragStart(e) {
  if (!state.layoutEditMode) return;
  const card = e.target.closest('.result-card');
  if (!card) return;
  dragSrcId = card.dataset.queryId;
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => card.classList.add('dragging'), 0);
}

function handleDashboardDragEnd(e) {
  if (!state.layoutEditMode) return;
  e.target.closest('.result-card')?.classList.remove('dragging');
  dragSrcId = null;
  clearDropIndicators();
}

function handleDashboardDragOver(e) {
  if (!state.layoutEditMode || !dragSrcId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  clearDropIndicators();

  const card = e.target.closest('.result-card');
  if (card && card.dataset.queryId !== dragSrcId) {
    const rect = card.getBoundingClientRect();
    card.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drop-above' : 'drop-below');
  } else if (!card) {
    e.currentTarget.classList.add('drop-target-col');
  }
}

function handleDashboardDragLeave(e) {
  if (!state.layoutEditMode) return;
  if (!e.currentTarget.contains(e.relatedTarget)) clearDropIndicators();
}

function handleDashboardDrop(e) {
  if (!state.layoutEditMode || !dragSrcId) return;
  e.preventDefault();

  const colIndex   = parseInt(e.currentTarget.id.replace('dashboard-col-', ''), 10);
  const targetCard = e.target.closest('.result-card');
  const targetId   = targetCard?.dataset.queryId;

  clearDropIndicators();
  if (targetId === dragSrcId) return;

  // Remove src from whichever column currently holds it
  const srcColIdx = state.dashboardLayout.columns.findIndex(col => col.includes(dragSrcId));
  if (srcColIdx !== -1) {
    state.dashboardLayout.columns[srcColIdx] =
      state.dashboardLayout.columns[srcColIdx].filter(id => id !== dragSrcId);
  }

  if (targetId) {
    const targetIdx = state.dashboardLayout.columns[colIndex].indexOf(targetId);
    const rect      = targetCard.getBoundingClientRect();
    const before    = e.clientY < rect.top + rect.height / 2;
    state.dashboardLayout.columns[colIndex].splice(before ? targetIdx : targetIdx + 1, 0, dragSrcId);
  } else {
    state.dashboardLayout.columns[colIndex].push(dragSrcId);
  }

  renderCardColumns();
}

function clearDropIndicators() {
  document.querySelectorAll('.drop-above, .drop-below, .drop-target-col').forEach(el => {
    el.classList.remove('drop-above', 'drop-below', 'drop-target-col');
  });
}

// ── Layout Sync & Persistence ─────────────────────────────────────────────────

/** Ensure all queries are in the layout; prune stale IDs. */
function syncLayoutWithQueries() {
  const allIds = new Set(state.queries.map(q => q.id));
  const cols   = state.dashboardLayout.columns;

  // Prune deleted queries
  cols.forEach((col, i) => { cols[i] = col.filter(id => allIds.has(id)); });

  // Assign new queries to the shortest active column
  const inLayout = new Set(cols.flat());
  state.queries.forEach(q => {
    if (inLayout.has(q.id)) return;
    const activeCols = cols.slice(0, state.gridColumns);
    const shortestIdx = activeCols.reduce((minIdx, col, i) =>
      col.length < activeCols[minIdx].length ? i : minIdx, 0);
    cols[shortestIdx].push(q.id);
  });
}

async function saveSettings() {
  await saveData('jira-settings', {
    baseUrl:         state.jiraBaseUrl,
    dashboardLayout: state.dashboardLayout,
    gridColumns:     state.gridColumns,
  });
}

// ── Alert helpers ─────────────────────────────────────────────────────────────

function showAlert(msg, type = 'warn') {
  const el = document.getElementById('jira-alert');
  if (el) el.innerHTML = `<div class="alert alert-${type}">${escHtml(msg)}</div>`;
}
function clearAlert() {
  const el = document.getElementById('jira-alert');
  if (el) el.innerHTML = '';
}
