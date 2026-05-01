import { getData, saveData, uid } from '../api.js';

// ── State ─────────────────────────────────────────────────────────────────────
let entries      = [];
let projects     = { projects: [] };
let config       = { hoursFormat: 'decimal' };
let currentDate  = todayStr();
let currentView  = 'day';
let editingId    = null;
let timerInterval = null;
let weekEdits    = {};      // "pid|tid|date" → raw input string
let weekAddedRows = [];     // [{projectId, taskId}] added via "+ Add row" not yet saved
let weekPendingRow = false; // show pending-row dropdowns
let manageOpen   = false;

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ── Helpers ───────────────────────────────────────────────────────────────────
function clockSvg(isActive, size = 20) {
  const hands = isActive
    ? `<polyline points="12 6 12 12" class="clock-running-minute-hand"></polyline>
       <polyline points="12 12 16 14" class="clock-running-hour-hand"></polyline>`
    : `<polyline points="12 6 12 12 16 14"></polyline>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true"><circle cx="12" cy="12" r="10"></circle>${hands}</svg>`;
}

function sorted(arr) {
  return [...arr].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Entry point ───────────────────────────────────────────────────────────────
export function render() {
  return `
    <div class="page-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
      <div>
        <div class="page-title">Time Tracker</div>
        <div class="page-subtitle">Track time against projects and tasks</div>
      </div>
      <div class="flex" style="gap:6px;">
        <button class="btn btn-sm" id="tt-btn-day">Day</button>
        <button class="btn btn-sm" id="tt-btn-week">Week</button>
      </div>
    </div>

    <div id="tt-view"></div>

    <div id="tt-form-panel" class="form-panel" style="display:none;margin-top:16px;">
      <div class="form-panel-title" id="tt-form-title">New Time Entry</div>
      <div class="form-row form-row-2" style="margin-bottom:12px;">
        <div class="form-group">
          <label class="form-label">Project</label>
          <select class="form-select" id="tt-form-project"></select>
        </div>
        <div class="form-group">
          <label class="form-label">Task</label>
          <select class="form-select" id="tt-form-task"></select>
        </div>
      </div>
      <div class="form-group" style="margin-bottom:12px;">
        <label class="form-label">Notes (optional)</label>
        <textarea class="form-textarea" id="tt-form-notes" rows="2" placeholder="What are you working on?"></textarea>
      </div>
      <div class="form-group" style="margin-bottom:16px;">
        <label class="form-label">Hours</label>
        <input class="form-input" id="tt-form-hours" placeholder="0.00" style="width:120px;" />
      </div>
      <div class="form-actions" style="justify-content:space-between;align-items:center;">
        <div class="flex" style="gap:8px;">
          <button class="btn btn-primary tt-form-timer-icon" id="tt-form-timer">${clockSvg(false,16)} Start timer</button>
          <button class="btn btn-secondary" id="tt-form-save">Save</button>
          <button class="btn btn-secondary" id="tt-form-cancel">Cancel</button>
        </div>
        <button class="btn btn-danger btn-sm" id="tt-form-delete" style="display:none;">Delete</button>
      </div>
    </div>

    <div style="margin-top:32px;">
      <button class="btn btn-secondary btn-sm" id="tt-manage-toggle">▶ Manage Projects</button>
      <div id="tt-manage-content" style="display:none;margin-top:12px;"></div>
    </div>
  `;
}

export async function init() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }

  [entries, projects, config] = await Promise.all([
    getData('time-entries').then(d => d || []),
    getData('time-projects').then(d => d || { projects: [] }),
    getData('time-config').then(d => d || { hoursFormat: 'decimal' }),
  ]);

  weekEdits = {}; weekAddedRows = []; weekPendingRow = false;

  setViewToggle();
  renderView();
  populateFormProjects();
  if (activeEntry()) restartTickInterval();

  // Static element listeners
  document.getElementById('tt-btn-day').addEventListener('click', () => {
    currentView = 'day'; setViewToggle(); renderView();
  });
  document.getElementById('tt-btn-week').addEventListener('click', () => {
    currentView = 'week'; weekEdits = {}; weekAddedRows = []; weekPendingRow = false;
    setViewToggle(); renderView();
  });
  document.getElementById('tt-form-project').addEventListener('change', e => populateFormTasks(e.target.value));
  document.getElementById('tt-form-timer').addEventListener('click', formStartTimer);
  document.getElementById('tt-form-save').addEventListener('click', saveForm);
  document.getElementById('tt-form-cancel').addEventListener('click', closeForm);
  document.getElementById('tt-form-delete').addEventListener('click', deleteEditingEntry);
  document.getElementById('tt-manage-toggle').addEventListener('click', toggleManage);

  // Global handlers for onclick attributes
  window._ttTrackTime       = () => openForm(null);
  window._ttEditEntry       = id => openForm(entries.find(e => e.id === id));
  window._ttStartTimer      = id => startTimer(id);
  window._ttStopTimer       = () => stopTimer().then(() => renderView());
  window._ttNavDate         = delta => { currentDate = offsetDate(currentDate, delta); renderView(); };
  window._ttToday           = () => { currentDate = todayStr(); renderView(); };
  window._ttGoToDate        = d => { currentDate = d; renderView(); };
  window._ttGoToDayView     = d => { currentDate = d; currentView = 'day'; setViewToggle(); renderView(); };
  window._ttNavWeek         = delta => { currentDate = offsetDate(currentDate, delta * 7); weekEdits = {}; weekAddedRows = []; weekPendingRow = false; renderView(); };
  window._ttCellEdit        = (pid, tid, date, val) => { weekEdits[`${pid}|${tid}|${date}`] = val; };
  window._ttAddWeekRow      = () => { weekPendingRow = true; renderWeekView(); };
  window._ttConfirmWeekRow  = (pid, tid) => {
    if (!pid || !tid) return;
    if (!currentWeekRows().some(r => r.projectId === pid && r.taskId === tid))
      weekAddedRows.push({ projectId: pid, taskId: tid });
    weekPendingRow = false;
    renderWeekView();
  };
  window._ttRemoveWeekRow   = (pid, tid) => {
    weekAddedRows = weekAddedRows.filter(r => !(r.projectId === pid && r.taskId === tid));
    Object.keys(weekEdits).filter(k => k.startsWith(`${pid}|${tid}|`)).forEach(k => delete weekEdits[k]);
    renderWeekView();
  };
  window._ttSaveWeek        = () => saveWeekView();
  window._ttAddProject      = () => {
    const inp = document.getElementById('tt-new-project-name');
    if (inp?.value.trim()) addProject(inp.value.trim());
  };
  window._ttDeleteProject   = id => deleteProject(id);
  window._ttStartRenameProject = id => startRenameProject(id);
  window._ttFinishRenameProject = (id, val) => { if (val.trim()) renameProject(id, val.trim()); else renderManage(); };
  window._ttAddTask         = pid => {
    const inp = document.getElementById(`tt-new-task-${pid}`);
    if (inp?.value.trim()) addTask(pid, inp.value.trim());
  };
  window._ttDeleteTask      = (pid, tid) => deleteTask(pid, tid);
  window._ttStartRenameTask = (pid, tid) => startRenameTask(pid, tid);
  window._ttFinishRenameTask = (pid, tid, val) => { if (val.trim()) renameTask(pid, tid, val.trim()); else renderManage(); };
  window._ttStartWeekTimer  = (pid, tid) => startWeekTimer(pid, tid);
  window._ttGetTaskOptions  = pid => {
    const p = proj(pid);
    if (!p) return '<option value="">Select task...</option>';
    return '<option value="">Select task...</option>' + sorted(p.tasks).map(t => `<option value="${t.id}">${t.name}</option>`).join('');
  };
  window._ttSaveConfig      = format => { config.hoursFormat = format; saveConfig(); renderView(); if (manageOpen) renderManage(); };
}

// ── View toggle ───────────────────────────────────────────────────────────────
function setViewToggle() {
  ['day', 'week'].forEach(v => {
    const btn = document.getElementById(`tt-btn-${v}`);
    if (!btn) return;
    btn.classList.toggle('btn-primary', currentView === v);
    btn.classList.toggle('btn-secondary', currentView !== v);
  });
}

function renderView() {
  if (currentView === 'day') renderDayView(); else renderWeekView();
}

// ── Day View ──────────────────────────────────────────────────────────────────
function renderDayView() {
  const el = document.getElementById('tt-view');
  if (!el) return;

  const todayDate  = todayStr();
  const isToday    = currentDate === todayDate;
  const dayEntries = entries.filter(e => e.date === currentDate).sort((a, b) => a.id.localeCompare(b.id));
  const total      = dayEntries.reduce((s, e) => s + liveHours(e), 0);
  const hasProj    = projects.projects.length > 0;

  const weekDates  = getWeekDates(currentDate);
  const dayTotals  = weekDates.map(d => entries.filter(e => e.date === d).reduce((s, e) => s + e.hours, 0));
  const weekTabTotal = dayTotals.reduce((sum, t) => sum + t, 0);
  const tabsHtml = weekDates.map((d, i) => {
    const dayTotal   = dayTotals[i];
    const isActive   = d === currentDate;
    const isTabToday = d === todayDate;
    return `<button class="tt-day-tab${isActive ? ' active' : ''}${isTabToday ? ' today' : ''}"
      onclick="_ttGoToDate('${d}')">
      <span class="tt-day-tab-name">${DAY_LABELS[i]}</span>
      <span class="tt-day-tab-hours">${formatHours(dayTotal)}</span>
    </button>`;
  }).join('');

  el.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="flex" style="align-items:center;gap:10px;">
          <button class="btn btn-secondary btn-sm" onclick="_ttNavDate(-1)">←</button>
          <span style="font-size:16px;font-weight:700;min-width:220px;text-align:center;">
            ${isToday ? '<span style="color:var(--blue)">Today: </span>' : ''}${formatDateLabel(currentDate)}
          </span>
          <button class="btn btn-secondary btn-sm" onclick="_ttNavDate(1)">→</button>
          ${!isToday ? '<button class="btn btn-secondary btn-sm" onclick="_ttToday()">Today</button>' : ''}
        </div>
        <button class="btn btn-primary btn-sm" onclick="_ttTrackTime()"
          ${!hasProj ? 'disabled title="Add a project in Manage Projects first"' : ''}>
          + Track time
        </button>
      </div>

      <div class="tt-day-tabs">
        ${tabsHtml}
        <div class="tt-day-tab-week-total">
          <span class="tt-day-tab-name">Week</span>
          <span class="tt-day-tab-hours">${formatHours(weekTabTotal)}</span>
        </div>
      </div>

      ${dayEntries.length === 0
        ? `<div class="empty-state">
             <div class="empty-state-title">No time tracked</div>
             <div class="empty-state-desc">${hasProj ? 'Click "+ Track time" to log time.' : 'Add a project in Manage Projects below to get started.'}</div>
           </div>`
        : `<div class="tt-entry-list">${dayEntries.map(renderEntryRow).join('')}</div>
           <div class="tt-day-total">Total: <strong>${formatHours(total)}</strong></div>`
      }
    </div>
  `;
}

function renderEntryRow(entry) {
  const p        = proj(entry.projectId);
  const t        = task(entry.projectId, entry.taskId);
  const isActive = !!entry.timerStartedAt;
  const pName    = p?.name || '(deleted project)';
  const tName    = t?.name || '(deleted task)';

  return `
    <div class="tt-entry ${isActive ? 'tt-entry-active' : ''}" id="tt-entry-${entry.id}">
      <div class="tt-entry-body">
        <div class="tt-entry-task">${esc(tName)}</div>
        <div class="tt-entry-project">${esc(pName)}</div>
        ${entry.notes ? `<div class="tt-entry-notes">${esc(entry.notes)}</div>` : ''}
      </div>
      <div class="tt-entry-right">
        <span class="tt-entry-hours" id="tt-hours-${entry.id}">${formatHours(liveHours(entry))}</span>
        <button class="tt-timer-btn${isActive ? ' tt-running' : ''}"
          onclick="${isActive ? '_ttStopTimer()' : `_ttStartTimer('${entry.id}')`}"
          title="${isActive ? 'Stop timer' : 'Start timer'}">
          ${clockSvg(isActive)}${isActive ? 'Stop' : 'Start'}
        </button>
        <button class="btn btn-secondary btn-sm" onclick="_ttEditEntry('${entry.id}')">Edit</button>
      </div>
    </div>
  `;
}

// ── Week View ─────────────────────────────────────────────────────────────────
function currentWeekRows() {
  const dates = getWeekDates(currentDate);
  const seen  = new Set();
  const rows  = [];
  entries.filter(e => dates.includes(e.date)).forEach(e => {
    const key = `${e.projectId}|${e.taskId}`;
    if (!seen.has(key)) { seen.add(key); rows.push({ projectId: e.projectId, taskId: e.taskId }); }
  });
  weekAddedRows.forEach(r => {
    const key = `${r.projectId}|${r.taskId}`;
    if (!seen.has(key)) { seen.add(key); rows.push(r); }
  });
  return rows;
}

function getWeekDates(dateStr) {
  const d   = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return Array.from({ length: 7 }, (_, i) => {
    const dd = new Date(mon);
    dd.setDate(mon.getDate() + i);
    return dd.toISOString().split('T')[0];
  });
}

function renderWeekView() {
  const el = document.getElementById('tt-view');
  if (!el) return;

  const dates     = getWeekDates(currentDate);
  const todayDate = todayStr();
  const rows      = currentWeekRows();
  const hasProj   = projects.projects.length > 0;

  const colHeaders = dates.map((d, i) => {
    const dateObj   = new Date(d + 'T12:00:00');
    const dayNum    = dateObj.getDate();
    const monthAbbr = dateObj.toLocaleDateString('en-US', { month: 'short' });
    return `<th class="tt-week-col-head${d === todayDate ? ' tt-week-today' : ''}">
      <button class="tt-week-day-nav" onclick="_ttGoToDayView('${d}')">${DAY_LABELS[i]}<br><small>${dayNum} ${monthAbbr}</small></button>
    </th>`;
  }).join('');

  const dataRows = rows.map(row => {
    const p = proj(row.projectId);
    const t = task(row.projectId, row.taskId);
    if (!p || !t) return '';

    const isActiveRow = entries.some(e => e.projectId === row.projectId && e.taskId === row.taskId && e.timerStartedAt);

    const cells = dates.map(d => {
      const key     = `${row.projectId}|${row.taskId}|${d}`;
      const existing = entries.find(e => e.date === d && e.projectId === row.projectId && e.taskId === row.taskId);
      const isLive  = existing?.timerStartedAt && d === todayDate;
      let dispVal   = weekEdits[key] !== undefined ? weekEdits[key]
                    : existing ? (existing.hours > 0 ? formatHours(liveHours(existing)) : '')
                    : '';
      if (isLive) dispVal = formatHours(liveHours(existing));
      return `<td class="${d === todayDate ? 'tt-week-today' : ''}">
        <input class="tt-week-cell form-input" type="text" value="${dispVal}" placeholder=""
          ${isLive ? 'readonly' : ''}
          onchange="_ttCellEdit('${row.projectId}','${row.taskId}','${d}',this.value)"
          onfocus="this.select()" />
      </td>`;
    }).join('');

    const rowTotal = dates.reduce((sum, d) => {
      const key      = `${row.projectId}|${row.taskId}|${d}`;
      const existing = entries.find(e => e.date === d && e.projectId === row.projectId && e.taskId === row.taskId);
      const val      = weekEdits[key] !== undefined ? parseHours(weekEdits[key]) : liveHours(existing || { hours: 0 });
      return sum + val;
    }, 0);

    return `<tr>
      <td class="tt-week-label">
        <button class="tt-week-timer-btn${isActiveRow ? ' tt-running' : ''}"
          onclick="${isActiveRow ? '_ttStopTimer()' : `_ttStartWeekTimer('${row.projectId}','${row.taskId}')`}"
          title="${isActiveRow ? 'Stop' : 'Start'} timer">
          ${clockSvg(isActiveRow, 16)}${isActiveRow ? 'Stop' : 'Start'}</button>
        <div>
          <div class="tt-entry-task" style="font-size:13px;">${esc(t.name)}</div>
          <div class="tt-entry-project" style="font-size:11px;">${esc(p.name)}</div>
        </div>
      </td>
      ${cells}
      <td class="tt-week-row-total">${rowTotal > 0 ? formatHours(rowTotal) : '—'}</td>
      <td><button class="btn-icon" onclick="_ttRemoveWeekRow('${row.projectId}','${row.taskId}')">×</button></td>
    </tr>`;
  }).join('');

  const pendingRowHtml = weekPendingRow ? `
    <tr class="tt-pending-row">
      <td class="tt-week-label" colspan="2" style="width:auto;">
        <div style="display:flex;gap:6px;flex-direction:column;padding:4px 0;">
          <select class="form-select" id="tt-pending-proj" style="font-size:12px;"
            onchange="document.getElementById('tt-pending-task').innerHTML=_ttGetTaskOptions(this.value)">
            <option value="">Select project…</option>
            ${sorted(projects.projects).map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
          </select>
          <select class="form-select" id="tt-pending-task" style="font-size:12px;">
            <option value="">Select task…</option>
          </select>
        </div>
      </td>
      ${dates.slice(1).map(() => '<td></td>').join('')}
      <td></td>
      <td><button class="btn btn-primary btn-sm"
        onclick="_ttConfirmWeekRow(document.getElementById('tt-pending-proj').value,document.getElementById('tt-pending-task').value)">Add</button></td>
    </tr>` : '';

  const dayTotals = dates.map(d => {
    const total = rows.reduce((sum, row) => {
      const key      = `${row.projectId}|${row.taskId}|${d}`;
      const existing = entries.find(e => e.date === d && e.projectId === row.projectId && e.taskId === row.taskId);
      return sum + (weekEdits[key] !== undefined ? parseHours(weekEdits[key]) : liveHours(existing || { hours: 0 }));
    }, 0);
    return `<td class="${d === todayDate ? 'tt-week-today' : ''}" style="text-align:center;">${total > 0 ? formatHours(total) : '—'}</td>`;
  }).join('');

  const weekTotal = rows.reduce((sum, row) => sum + dates.reduce((s2, d) => {
    const key      = `${row.projectId}|${row.taskId}|${d}`;
    const existing = entries.find(e => e.date === d && e.projectId === row.projectId && e.taskId === row.taskId);
    return s2 + (weekEdits[key] !== undefined ? parseHours(weekEdits[key]) : liveHours(existing || { hours: 0 }));
  }, 0), 0);

  el.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="flex" style="align-items:center;gap:10px;">
          <button class="btn btn-secondary btn-sm" onclick="_ttNavWeek(-1)">←</button>
          <span style="font-size:16px;font-weight:700;">
            This week: ${formatDateShort(dates[0])} – ${formatDateShort(dates[6])}
          </span>
          <button class="btn btn-secondary btn-sm" onclick="_ttNavWeek(1)">→</button>
        </div>
      </div>
      <div class="table-wrap">
        <table class="table tt-week-table">
          <thead>
            <tr>
              <th class="tt-week-label-head"></th>
              ${colHeaders}
              <th class="tt-week-col-head">Total</th>
              <th style="width:32px;"></th>
            </tr>
          </thead>
          <tbody>
            ${rows.length === 0 && !weekPendingRow
              ? `<tr><td colspan="10" class="empty-state" style="padding:32px;text-align:center;">No rows — click "+ Add row" to start tracking.</td></tr>`
              : dataRows}
            ${pendingRowHtml}
            ${rows.length > 0 ? `<tr class="tt-week-total-row">
              <td>Total</td>${dayTotals}
              <td class="tt-week-row-total">${weekTotal > 0 ? formatHours(weekTotal) : '—'}</td>
              <td></td>
            </tr>` : ''}
          </tbody>
        </table>
      </div>
      <div class="flex" style="gap:8px;margin-top:12px;">
        <button class="btn btn-secondary btn-sm" onclick="_ttAddWeekRow()" ${!hasProj ? 'disabled title="Add a project first"' : ''}>+ Add row</button>
        <button class="btn btn-primary btn-sm" onclick="_ttSaveWeek()">Save</button>
      </div>
    </div>
  `;
}

// ── Form ──────────────────────────────────────────────────────────────────────
function openForm(entry) {
  editingId = entry?.id || null;
  document.getElementById('tt-form-title').textContent = editingId
    ? `Edit Time Entry — ${formatDateLabel(entry.date)}`
    : 'New Time Entry';
  document.getElementById('tt-form-delete').style.display = editingId ? 'inline-flex' : 'none';

  populateFormProjects();
  const pid = entry?.projectId || projects.projects[0]?.id || '';
  const sel = document.getElementById('tt-form-project');
  if (sel) sel.value = pid;
  populateFormTasks(pid);
  if (entry?.taskId) {
    const taskSel = document.getElementById('tt-form-task');
    if (taskSel) taskSel.value = entry.taskId;
  }
  document.getElementById('tt-form-notes').value  = entry?.notes  || '';
  document.getElementById('tt-form-hours').value  = (entry?.hours && !entry.timerStartedAt) ? formatHours(entry.hours) : '';

  document.getElementById('tt-form-panel').style.display = 'block';
  document.getElementById('tt-form-notes').focus();
}

function closeForm() {
  editingId = null;
  document.getElementById('tt-form-panel').style.display = 'none';
}

function populateFormProjects() {
  const sel = document.getElementById('tt-form-project');
  if (!sel) return;
  sel.innerHTML = projects.projects.length
    ? sorted(projects.projects).map(p => `<option value="${p.id}">${p.name}</option>`).join('')
    : '<option value="">No projects</option>';
}

function populateFormTasks(pid) {
  const sel = document.getElementById('tt-form-task');
  if (!sel) return;
  const p = proj(pid);
  sel.innerHTML = p?.tasks.length
    ? sorted(p.tasks).map(t => `<option value="${t.id}">${t.name}</option>`).join('')
    : '<option value="">No tasks</option>';
}

async function saveForm() {
  const pid      = document.getElementById('tt-form-project').value;
  const tid      = document.getElementById('tt-form-task').value;
  const notes    = document.getElementById('tt-form-notes').value.trim();
  const hoursRaw = document.getElementById('tt-form-hours').value.trim();
  const hours    = parseHours(hoursRaw);

  if (!pid || !tid) { alert('Select a project and task.'); return; }
  if (hoursRaw === '' && !editingId) { alert('Enter hours or use "Start timer".'); return; }

  if (editingId) {
    const idx = entries.findIndex(e => e.id === editingId);
    if (idx >= 0) entries[idx] = { ...entries[idx], projectId: pid, taskId: tid, notes, hours };
  } else {
    entries.push({ id: uid(), date: currentDate, projectId: pid, taskId: tid, notes, hours, timerStartedAt: null });
  }
  await saveEntries();
  closeForm();
  renderView();
}

async function formStartTimer() {
  const pid   = document.getElementById('tt-form-project').value;
  const tid   = document.getElementById('tt-form-task').value;
  const notes = document.getElementById('tt-form-notes').value.trim();
  if (!pid || !tid) { alert('Select a project and task.'); return; }

  await stopTimer();
  entries.push({ id: uid(), date: currentDate, projectId: pid, taskId: tid, notes, hours: 0, timerStartedAt: new Date().toISOString() });
  await saveEntries();
  closeForm();
  restartTickInterval();
  renderView();
}

async function deleteEditingEntry() {
  if (!editingId || !confirm('Delete this time entry?')) return;
  entries = entries.filter(e => e.id !== editingId);
  await saveEntries();
  closeForm();
  renderView();
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function activeEntry() { return entries.find(e => e.timerStartedAt); }

async function startTimer(id) {
  await stopTimer();
  const entry = entries.find(e => e.id === id);
  if (!entry) return;
  entry.timerStartedAt = new Date().toISOString();
  await saveEntries();
  restartTickInterval();
  renderView();
}

async function startWeekTimer(pid, tid) {
  await stopTimer();
  let entry = entries.find(e => e.date === currentDate && e.projectId === pid && e.taskId === tid);
  if (entry) {
    entry.timerStartedAt = new Date().toISOString();
  } else {
    entry = { id: uid(), date: currentDate, projectId: pid, taskId: tid, notes: '', hours: 0, timerStartedAt: new Date().toISOString() };
    entries.push(entry);
  }
  await saveEntries();
  restartTickInterval();
  renderWeekView();
}

async function stopTimer() {
  const active = activeEntry();
  if (!active) return;
  const elapsed = (Date.now() - new Date(active.timerStartedAt).getTime()) / 3600000;
  active.hours = +(active.hours + elapsed).toFixed(4);
  active.timerStartedAt = null;
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  await saveEntries();
}

function restartTickInterval() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(tickTimer, 1000);
}

function tickTimer() {
  const active = activeEntry();
  if (!active) { clearInterval(timerInterval); timerInterval = null; return; }
  const el = document.getElementById(`tt-hours-${active.id}`);
  if (el) el.textContent = formatHours(liveHours(active));
}

function liveHours(entry) {
  if (!entry?.timerStartedAt) return entry?.hours || 0;
  return (entry.hours || 0) + (Date.now() - new Date(entry.timerStartedAt).getTime()) / 3600000;
}

// ── Week save ─────────────────────────────────────────────────────────────────
async function saveWeekView() {
  const dates = getWeekDates(currentDate);
  for (const row of currentWeekRows()) {
    for (const d of dates) {
      const key = `${row.projectId}|${row.taskId}|${d}`;
      if (weekEdits[key] === undefined) continue;
      const hrs = parseHours(weekEdits[key]);
      const idx = entries.findIndex(e => e.date === d && e.projectId === row.projectId && e.taskId === row.taskId);
      if (hrs > 0) {
        if (idx >= 0) entries[idx].hours = hrs;
        else entries.push({ id: uid(), date: d, projectId: row.projectId, taskId: row.taskId, notes: '', hours: hrs, timerStartedAt: null });
      } else if (idx >= 0 && !entries[idx].timerStartedAt) {
        entries.splice(idx, 1);
      }
    }
  }
  weekEdits    = {};
  weekAddedRows = [];
  await saveEntries();
  renderWeekView();
}

// ── Manage Projects ───────────────────────────────────────────────────────────
function toggleManage() {
  manageOpen = !manageOpen;
  const content = document.getElementById('tt-manage-content');
  const btn     = document.getElementById('tt-manage-toggle');
  if (!content || !btn) return;
  content.style.display = manageOpen ? 'block' : 'none';
  btn.textContent = (manageOpen ? '▼' : '▶') + ' Manage Projects';
  if (manageOpen) renderManage();
}

function renderManage() {
  const el = document.getElementById('tt-manage-content');
  if (!el) return;

  const projectsHtml = sorted(projects.projects).map(p => {
    const tasksHtml = sorted(p.tasks).map(t => `
      <div class="tt-task-row">
        <span class="tt-task-name" id="tt-task-name-${t.id}">${esc(t.name)}</span>
        <div class="flex" style="gap:4px;">
          <button class="btn btn-secondary btn-sm" onclick="_ttStartRenameTask('${p.id}','${t.id}')">Rename</button>
          <button class="btn-icon" onclick="_ttDeleteTask('${p.id}','${t.id}')">×</button>
        </div>
      </div>`).join('');

    return `
      <div class="tt-project-card card">
        <div class="tt-project-header">
          <span class="tt-project-name" id="tt-proj-name-${p.id}">${esc(p.name)}</span>
          <div class="flex" style="gap:4px;">
            <button class="btn btn-secondary btn-sm" onclick="_ttStartRenameProject('${p.id}')">Rename</button>
            <button class="btn-icon" onclick="_ttDeleteProject('${p.id}')">×</button>
          </div>
        </div>
        <div class="tt-task-list">${tasksHtml || '<div class="text-muted text-sm" style="padding:4px 0 8px;">No tasks yet.</div>'}</div>
        <div class="flex" style="gap:6px;">
          <input class="form-input" id="tt-new-task-${p.id}" placeholder="New task name"
            style="flex:1;font-size:12px;padding:5px 8px;"
            onkeydown="if(event.key==='Enter')_ttAddTask('${p.id}')" />
          <button class="btn btn-secondary btn-sm" onclick="_ttAddTask('${p.id}')">Add task</button>
        </div>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="card" style="margin-bottom:12px;">
      <div class="card-header" style="margin-bottom:8px;"><span class="card-title">Hours Format</span></div>
      <div class="flex" style="gap:8px;">
        <button class="btn ${config.hoursFormat === 'decimal' ? 'btn-primary' : 'btn-secondary'} btn-sm"
          onclick="_ttSaveConfig('decimal')">Decimal (2.50)</button>
        <button class="btn ${config.hoursFormat === 'hhmm' ? 'btn-primary' : 'btn-secondary'} btn-sm"
          onclick="_ttSaveConfig('hhmm')">HH:MM (2:30)</button>
      </div>
    </div>
    ${projectsHtml || '<div class="text-muted text-sm" style="margin-bottom:12px;">No projects yet. Add one below.</div>'}
    <div class="flex" style="gap:6px;margin-top:4px;">
      <input class="form-input" id="tt-new-project-name" placeholder="New project name" style="flex:1;"
        onkeydown="if(event.key==='Enter')_ttAddProject()" />
      <button class="btn btn-primary btn-sm" onclick="_ttAddProject()">Add project</button>
    </div>
  `;
}

async function addProject(name) {
  projects.projects.push({ id: uid(), name, tasks: [] });
  await saveProjects();
  populateFormProjects();
  renderManage();
  renderView();
}

async function renameProject(id, newName) {
  const p = proj(id);
  if (!p) return;
  p.name = newName;
  await saveProjects();
  renderManage();
  renderView();
}

async function deleteProject(id) {
  const count = entries.filter(e => e.projectId === id).length;
  if (count && !confirm(`${count} time ${count === 1 ? 'entry uses' : 'entries use'} this project. Delete anyway?`)) return;
  projects.projects = projects.projects.filter(p => p.id !== id);
  await saveProjects();
  populateFormProjects();
  renderManage();
  renderView();
}

async function addTask(pid, name) {
  const p = proj(pid);
  if (!p) return;
  p.tasks.push({ id: uid(), name });
  await saveProjects();
  renderManage();
}

async function renameTask(pid, tid, newName) {
  const t = task(pid, tid);
  if (!t) return;
  t.name = newName;
  await saveProjects();
  renderManage();
  renderView();
}

async function deleteTask(pid, tid) {
  const count = entries.filter(e => e.projectId === pid && e.taskId === tid).length;
  if (count && !confirm(`${count} time ${count === 1 ? 'entry uses' : 'entries use'} this task. Delete anyway?`)) return;
  const p = proj(pid);
  if (p) p.tasks = p.tasks.filter(t => t.id !== tid);
  await saveProjects();
  renderManage();
  renderView();
}

function startRenameProject(id) {
  const span = document.getElementById(`tt-proj-name-${id}`);
  if (!span) return;
  const val = span.textContent;
  const attrVal = val.replace(/"/g, '&quot;');
  const jsVal = val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  span.outerHTML = `<input class="form-input tt-rename-input" id="tt-proj-name-${id}" value="${attrVal}"
    onblur="_ttFinishRenameProject('${id}',this.value)"
    onkeydown="if(event.key==='Enter')this.blur();if(event.key==='Escape'){this.value='${jsVal}';this.blur();}" />`;
  document.getElementById(`tt-proj-name-${id}`)?.focus();
}

function startRenameTask(pid, tid) {
  const span = document.getElementById(`tt-task-name-${tid}`);
  if (!span) return;
  const val = span.textContent;
  const attrVal = val.replace(/"/g, '&quot;');
  const jsVal = val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  span.outerHTML = `<input class="form-input tt-rename-input" id="tt-task-name-${tid}" value="${attrVal}"
    onblur="_ttFinishRenameTask('${pid}','${tid}',this.value)"
    onkeydown="if(event.key==='Enter')this.blur();if(event.key==='Escape'){this.value='${jsVal}';this.blur();}" />`;
  document.getElementById(`tt-task-name-${tid}`)?.focus();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function offsetDate(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function formatDateLabel(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

function formatDateShort(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatHours(h) {
  if (!h || isNaN(h)) h = 0;
  if (config.hoursFormat === 'hhmm') {
    const mins = Math.round(h * 60);
    return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
  }
  return h.toFixed(2);
}

function parseHours(str) {
  if (!str) return 0;
  str = String(str).trim();
  if (str.includes(':')) {
    const [hh, mm] = str.split(':').map(Number);
    return (hh || 0) + (mm || 0) / 60;
  }
  return parseFloat(str) || 0;
}

function proj(id)        { return projects.projects.find(p => p.id === id); }
function task(pid, tid)  { return proj(pid)?.tasks.find(t => t.id === tid); }
async function saveEntries()  { await saveData('time-entries', entries); }
async function saveProjects() { await saveData('time-projects', projects); }
async function saveConfig()   { await saveData('time-config', config); }
