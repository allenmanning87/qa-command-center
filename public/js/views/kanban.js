import { getData, saveData, uid } from '../api.js';
import { makeSortable } from '../drag-sort.js';

// ── State ─────────────────────────────────────────────────────────────────────
let columns  = [];   // [{ id, name, cardIds: [] }]
let cards    = [];   // [{ id, title, projectId, taskId, notes, jiraUrl, prUrl, createdAt }]
let projects = { projects: [] };
let manageOpen    = false;
let formColumnId  = null;   // column the new-card form is targeting
let formMode      = 'create'; // 'create' | 'edit'
let editCardId    = null;
let formColor     = null;   // selected color swatch value ('red' | … | null)

// ── Multi-container card drag state (module-local) ────────────────────────────
// Candidate for extraction to drag-sort.js if a second multi-container use case appears.
let dragCardId     = null;
let dragSrcColId   = null;

// ── Top scrollbar sync state ──────────────────────────────────────────────────
let _scrollTopHandler = null;

const DEFAULT_COLUMNS = ['Backlog', 'In Progress', 'Review', 'Done'];

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function updateSwatchSelection() {
  document.querySelectorAll('#kb-form-colors .kb-color-swatch').forEach(btn => {
    btn.classList.toggle('selected', (btn.dataset.color || null) === formColor);
  });
}

function sorted(arr) {
  return [...arr].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function col(id)         { return columns.find(c => c.id === id); }
function card(id)        { return cards.find(c => c.id === id); }
function proj(id)        { return projects.projects.find(p => p.id === id); }
function taskOf(pid, tid){ return proj(pid)?.tasks.find(t => t.id === tid); }
function colOfCard(cid)  { return columns.find(c => c.cardIds.includes(cid)); }

async function saveCols()  { await saveData('kanban-columns', columns); }
async function saveCards() { await saveData('kanban-cards',   cards);   }

// ── Entry point ───────────────────────────────────────────────────────────────
export function render() {
  return `
    <div class="page-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
      <div>
        <div class="page-title">Kanban</div>
        <div class="page-subtitle">Drag cards between columns to track your work</div>
      </div>
    </div>

    <div id="kb-scroll-top" class="kanban-scroll-top"><div id="kb-scroll-ghost"></div></div>
    <div id="kb-board"></div>

    <div id="kb-form-panel" class="form-panel" style="display:none;margin-top:16px;">
      <div class="form-panel-title" id="kb-form-panel-title">New Card</div>
      <div class="form-group" style="margin-bottom:12px;">
        <label class="form-label">Title <span style="color:var(--red)">*</span></label>
        <input class="form-input" id="kb-form-title" placeholder="What needs to be done?" />
        <div id="kb-form-title-err" style="display:none;color:var(--red);font-size:12px;margin-top:4px;">Title is required.</div>
      </div>
      <div class="form-row form-row-2" style="margin-bottom:12px;">
        <div class="form-group">
          <label class="form-label">Project</label>
          <select class="form-select" id="kb-form-project"></select>
        </div>
        <div class="form-group">
          <label class="form-label">Task</label>
          <select class="form-select" id="kb-form-task"></select>
        </div>
      </div>
      <div class="form-group" style="margin-bottom:12px;">
        <label class="form-label">Notes</label>
        <textarea class="form-textarea" id="kb-form-notes" rows="2" placeholder="Optional notes…"></textarea>
      </div>
      <div class="form-group" style="margin-bottom:12px;">
        <label class="form-label">Color</label>
        <div class="kb-color-swatches" id="kb-form-colors">
          <button type="button" class="kb-color-swatch kb-color-swatch--none selected" data-color="" title="No color"></button>
          <button type="button" class="kb-color-swatch kb-color-swatch--red"    data-color="red"    title="Red"></button>
          <button type="button" class="kb-color-swatch kb-color-swatch--orange" data-color="orange" title="Orange"></button>
          <button type="button" class="kb-color-swatch kb-color-swatch--yellow" data-color="yellow" title="Yellow"></button>
          <button type="button" class="kb-color-swatch kb-color-swatch--green"  data-color="green"  title="Green"></button>
          <button type="button" class="kb-color-swatch kb-color-swatch--blue"   data-color="blue"   title="Blue"></button>
          <button type="button" class="kb-color-swatch kb-color-swatch--violet" data-color="violet" title="Violet"></button>
        </div>
      </div>
      <div class="form-row form-row-2" style="margin-bottom:16px;">
        <div class="form-group">
          <label class="form-label">JIRA Ticket</label>
          <input class="form-input" id="kb-form-jira" placeholder="https://…" />
        </div>
        <div class="form-group">
          <label class="form-label">PR</label>
          <input class="form-input" id="kb-form-pr" placeholder="https://…" />
        </div>
      </div>
      <div id="kb-form-no-projects" style="display:none;color:var(--text-muted);font-size:12px;margin-bottom:12px;">
        No projects yet — add projects in the <a href="#time">Time Tracker</a> first.
      </div>
      <div class="form-actions">
        <button class="btn btn-secondary" id="kb-form-cancel">Cancel</button>
        <button class="btn btn-primary"   id="kb-form-save">Save card</button>
      </div>
    </div>

    <div style="margin-top:24px;">
      <button class="btn btn-secondary btn-sm" id="kb-manage-toggle">▶ Manage Columns</button>
      <div id="kb-manage-content" style="display:none;margin-top:12px;"></div>
    </div>
  `;
}

export async function init() {
  [columns, cards, projects] = await Promise.all([
    getData('kanban-columns').then(d => d || []),
    getData('kanban-cards').then(d => d || []),
    getData('time-projects').then(d => d || { projects: [] }),
  ]);

  if (columns.length === 0) {
    columns = DEFAULT_COLUMNS.map(name => ({ id: uid(), name, cardIds: [] }));
    await saveCols();
  }

  renderBoard();
  populateFormProjects();

  document.getElementById('kb-form-project').addEventListener('change', e => populateFormTasks(e.target.value));
  document.getElementById('kb-form-save').addEventListener('click', saveCard);
  document.getElementById('kb-form-cancel').addEventListener('click', closeForm);
  document.getElementById('kb-manage-toggle').addEventListener('click', toggleManage);

  document.querySelectorAll('#kb-form-colors .kb-color-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      const clicked = btn.dataset.color || null;
      formColor = clicked === formColor ? null : clicked;
      updateSwatchSelection();
    });
  });

  window._kbOpenForm       = colId => openForm(colId);
  window._kbDeleteCard     = cardId => deleteCard(cardId);
  window._kbEditCard       = cardId => openEditForm(cardId);
  window._kbStartRenameCol = colId => startRenameCol(colId);
  window._kbDeleteCol      = colId => deleteCol(colId);
  window._kbAddCol         = () => {
    const inp = document.getElementById('kb-new-col-name');
    if (inp?.value.trim()) addCol(inp.value.trim());
  };
}

// ── Board render ──────────────────────────────────────────────────────────────
function renderBoard() {
  const el = document.getElementById('kb-board');
  if (!el) return;

  if (columns.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="empty-state-title">No columns yet</div><div class="empty-state-desc">Add one in Manage Columns below.</div></div>`;
    return;
  }

  el.innerHTML = `<div class="kanban-board">${columns.map(renderCol).join('')}</div>`;
  initCardDrag();
  syncScrollSetup();
}

function syncScrollSetup() {
  const board = document.querySelector('.kanban-board');
  const top   = document.getElementById('kb-scroll-top');
  const ghost = document.getElementById('kb-scroll-ghost');
  if (!board || !top || !ghost) return;

  ghost.style.width = board.scrollWidth + 'px';

  if (_scrollTopHandler) top.removeEventListener('scroll', _scrollTopHandler);
  _scrollTopHandler = () => { board.scrollLeft = top.scrollLeft; };
  top.addEventListener('scroll', _scrollTopHandler);
  board.addEventListener('scroll', () => { top.scrollLeft = board.scrollLeft; });
}

function renderCol(c) {
  const colCards = c.cardIds.map(id => card(id)).filter(Boolean);
  const cardsHtml = colCards.length
    ? colCards.map(renderCard).join('')
    : `<div class="kanban-col-empty">No cards</div>`;

  return `
    <div class="kanban-col" id="kb-col-${esc(c.id)}" data-col-id="${esc(c.id)}">
      <div class="kanban-col-header">
        <span class="kanban-col-title">${esc(c.name)}</span>
        <span class="badge badge-gray" style="flex-shrink:0;">${c.cardIds.length}</span>
        <button class="btn btn-primary btn-sm" onclick="_kbOpenForm('${esc(c.id)}')">+ New card</button>
      </div>
      <div class="kanban-card-list" id="kb-list-${esc(c.id)}" data-col-id="${esc(c.id)}">
        ${cardsHtml}
      </div>
    </div>`;
}

function renderCard(c) {
  const p     = proj(c.projectId);
  const t     = c.taskId ? taskOf(c.projectId, c.taskId) : null;
  const pName = p ? esc(p.name) : (c.projectId ? '<em>(deleted project)</em>' : null);
  const tName = t ? esc(t.name) : (c.taskId   ? '<em>(deleted task)</em>'    : null);
  const metaContent = [tName, pName].filter(Boolean).join(' &middot; ');

  const linksHtml = (c.jiraUrl || c.prUrl) ? `
    <div class="kanban-card-links">
      ${c.jiraUrl ? `<a href="${esc(c.jiraUrl)}" target="_blank" rel="noopener" title="${esc(c.jiraUrl)}">JIRA: ${esc(c.jiraUrl)}</a>` : ''}
      ${c.prUrl   ? `<a href="${esc(c.prUrl)}"   target="_blank" rel="noopener" title="${esc(c.prUrl)}">PR: ${esc(c.prUrl)}</a>`     : ''}
    </div>` : '';

  const colorClass = c.color ? ` kanban-card--${esc(c.color)}` : '';
  return `
    <div class="kanban-card${colorClass}" draggable="true" data-card-id="${esc(c.id)}">
      <button class="kanban-card-delete" onclick="_kbDeleteCard('${esc(c.id)}')" title="Delete card">×</button>
      <button class="kanban-card-edit"   onclick="_kbEditCard('${esc(c.id)}')"   title="Edit card">✎</button>
      <div class="kanban-card-title" title="${esc(c.title)}">${esc(c.title)}</div>
      ${metaContent ? `<div class="kanban-card-meta">${metaContent}</div>` : ''}
      ${c.notes ? `<div class="kanban-card-notes">${esc(c.notes)}</div>` : ''}
      ${linksHtml}
    </div>`;
}

// ── Card drag-and-drop (multi-container) ──────────────────────────────────────
function initCardDrag() {
  document.querySelectorAll('.kanban-card').forEach(el => {
    el.addEventListener('dragstart', handleCardDragStart);
    el.addEventListener('dragend',   handleCardDragEnd);
    el.addEventListener('dragover',  handleCardDragOver);
    el.addEventListener('dragleave', handleCardDragLeave);
    el.addEventListener('drop',      handleCardDrop);
  });

  document.querySelectorAll('.kanban-card-list').forEach(list => {
    list.addEventListener('dragover',  handleListDragOver);
    list.addEventListener('dragleave', handleListDragLeave);
    list.addEventListener('drop',      handleListDrop);
  });
}

function handleCardDragStart(e) {
  dragCardId   = e.currentTarget.dataset.cardId;
  dragSrcColId = colOfCard(dragCardId)?.id ?? null;
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => e.currentTarget.classList.add('dragging'), 0);
}

function handleCardDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  dragCardId = dragSrcColId = null;
  clearCardDropIndicators();
}

function handleCardDragOver(e) {
  if (!dragCardId) return;
  const target = e.currentTarget;
  if (target.dataset.cardId === dragCardId) return;
  e.preventDefault();
  e.stopPropagation();
  clearCardDropIndicators();
  const rect  = target.getBoundingClientRect();
  const above = e.clientY < rect.top + rect.height / 2;
  target.classList.toggle('drop-above', above);
  target.classList.toggle('drop-below', !above);
}

function handleCardDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) {
    e.currentTarget.classList.remove('drop-above', 'drop-below');
  }
}

async function handleCardDrop(e) {
  if (!dragCardId) return;
  const target     = e.currentTarget;
  const targetId   = target.dataset.cardId;
  if (targetId === dragCardId) return;
  e.preventDefault();
  e.stopPropagation();

  const before     = target.classList.contains('drop-above');
  clearCardDropIndicators();

  const destColId  = colOfCard(targetId)?.id;
  if (!destColId) return;

  moveCard(dragCardId, dragSrcColId, destColId, targetId, before);
  await saveCols();
  renderBoard();
}

function handleListDragOver(e) {
  if (!dragCardId) return;
  const list = e.currentTarget;
  if (list.querySelector(`[data-card-id="${dragCardId}"]`)) return;
  e.preventDefault();
  clearCardDropIndicators();
  list.classList.add('drop-target-col');
}

function handleListDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) {
    e.currentTarget.classList.remove('drop-target-col');
  }
}

async function handleListDrop(e) {
  if (!dragCardId) return;
  const list      = e.currentTarget;
  const destColId = list.dataset.colId;
  if (!destColId) return;

  const destCol = col(destColId);
  if (!destCol || destCol.cardIds.includes(dragCardId)) return;
  e.preventDefault();
  clearCardDropIndicators();

  moveCard(dragCardId, dragSrcColId, destColId, null, false);
  await saveCols();
  renderBoard();
}

function moveCard(cardId, srcColId, destColId, relativeToCardId, insertBefore) {
  const src  = col(srcColId);
  const dest = col(destColId);
  if (!src || !dest) return;

  src.cardIds = src.cardIds.filter(id => id !== cardId);

  if (relativeToCardId) {
    const idx = dest.cardIds.indexOf(relativeToCardId);
    if (idx === -1) {
      dest.cardIds.push(cardId);
    } else {
      dest.cardIds.splice(insertBefore ? idx : idx + 1, 0, cardId);
    }
  } else {
    dest.cardIds.push(cardId);
  }
}

function clearCardDropIndicators() {
  document.querySelectorAll('.kanban-card.drop-above, .kanban-card.drop-below')
          .forEach(el => el.classList.remove('drop-above', 'drop-below'));
  document.querySelectorAll('.kanban-card-list.drop-target-col')
          .forEach(el => el.classList.remove('drop-target-col'));
}

// ── New card form ─────────────────────────────────────────────────────────────
function openForm(colId) {
  formColumnId = colId;
  formMode     = 'create';
  editCardId   = null;
  document.getElementById('kb-form-title').value = '';
  document.getElementById('kb-form-notes').value = '';
  document.getElementById('kb-form-jira').value  = '';
  document.getElementById('kb-form-pr').value    = '';
  document.getElementById('kb-form-title-err').style.display = 'none';
  document.getElementById('kb-form-panel-title').textContent = 'New Card';
  document.getElementById('kb-form-save').textContent        = 'Save card';
  formColor = null;
  updateSwatchSelection();

  const hasProjects = projects.projects.length > 0;
  document.getElementById('kb-form-save').disabled            = !hasProjects;
  document.getElementById('kb-form-no-projects').style.display = hasProjects ? 'none' : 'block';

  populateFormProjects();
  document.getElementById('kb-form-panel').style.display = 'block';
  document.getElementById('kb-form-title').focus();
}

function openEditForm(cardId) {
  const c = card(cardId);
  if (!c) return;
  formColumnId = null;
  formMode     = 'edit';
  editCardId   = cardId;

  document.getElementById('kb-form-title').value = c.title;
  document.getElementById('kb-form-notes').value = c.notes  || '';
  document.getElementById('kb-form-jira').value  = c.jiraUrl || '';
  document.getElementById('kb-form-pr').value    = c.prUrl   || '';
  document.getElementById('kb-form-title-err').style.display  = 'none';
  document.getElementById('kb-form-no-projects').style.display = 'none';
  document.getElementById('kb-form-panel-title').textContent   = 'Edit Card';
  document.getElementById('kb-form-save').textContent          = 'Save changes';
  document.getElementById('kb-form-save').disabled             = false;
  formColor = c.color || null;
  updateSwatchSelection();

  populateFormProjects();
  const projSel = document.getElementById('kb-form-project');
  if (c.projectId) projSel.value = c.projectId;
  populateFormTasks(projSel.value);
  const taskSel = document.getElementById('kb-form-task');
  if (c.taskId) taskSel.value = c.taskId;

  document.getElementById('kb-form-panel').style.display = 'block';
  document.getElementById('kb-form-title').focus();
}

function closeForm() {
  formColumnId = null;
  formMode     = 'create';
  editCardId   = null;
  document.getElementById('kb-form-panel').style.display     = 'none';
  document.getElementById('kb-form-panel-title').textContent = 'New Card';
  document.getElementById('kb-form-save').textContent        = 'Save card';
}

function populateFormProjects() {
  const sel = document.getElementById('kb-form-project');
  if (!sel) return;
  const ps = projects.projects;
  sel.innerHTML = ps.length
    ? sorted(ps).map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')
    : '<option value="">No projects yet</option>';
  populateFormTasks(sel.value);
}

function populateFormTasks(pid) {
  const sel = document.getElementById('kb-form-task');
  if (!sel) return;
  const p = proj(pid);
  sel.innerHTML = p?.tasks.length
    ? sorted(p.tasks).map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')
    : '<option value="">No tasks</option>';
}

async function saveCard() {
  const title = document.getElementById('kb-form-title').value.trim();
  if (!title) {
    document.getElementById('kb-form-title-err').style.display = 'block';
    document.getElementById('kb-form-title').focus();
    return;
  }

  if (formMode === 'edit') {
    const c = card(editCardId);
    if (!c) return;
    c.title     = title;
    c.projectId = document.getElementById('kb-form-project').value;
    c.taskId    = document.getElementById('kb-form-task').value;
    c.notes     = document.getElementById('kb-form-notes').value.trim();
    c.jiraUrl   = document.getElementById('kb-form-jira').value.trim() || null;
    c.prUrl     = document.getElementById('kb-form-pr').value.trim()   || null;
    c.color     = formColor || null;
    await saveCards();
    closeForm();
    renderBoard();
    return;
  }

  const destCol = col(formColumnId);
  if (!destCol) return;

  const newCard = {
    id:        uid(),
    title,
    projectId: document.getElementById('kb-form-project').value,
    taskId:    document.getElementById('kb-form-task').value,
    notes:     document.getElementById('kb-form-notes').value.trim(),
    jiraUrl:   document.getElementById('kb-form-jira').value.trim() || null,
    prUrl:     document.getElementById('kb-form-pr').value.trim()   || null,
    color:     formColor || null,
    createdAt: new Date().toISOString(),
  };

  cards.push(newCard);
  destCol.cardIds.push(newCard.id);

  await Promise.all([saveCards(), saveCols()]);
  closeForm();
  renderBoard();
}

// ── Delete card ───────────────────────────────────────────────────────────────
async function deleteCard(cardId) {
  if (!confirm('Delete this card?')) return;
  cards = cards.filter(c => c.id !== cardId);
  columns.forEach(c => { c.cardIds = c.cardIds.filter(id => id !== cardId); });
  await Promise.all([saveCards(), saveCols()]);
  renderBoard();
}

// ── Manage Columns ────────────────────────────────────────────────────────────
function toggleManage() {
  manageOpen = !manageOpen;
  const content = document.getElementById('kb-manage-content');
  const btn     = document.getElementById('kb-manage-toggle');
  if (!content || !btn) return;
  content.style.display = manageOpen ? 'block' : 'none';
  btn.textContent = (manageOpen ? '▼' : '▶') + ' Manage Columns';
  if (manageOpen) renderManage();
}

function renderManage() {
  const el = document.getElementById('kb-manage-content');
  if (!el) return;

  el.innerHTML = `
    <div class="card" style="margin-bottom:12px;">
      <div class="card-header" style="margin-bottom:8px;"><span class="card-title">Columns</span></div>
      <div id="kb-col-sortable"></div>
      <div class="flex" style="gap:6px;margin-top:12px;">
        <input class="form-input" id="kb-new-col-name" placeholder="New column name" style="flex:1;"
          onkeydown="if(event.key==='Enter')_kbAddCol()" />
        <button class="btn btn-primary btn-sm" onclick="_kbAddCol()">Add column</button>
      </div>
    </div>`;

  const container = document.getElementById('kb-col-sortable');
  makeSortable(container, columns, {
    renderRow: (c) => `
      <span class="column-row-name" id="kb-col-name-${esc(c.id)}">${esc(c.name)}</span>
      <button class="btn btn-secondary btn-sm" onclick="_kbStartRenameCol('${esc(c.id)}')">Rename</button>
      <button class="btn-icon" onclick="_kbDeleteCol('${esc(c.id)}')">×</button>`,
    onReorder: async newCols => {
      columns = newCols;
      await saveCols();
      renderManage();
      renderBoard();
    },
  });
}

async function addCol(name) {
  columns.push({ id: uid(), name, cardIds: [] });
  await saveCols();
  renderManage();
  renderBoard();
}

async function renameCol(colId, newName) {
  const c = col(colId);
  if (!c) return;
  c.name = newName;
  await saveCols();
  renderManage();
  renderBoard();
}

async function deleteCol(colId) {
  const c = col(colId);
  if (!c) return;
  const count = c.cardIds.length;
  if (count > 0 && !confirm(`This column has ${count} card${count === 1 ? '' : 's'}. Delete the column and all its cards?`)) return;
  cards   = cards.filter(cd => !c.cardIds.includes(cd.id));
  columns = columns.filter(co => co.id !== colId);
  await Promise.all([saveCards(), saveCols()]);
  renderManage();
  renderBoard();
}

function startRenameCol(colId) {
  const span = document.getElementById(`kb-col-name-${colId}`);
  if (!span) return;
  const originalVal = span.textContent;
  let escaping = false;

  const input = document.createElement('input');
  input.className = 'form-input tt-rename-input';
  input.id        = `kb-col-name-${colId}`;
  input.value     = originalVal;

  input.addEventListener('blur', () => {
    if (escaping) { escaping = false; renderManage(); return; }
    const newVal = input.value.trim();
    if (!newVal) { setTimeout(() => input.focus(), 0); return; }
    renameCol(colId, newVal);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { escaping = true; input.blur(); }
  });

  span.replaceWith(input);
  input.focus();
}
