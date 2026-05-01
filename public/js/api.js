// ── JIRA API ──────────────────────────────────────────────────────────────────

/**
 * Run a JQL search query using the current JIRA Cloud API.
 *
 * Uses POST /rest/api/3/search/jql (the GET /rest/api/3/search endpoint was
 * removed by Atlassian in 2025).
 *
 * Returns { issues, isLast, nextPageToken } — cursor-based pagination.
 * Pass nextPageToken from a previous response to get the next page.
 */
// Known custom field IDs for this JIRA instance
export const CUSTOM_FIELDS = {
  QA_ENGINEER: 'customfield_11478', // "QA Engineer" — User Picker (multiple users)
  SPRINT:      'customfield_10019',
};

export async function jiraSearch(jql, { nextPageToken, maxResults = 50, fields = [] } = {}) {
  const defaultFields = [
    'summary', 'status', 'priority', 'assignee', 'created', 'updated', 'issuetype',
    CUSTOM_FIELDS.QA_ENGINEER,
  ];
  const body = {
    jql,
    maxResults,
    fields: fields.length ? fields : defaultFields,
  };
  if (nextPageToken) body.nextPageToken = nextPageToken;

  const res = await fetch('/api/jira/search/jql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'JIRA request failed');
  return data; // { issues, isLast, nextPageToken? }
}

/**
 * Get the current JIRA configuration status.
 */
export async function getConfigStatus() {
  const res = await fetch('/api/config/status');
  return res.json();
}

// ── Local Data Storage ────────────────────────────────────────────────────────

/**
 * Read a local data collection. Returns null if it doesn't exist.
 */
export async function getData(collection) {
  const res = await fetch(`/api/data/${collection}`);
  return res.json();
}

/**
 * Save (replace) a local data collection.
 */
export async function saveData(collection, data) {
  const res = await fetch(`/api/data/${collection}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || 'Save failed');
  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Map a JIRA status name to a badge CSS class.
 */
export function statusBadgeClass(statusName) {
  const name = (statusName || '').toLowerCase();
  if (name.includes('done') || name.includes('resolved') || name.includes('closed')) return 'badge-green';
  if (name.includes('progress') || name.includes('review') || name.includes('testing')) return 'badge-blue';
  if (name.includes('blocked') || name.includes('hold')) return 'badge-red';
  if (name.includes('open') || name.includes('to do') || name.includes('backlog')) return 'badge-gray';
  return 'badge-gray';
}

/**
 * Map a JIRA priority name to a badge CSS class.
 */
export function priorityBadgeClass(priorityName) {
  const name = (priorityName || '').toLowerCase();
  if (name === 'highest' || name === 'critical') return 'badge-red';
  if (name === 'high') return 'badge-orange';
  if (name === 'medium') return 'badge-orange';
  if (name === 'low' || name === 'lowest') return 'badge-gray';
  return 'badge-gray';
}

/**
 * Format a JIRA ISO date string to a short readable date.
 */
export function formatDate(isoString) {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

/**
 * Generate a simple unique ID.
 */
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
