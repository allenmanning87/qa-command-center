/**
 * charts.js — Reusable visualization components for Allen Command Center.
 *
 * Import these functions from any view that needs data visualizations.
 * Each function is self-contained: it renders into a container element,
 * handles cleanup of any previous chart on that container, and returns
 * the Chart.js instance if one was created (for external cleanup if needed).
 */

import { statusBadgeClass, priorityBadgeClass, formatDate, CUSTOM_FIELDS } from './api.js';

export const CHART_COLORS = [
  '#4C9BE8', '#E85454', '#E8C138', '#52A55A', '#81D4D9',
  '#9B6FE8', '#E87C4C', '#4CBFE8', '#E84C9B', '#78E84C',
];

// ── Default table columns (used when a query has no saved column config) ─────

export const DEFAULT_COLUMNS = [
  { id: 'key',       name: 'Key',       schemaType: 'key' },
  { id: 'summary',   name: 'Summary',   schemaType: 'string' },
  { id: 'status',    name: 'Status',    schemaType: 'status' },
  { id: 'priority',  name: 'Priority',  schemaType: 'priority' },
  { id: 'issuetype', name: 'Type',      schemaType: 'issuetype' },
  { id: 'assignee',  name: 'Assignee',  schemaType: 'user' },
  { id: 'updated',   name: 'Updated',   schemaType: 'datetime' },
];

// ── Internal helpers ──────────────────────────────────────────────────────────

function destroyExisting(canvas) {
  const existing = Chart.getChart(canvas);
  if (existing) existing.destroy();
}

export function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Extract and format a single cell value for a given column definition.
 * Returns { html, classes } where classes is a space-separated CSS class string.
 *
 * @param {Object} issue       - JIRA issue object
 * @param {Object} col         - Column definition { id, name, schemaType }
 * @param {string} jiraBaseUrl - Used to build links for the 'key' column
 */
function renderCellValue(issue, col, jiraBaseUrl) {
  const f = issue.fields;
  const { id, schemaType } = col;

  // Special case: the issue key lives on issue.key, not issue.fields
  if (id === 'key') {
    const url  = jiraBaseUrl ? `${jiraBaseUrl}/browse/${issue.key}` : null;
    const html = url
      ? `<a class="table-link" href="${url}" target="_blank">${escHtml(issue.key)}</a>`
      : escHtml(issue.key);
    return { html, classes: 'nowrap' };
  }

  const raw = f[id];
  if (raw === null || raw === undefined) return { html: '—', classes: '' };

  let html = '—';
  let classes = '';

  switch (schemaType) {
    case 'user':
      html    = escHtml(raw.displayName || '—');
      classes = 'text-muted nowrap';
      break;

    case 'array:user':
      html    = Array.isArray(raw) && raw.length
        ? raw.map(u => escHtml(u.displayName || u.name || '?')).join(', ')
        : '—';
      classes = 'text-muted';
      break;

    case 'status':
      html = `<span class="badge ${statusBadgeClass(raw?.name)}">${escHtml(raw?.name || '—')}</span>`;
      break;

    case 'priority':
      html = `<span class="badge ${priorityBadgeClass(raw?.name)}">${escHtml(raw?.name || '—')}</span>`;
      break;

    case 'issuetype':
      html    = escHtml(raw?.name || '—');
      classes = 'text-muted nowrap';
      break;

    case 'date':
    case 'datetime':
      html    = formatDate(raw);
      classes = 'text-muted nowrap';
      break;

    case 'sprint':
      // JIRA returns sprint as an array; last element is the active/most recent sprint
      if (Array.isArray(raw) && raw.length) {
        html = escHtml(raw[raw.length - 1]?.name || '—');
      } else if (raw && typeof raw === 'object' && raw.name) {
        html = escHtml(raw.name);
      }
      classes = 'text-muted nowrap';
      break;

    case 'number':
      html    = raw !== null && raw !== undefined ? String(raw) : '—';
      classes = 'text-muted';
      break;

    default: {
      // Generic fallback: handle string, array, or plain object
      if (typeof raw === 'string') {
        html = escHtml(raw) || '—';
      } else if (Array.isArray(raw)) {
        const parts = raw.map(item => {
          if (typeof item === 'string') return escHtml(item);
          if (item && typeof item === 'object') {
            const v = item.displayName ?? item.name ?? item.value ?? item.key;
            return v !== undefined ? escHtml(String(v)) : null;
          }
          return escHtml(String(item));
        }).filter(Boolean);
        html = parts.length ? parts.join(', ') : '—';
      } else if (raw && typeof raw === 'object') {
        const v = raw.displayName ?? raw.name ?? raw.value ?? raw.key;
        html = v !== undefined ? escHtml(String(v)) : '—';
      } else {
        html = escHtml(String(raw)) || '—';
      }
    }
  }

  return { html, classes };
}

// ── Grouping ──────────────────────────────────────────────────────────────────

/**
 * Group JIRA issues by a field. Returns [[label, count, jqlValue], ...] sorted desc by count.
 * jqlValue is the accountId for user fields (assignee, qa-engineer), display name for others,
 * or '__empty__' when the field is unset on a user picker (used to build "is EMPTY" filters).
 *
 * @param {Object[]} issues   - JIRA issue objects from the REST API
 * @param {'assignee'|'status'|'priority'|'issuetype'|'qa-engineer'} groupBy
 * @returns {Array<[string, number, string|null]>}
 */
export function groupIssuesBy(issues, groupBy) {
  const counts    = {};
  const jqlValues = {};
  for (const issue of issues) {
    const f = issue.fields;
    let key, jqlValue;
    switch (groupBy) {
      case 'assignee':
        key      = f.assignee?.displayName || 'Unassigned';
        jqlValue = f.assignee?.accountId   || null;
        break;
      case 'status':
        key      = f.status?.name || 'Unknown';
        jqlValue = f.status?.name || null;
        break;
      case 'priority':
        key      = f.priority?.name || 'None';
        jqlValue = f.priority?.name || null;
        break;
      case 'issuetype':
        key      = f.issuetype?.name || 'Unknown';
        jqlValue = f.issuetype?.name || null;
        break;
      case 'qa-engineer': {
        // customfield_11478 is a multi-user picker — use first assigned user, or 'None'
        const users = f[CUSTOM_FIELDS.QA_ENGINEER];
        if (Array.isArray(users) && users.length > 0) {
          key      = users[0].displayName;
          jqlValue = users[0].accountId || null;
        } else {
          key      = 'None';
          jqlValue = '__empty__';
        }
        break;
      }
      default:
        key      = 'Unknown';
        jqlValue = null;
    }
    counts[key]    = (counts[key] || 0) + 1;
    jqlValues[key] = jqlValue;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => [key, count, jqlValues[key]]);
}

// ── Doughnut / Pie Chart ──────────────────────────────────────────────────────

/**
 * Build a Jira issues URL for a group filter. Returns null if any required arg is missing.
 *
 * @param {string} jiraBaseUrl  - e.g. https://company.atlassian.net
 * @param {string} baseJql      - the original query's JQL
 * @param {string} groupBy      - one of the groupIssuesBy keys
 * @param {string|null} jqlValue - the value returned by groupIssuesBy (accountId, name, or '__empty__')
 * @returns {string|null}
 */
function buildGroupLink(jiraBaseUrl, baseJql, groupBy, jqlValue) {
  if (!jiraBaseUrl || !baseJql || !groupBy || jqlValue === null || jqlValue === undefined) return null;

  let filter;
  switch (groupBy) {
    case 'qa-engineer':
      filter = jqlValue === '__empty__'
        ? `"QA Engineer[User Picker (multiple users)]" is EMPTY`
        : `"QA Engineer[User Picker (multiple users)]" = ${jqlValue}`;
      break;
    case 'assignee':
      filter = `assignee = ${jqlValue}`;
      break;
    case 'status':
      filter = `status = "${jqlValue}"`;
      break;
    case 'priority':
      filter = `priority = "${jqlValue}"`;
      break;
    case 'issuetype':
      filter = `issuetype = "${jqlValue}"`;
      break;
    default:
      return null;
  }

  return `${jiraBaseUrl}/issues/?jql=${encodeURIComponent(`${baseJql} AND ${filter}`)}`;
}

/**
 * Render a doughnut chart with a side legend into a container element.
 *
 * @param {HTMLElement} container
 * @param {Array<[string, number, string|null]>} grouped  - Output of groupIssuesBy()
 * @param {Object}  [opts]
 * @param {number}  [opts.total]        - Override total (defaults to sum of grouped)
 * @param {string[]}[opts.colors]       - Color palette override
 * @param {string}  [opts.fieldLabel]   - Label shown above the legend
 * @param {string}  [opts.jiraBaseUrl]  - When provided (with baseJql + groupBy), legend rows become links
 * @param {string}  [opts.baseJql]      - Original query JQL; appended with group filter on click
 * @param {string}  [opts.groupBy]      - Group-by key matching groupIssuesBy() input
 * @returns {Object} Chart.js instance
 */
export function renderDoughnut(container, grouped, { total, colors = CHART_COLORS, fieldLabel, jiraBaseUrl, baseJql, groupBy } = {}) {
  const labels   = grouped.map(([name]) => name);
  const data     = grouped.map(([, count]) => count);
  const _total   = total ?? data.reduce((s, v) => s + v, 0);
  const bgColors = labels.map((_, i) => colors[i % colors.length]);

  const legendRows = grouped.map(([name, count, jqlValue], i) => {
    const pct  = _total > 0 ? Math.round((count / _total) * 100) : 0;
    const url  = buildGroupLink(jiraBaseUrl, baseJql, groupBy, jqlValue);
    const base = `display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);`;
    const inner = `
        <span style="width:12px;height:12px;border-radius:2px;background:${bgColors[i]};flex-shrink:0;"></span>
        <span style="flex:1;font-size:13px;">${escHtml(name)}</span>
        <span style="font-size:13px;font-weight:600;">${count}</span>
        <span style="font-size:11px;color:var(--text-muted);width:36px;text-align:right;">${pct}%</span>`;
    if (url) {
      return `<a href="${url}" target="_blank" style="${base}cursor:pointer;text-decoration:none;color:inherit;">${inner}</a>`;
    }
    return `<div style="${base}">${inner}</div>`;
  }).join('');

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;gap:16px;padding:8px 0;">
      <canvas data-chart="doughnut" width="280" height="280"></canvas>
      <div style="width:100%;max-width:420px;">
        ${fieldLabel ? `<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px;">${escHtml(fieldLabel)}</div>` : ''}
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">Total: <strong>${_total}</strong></div>
        ${legendRows}
      </div>
    </div>`;

  const canvas = container.querySelector('[data-chart="doughnut"]');
  destroyExisting(canvas);

  const centerTextPlugin = {
    id: 'centerText',
    afterDraw(chart) {
      const { ctx, chartArea } = chart;
      const cx     = (chartArea.left + chartArea.right) / 2;
      const cy     = (chartArea.top  + chartArea.bottom) / 2;
      const active = chart.getActiveElements();
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const colorPrimary = isDark ? '#e6edf3' : '#1a2035';
      const colorLabel   = isDark ? '#c9d1d9' : '#374151';
      const colorMuted   = isDark ? '#8b949e' : '#6b7280';

      ctx.save();
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';

      if (active.length) {
        const idx     = active[0].index;
        const label   = chart.data.labels[idx];
        const value   = chart.data.datasets[0].data[idx];
        const pct     = _total > 0 ? Math.round((value / _total) * 100) : 0;
        const display = label.length > 14 ? label.substring(0, 12) + '…' : label;

        ctx.fillStyle = colorPrimary;
        ctx.font      = `bold 22px 'Segoe UI', system-ui`;
        ctx.fillText(`${pct}%`, cx, cy - 16);

        ctx.fillStyle = colorLabel;
        ctx.font      = `12px 'Segoe UI', system-ui`;
        ctx.fillText(display, cx, cy + 2);

        ctx.fillStyle = colorMuted;
        ctx.font      = `11px 'Segoe UI', system-ui`;
        ctx.fillText(`${value} issues`, cx, cy + 18);
      } else {
        ctx.fillStyle = colorPrimary;
        ctx.font      = `bold 22px 'Segoe UI', system-ui`;
        ctx.fillText(_total, cx, cy - 8);

        ctx.fillStyle = colorMuted;
        ctx.font      = `11px 'Segoe UI', system-ui`;
        ctx.fillText('Total', cx, cy + 10);
      }

      ctx.restore();
    },
  };

  return new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: bgColors,
        borderWidth: 2,
        borderColor: document.documentElement.getAttribute('data-theme') === 'dark' ? '#161b22' : '#ffffff',
        hoverBorderWidth: 3,
      }],
    },
    options: {
      responsive: false,
      cutout: '55%',
      interaction: { mode: 'nearest', intersect: true },
      plugins: {
        legend:  { display: false },
        tooltip: { enabled: false },
      },
    },
    plugins: [centerTextPlugin],
  });
}

// ── Rollup Table ─────────────────────────────────────────────────────────────

/**
 * Render a two-level hierarchical rollup table into a container.
 *
 * @param {HTMLElement} container
 * @param {Object[]}    issues
 * @param {Object}      opts
 * @param {string}      opts.primaryGroup    - Field id for primary grouping
 * @param {string}     [opts.primarySort]    - 'alpha-asc'|'alpha-desc'|'sum-asc'|'sum-desc'
 * @param {string|null}[opts.secondaryGroup] - Field id for secondary grouping (null = none)
 * @param {string}     [opts.secondarySort]  - Same sort options
 * @param {string}      opts.sumField        - Field id to sum (numeric field, e.g. timespent)
 * @param {boolean}    [opts.displayAsHours] - Convert raw seconds to hours when true
 */
export function renderRollupTable(container, issues, {
  primaryGroup,
  primarySort            = 'alpha-asc',
  secondaryGroup         = null,
  secondaryGroupInterval = 'raw',
  secondarySort          = 'alpha-asc',
  weekStart              = 'sunday',
  sumField,
  displayAsHours         = false,
} = {}) {
  if (!issues || issues.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title">No results</div>
        <div class="empty-state-desc">This query returned 0 issues.</div>
      </div>`;
    return;
  }

  if (!primaryGroup || !sumField) {
    container.innerHTML = `<div class="alert alert-warn">Rollup is missing required config (Primary Group / Sum Field).</div>`;
    return;
  }

  // Sentinel sort key that always lands last lexicographically
  const NO_DATE_KEY = '\uFFFF';
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function getLabel(raw) {
    if (raw === null || raw === undefined) return '(None)';
    if (typeof raw === 'string') return raw || '(None)';
    if (typeof raw === 'object') {
      const v = raw.displayName ?? raw.name ?? raw.value ?? raw.key;
      return v !== undefined ? String(v) : '(None)';
    }
    return String(raw);
  }

  function getWeekBucket(raw) {
    const s = typeof raw === 'string' ? raw : null;
    if (!s) return { sortKey: NO_DATE_KEY, label: '(No date)' };
    const d = new Date(s);
    if (isNaN(d)) return { sortKey: NO_DATE_KEY, label: '(No date)' };
    const dow    = d.getUTCDay(); // 0=Sun
    const offset = weekStart === 'monday' ? (dow === 0 ? 6 : dow - 1) : dow;
    const start  = new Date(d);
    start.setUTCDate(d.getUTCDate() - offset);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    const fmt = dt => `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`;
    return {
      sortKey: start.toISOString().slice(0, 10),
      label:   `${fmt(start)} \u2013 ${fmt(end)}`,
    };
  }

  function getMonthBucket(raw) {
    const s = typeof raw === 'string' ? raw : null;
    if (!s) return { sortKey: NO_DATE_KEY, label: '(No date)' };
    const d = new Date(s);
    if (isNaN(d)) return { sortKey: NO_DATE_KEY, label: '(No date)' };
    const sortKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    return { sortKey, label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` };
  }

  function getSecBucket(rawValue) {
    if (secondaryGroupInterval === 'week')  return getWeekBucket(rawValue);
    if (secondaryGroupInterval === 'month') return getMonthBucket(rawValue);
    const lbl = getLabel(rawValue);
    return { sortKey: lbl, label: lbl };
  }

  function getSum(issue) {
    const raw = issue.fields[sumField];
    return (raw !== null && raw !== undefined) ? Number(raw) : 0;
  }

  function fmtSum(total) {
    if (displayAsHours) return (total / 3600).toFixed(1) + 'h';
    return total.toLocaleString();
  }

  function sortPrimary(entries) {
    // entries: [label, sum, secondaryMap]
    return [...entries].sort((a, b) => {
      switch (primarySort) {
        case 'alpha-asc':  return a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' });
        case 'alpha-desc': return b[0].localeCompare(a[0], undefined, { numeric: true, sensitivity: 'base' });
        case 'sum-asc':    return a[1] - b[1];
        case 'sum-desc':   return b[1] - a[1];
        default:           return 0;
      }
    });
  }

  function sortSecondary(entries) {
    // entries: [sortKey, {label, sum}]
    return [...entries].sort(([kA, {label: lA, sum: sA}], [kB, {label: lB, sum: sB}]) => {
      if (kA === NO_DATE_KEY && kB !== NO_DATE_KEY) return 1;
      if (kB === NO_DATE_KEY && kA !== NO_DATE_KEY) return -1;
      if (kA === NO_DATE_KEY && kB === NO_DATE_KEY) return 0;
      switch (secondarySort) {
        case 'date-asc':   return kA < kB ? -1 : kA > kB ? 1 : 0;
        case 'date-desc':  return kB < kA ? -1 : kB > kA ? 1 : 0;
        case 'alpha-asc':  return lA.localeCompare(lB, undefined, { numeric: true, sensitivity: 'base' });
        case 'alpha-desc': return lB.localeCompare(lA, undefined, { numeric: true, sensitivity: 'base' });
        case 'sum-asc':    return sA - sB;
        case 'sum-desc':   return sB - sA;
        default:           return 0;
      }
    });
  }

  // Build primary groups: label → { sum, secondaryMap: Map<sortKey, {label, sum}> }
  const primaryMap = new Map();
  for (const issue of issues) {
    const pLabel = getLabel(issue.fields[primaryGroup]);
    if (!primaryMap.has(pLabel)) primaryMap.set(pLabel, { sum: 0, secondaryMap: new Map() });
    const pEntry   = primaryMap.get(pLabel);
    const issueSum = getSum(issue);
    pEntry.sum += issueSum;
    if (secondaryGroup) {
      const { sortKey, label: secLabel } = getSecBucket(issue.fields[secondaryGroup]);
      if (!pEntry.secondaryMap.has(sortKey)) {
        pEntry.secondaryMap.set(sortKey, { label: secLabel, sum: 0 });
      }
      pEntry.secondaryMap.get(sortKey).sum += issueSum;
    }
  }

  // Filter zero-sum primary groups and sort
  const primaryEntries = sortPrimary(
    [...primaryMap.entries()]
      .filter(([, { sum }]) => sum > 0)
      .map(([label, { sum, secondaryMap }]) => [label, sum, secondaryMap])
  );

  const hasSecondary = !!secondaryGroup;
  let grandTotal = 0;
  let rows = '';
  let groupIdx = 0;

  for (const [pLabel, pSum, secondaryMap] of primaryEntries) {
    grandTotal += pSum;

    if (hasSecondary) {
      rows += `<tr class="rollup-row-primary rollup-has-children" data-group-idx="${groupIdx}" data-open="0">
        <td class="rollup-label-primary" colspan="2">
          <span class="rollup-toggle" aria-hidden="true">▶</span>${escHtml(pLabel)}
        </td>
        <td class="rollup-sum-primary">${escHtml(fmtSum(pSum))}</td>
      </tr>`;

      const secEntries = sortSecondary(
        [...secondaryMap.entries()].filter(([, { sum }]) => sum > 0)
      );
      for (const [, { label: sLabel, sum: sSum }] of secEntries) {
        rows += `<tr class="rollup-row-secondary rollup-children-${groupIdx}" style="display:none">
          <td class="rollup-indent"></td>
          <td class="rollup-label-secondary">${escHtml(sLabel)}</td>
          <td class="rollup-sum-secondary">${escHtml(fmtSum(sSum))}</td>
        </tr>`;
      }
      groupIdx++;
    } else {
      rows += `<tr class="rollup-row-primary">
        <td class="rollup-label-primary">${escHtml(pLabel)}</td>
        <td class="rollup-sum-primary">${escHtml(fmtSum(pSum))}</td>
      </tr>`;
    }
  }

  const totalColSpan = hasSecondary ? 2 : 1;
  rows += `<tr class="rollup-row-total">
    <td class="rollup-label-total" colspan="${totalColSpan}">Grand Total</td>
    <td class="rollup-sum-total">${escHtml(fmtSum(grandTotal))}</td>
  </tr>`;

  const headCells = hasSecondary
    ? `<th>Group</th><th></th><th class="rollup-sum-col">Total</th>`
    : `<th>Group</th><th class="rollup-sum-col">Total</th>`;

  container.innerHTML = `
    <div class="table-wrap">
      <table class="table rollup-table">
        <thead><tr>${headCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  // Wire up collapse/expand on primary rows (only when secondary grouping exists)
  if (hasSecondary) {
    container.querySelectorAll('.rollup-has-children').forEach(row => {
      row.addEventListener('click', () => {
        const idx    = row.dataset.groupIdx;
        const isOpen = row.dataset.open === '1';
        const toggle = row.querySelector('.rollup-toggle');

        container.querySelectorAll(`.rollup-children-${idx}`)
          .forEach(r => { r.style.display = isOpen ? 'none' : ''; });

        row.dataset.open      = isOpen ? '0' : '1';
        toggle.textContent    = isOpen ? '▶' : '▼';
      });
    });
  }
}

// ── JIRA Issue Table ──────────────────────────────────────────────────────────

/**
 * Render a JIRA issue results table into a container element.
 *
 * @param {HTMLElement} container
 * @param {Object[]}    issues          - JIRA issue objects
 * @param {Object}      [opts]
 * @param {string}      [opts.jiraBaseUrl]  - Used to build /browse/ ticket links
 * @param {number}      [opts.pageStart]    - 1-based index of the first issue on this page
 * @param {number}      [opts.total]        - Total issues matching the query (from JIRA response)
 * @param {Object[]}    [opts.columns]      - Column definitions: [{ id, name, schemaType }].
 *                                           Falls back to DEFAULT_COLUMNS when absent.
 */
export function renderIssueTable(container, issues, { jiraBaseUrl, pageStart, total, columns } = {}) {
  if (!issues || issues.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title">No results</div>
        <div class="empty-state-desc">This query returned 0 issues.</div>
      </div>`;
    return;
  }

  const cols = (columns && columns.length) ? columns : DEFAULT_COLUMNS;

  // "x–y of z" count line (total may be absent when cursor API omits it)
  let countHtml = '';
  if (pageStart !== undefined) {
    const end = total !== undefined
      ? Math.min(pageStart + issues.length - 1, total)
      : pageStart + issues.length - 1;
    countHtml = total !== undefined
      ? `<div class="table-count">${pageStart.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}</div>`
      : `<div class="table-count">${pageStart.toLocaleString()}–${end.toLocaleString()}</div>`;
  }

  const headers = cols.map(col => `<th>${escHtml(col.name)}</th>`).join('');

  const rows = issues.map(issue => {
    const cells = cols.map(col => {
      const { html, classes } = renderCellValue(issue, col, jiraBaseUrl);
      return `<td${classes ? ` class="${classes}"` : ''}>${html}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  container.innerHTML = `
    ${countHtml}
    <div class="table-wrap">
      <table class="table">
        <thead><tr>${headers}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}
