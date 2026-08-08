/**
 * ProjectsV2 operations shared by init and doctor. Every call goes through an
 * injected gh wrapper (see exec.mjs makeGh) — argv arrays only, GraphQL
 * variables via -f/-F flags, never string-interpolated queries (spec §13).
 */

/** Forge standard field sets (names/colors chosen in ADR-0001 + spec §6). */
export const STANDARD_STATUS = [
  { key: 'backlog', name: 'Backlog', color: 'GRAY' },
  { key: 'ready', name: 'Ready', color: 'BLUE' },
  { key: 'inProgress', name: 'In progress', color: 'YELLOW' },
  { key: 'inReview', name: 'In review', color: 'ORANGE' },
  { key: 'blocked', name: 'Blocked / Needs decision', color: 'RED' },
  { key: 'done', name: 'Done', color: 'GREEN' },
  { key: 'wontDo', name: "Won't do", color: 'GRAY' }, // #117: closed for a special reason (not planned / superseded), not completed
];

export const STANDARD_FIELDS = {
  priority: [
    { key: 'p0', name: 'P0', color: 'RED' },
    { key: 'p1', name: 'P1', color: 'YELLOW' },
    { key: 'p2', name: 'P2', color: 'GREEN' },
  ],
  size: [
    { key: 'xs', name: 'XS', color: 'GRAY' },
    { key: 's', name: 'S', color: 'BLUE' },
    { key: 'm', name: 'M', color: 'GREEN' },
    { key: 'l', name: 'L', color: 'YELLOW' },
    { key: 'xl', name: 'XL', color: 'RED' },
  ],
  type: [
    { key: 'program', name: 'Program', color: 'GRAY' }, // a tracker above epics (#89 — iomanage feedback)
    { key: 'epic', name: 'Epic', color: 'PURPLE' },
    { key: 'item', name: 'Item', color: 'BLUE' },
    { key: 'bug', name: 'Bug', color: 'RED' },
    { key: 'test', name: 'Test', color: 'GREEN' },
  ],
};

/** "In progress" -> inProgress; "Blocked / Needs decision" -> blocked; "Won't do" -> wontDo. */
export function optionKey(name) {
  const lower = name.toLowerCase().trim();
  if (lower.startsWith('blocked')) return 'blocked';
  if (lower.startsWith("won't") || lower.startsWith('wont')) return 'wontDo';
  return lower
    .replace(/[^a-z0-9]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * #407 AC.3 — per-process memoization for the two board identity/schema lookups
 * that used to be re-fetched on every call site (init.mjs, doctor.mjs, and any
 * future caller). Keyed by the injected `gh` function reference (a WeakMap, not
 * a plain object) so caching is scoped to whoever owns that `gh` instance —
 * exactly "per-process/per-run" for production (one process = one `makeGh(run)`
 * instance, reused for the process's lifetime — notably the long-lived
 * forge-core MCP server, § plugin/mcp/forge/server.mjs `makeCtxResolver`) while
 * staying naturally test-isolated (each test constructs its own `gh` double, so
 * two tests never share a cache entry even within the same file/process).
 * `refresh:true` bypasses AND repopulates the cache — the escape hatch for a
 * caller that just mutated what a fresh read must reflect (init.mjs's
 * post-create re-discovery). A failed lookup is never cached, so a transient gh
 * hiccup can still recover on the next call.
 */
const repoInfoCache = new WeakMap(); // gh -> value
const projectFieldsCache = new WeakMap(); // gh -> Map(projectId -> value)

export async function getRepoInfo(gh, { refresh = false } = {}) {
  if (!refresh && repoInfoCache.has(gh)) return repoInfoCache.get(gh);
  const res = await gh(['repo', 'view', '--json', 'owner,name,defaultBranchRef'], { parseJson: true });
  if (!res.ok) return { ok: false, error: res.stderr || 'gh repo view failed' };
  const value = {
    ok: true,
    owner: res.json.owner.login,
    name: res.json.name,
    defaultBranch: res.json.defaultBranchRef?.name ?? 'main',
  };
  repoInfoCache.set(gh, value);
  return value;
}

export async function getProject(gh, owner, number) {
  const res = await gh(['project', 'view', String(number), '--owner', owner, '--format', 'json'], { parseJson: true });
  if (!res.ok) return { ok: false, error: res.stderr || `project ${number} not found for ${owner}` };
  return { ok: true, id: res.json.id, title: res.json.title, number: res.json.number };
}

export async function createProject(gh, owner, title) {
  const res = await gh(['project', 'create', '--owner', owner, '--title', title, '--format', 'json'], { parseJson: true });
  if (!res.ok) return { ok: false, error: res.stderr || 'project create failed' };
  return { ok: true, id: res.json.id, number: res.json.number, title: res.json.title };
}

/**
 * Link a project to a repo so it shows in the repo's Projects tab (#64). A
 * ProjectV2 created via the CLI is owner-scoped and NOT repo-linked by default —
 * linking is a separate call. Idempotent: an already-linked board is success.
 */
export async function linkProject(gh, owner, number, repoSlug) {
  const res = await gh(['project', 'link', String(number), '--owner', owner, '--repo', repoSlug]);
  if (res.ok) return { ok: true, linked: true };
  if (/already linked|already exists/i.test(res.stderr || '')) return { ok: true, linked: false, note: 'already linked' };
  return { ok: false, error: res.stderr || `project link ${number} failed` };
}

const FIELDS_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2 {
      items(first: 1) { totalCount }
      fields(first: 50) {
        nodes {
          __typename
          ... on ProjectV2FieldCommon { id name }
          ... on ProjectV2SingleSelectField { id name options { id name } }
        }
      }
    }
  }
}`;

/** Returns { itemsCount, fields: { <lowercased name>: {id, name, options:[{id,name}]} } }
 * Memoized per (gh, projectId) — #407 AC.3, see the cache docblock above `getRepoInfo`. */
export async function getProjectFields(gh, projectId, { refresh = false } = {}) {
  const byProject = projectFieldsCache.get(gh);
  if (!refresh && byProject?.has(projectId)) return byProject.get(projectId);
  const res = await gh(['api', 'graphql', '-f', `query=${FIELDS_QUERY}`, '-f', `id=${projectId}`], { parseJson: true });
  if (!res.ok) return { ok: false, error: res.stderr || 'fields query failed' };
  const node = res.json.data?.node;
  if (!node) return { ok: false, error: `project node ${projectId} not resolvable` };
  const fields = {};
  for (const f of node.fields.nodes) {
    if (f && f.name) fields[f.name.toLowerCase()] = f;
  }
  const value = { ok: true, itemsCount: node.items.totalCount, fields };
  const cache = byProject ?? new Map();
  cache.set(projectId, value);
  projectFieldsCache.set(gh, cache);
  return value;
}

/** Same inline-literal law as buildStatusMutation (#35/#55): gh -F stringifies arrays. */
export function buildCreateFieldMutation(projectId, name, optionDefs) {
  const opts = optionDefs
    .map((o) => `{name: ${JSON.stringify(o.name)}, color: ${o.color}, description: ""}`)
    .join(', ');
  return `mutation {
  createProjectV2Field(input: { projectId: ${JSON.stringify(projectId)}, dataType: SINGLE_SELECT, name: ${JSON.stringify(name)}, singleSelectOptions: [${opts}] }) {
    projectV2Field { ... on ProjectV2SingleSelectField { id name options { id name } } }
  }
}`;
}

export async function createSingleSelectField(gh, projectId, name, optionDefs) {
  const res = await gh(
    ['api', 'graphql', '-f', `query=${buildCreateFieldMutation(projectId, name, optionDefs)}`],
    { parseJson: true },
  );
  if (!res.ok) return { ok: false, error: res.stderr || `create field ${name} failed` };
  return { ok: true, field: res.json.data.createProjectV2Field.projectV2Field };
}

/**
 * Options must be INLINE literals: gh -F delivers a JSON array as a string
 * (API rejects it), and option colors are GraphQL enums that JSON can't
 * express unquoted. Verified live in the #32 migration + SP1 spike (#35).
 */
export function buildStatusMutation(fieldId, optionDefs) {
  // Passing an existing option's id PRESERVES it (no re-mint); options without an
  // id are freshly minted. This lets us append a status without disturbing the
  // rest (#117) — the API gained `id` on the option input since the ADR-0001 note.
  const opts = optionDefs
    .map((o) => `{${o.id ? `id: ${JSON.stringify(o.id)}, ` : ''}name: ${JSON.stringify(o.name)}, color: ${o.color}, description: ""}`)
    .join(', ');
  return `mutation {
  updateProjectV2Field(input: { fieldId: ${JSON.stringify(fieldId)}, singleSelectOptions: [${opts}] }) {
    projectV2Field { ... on ProjectV2SingleSelectField { id name options { id name } } }
  }
}`;
}

/**
 * ADR-0001: replaces ALL options and mints new ids — call only on projects
 * with zero items (fresh bootstrap). Callers must check itemsCount first.
 */
export async function replaceStatusOptions(gh, fieldId, optionDefs) {
  const res = await gh(
    ['api', 'graphql', '-f', `query=${buildStatusMutation(fieldId, optionDefs)}`],
    { parseJson: true },
  );
  if (!res.ok) return { ok: false, error: res.stderr || 'status options update failed' };
  return { ok: true, field: res.json.data.updateProjectV2Field.projectV2Field };
}

/**
 * Build the `--search` value for finding an issue by its title (#173).
 *
 * A raw `"${title}" in:title` breaks when the title itself contains a double
 * quote: the interpolated quote terminates the phrase early, GitHub parses a
 * malformed query, and the target issue can drop out of the returned set —
 * making the idempotency lookup miss and create a DUPLICATE (spec §6). We strip
 * double quotes (GitHub tokenization ignores punctuation anyway) and use the
 * remainder as a coarse phrase prefilter. Correctness of the resume never rests
 * on the search precision — callers still confirm with an exact
 * `candidate.title === title` comparison against the returned list. This is
 * also injection-safe: no interpolated `"` can escape the phrase.
 */
export function titleSearchQuery(title) {
  const cleaned = String(title ?? '').replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? `"${cleaned}" in:title` : 'in:title';
}

export async function findIssueByTitle(gh, title) {
  const res = await gh(
    ['issue', 'list', '--state', 'all', '--limit', '100', '--search', titleSearchQuery(title), '--json', 'number,title,state'],
    { parseJson: true },
  );
  if (!res.ok) return { ok: false, error: res.stderr || 'issue list failed' };
  const hit = res.json.find((i) => i.title === title);
  return { ok: true, issue: hit ?? null };
}

export async function createIssue(gh, title, body) {
  const res = await gh(['issue', 'create', '--title', title, '--body', body]);
  if (!res.ok) return { ok: false, error: res.stderr || 'issue create failed' };
  const m = /\/issues\/(\d+)/.exec(res.stdout);
  return { ok: true, number: m ? Number(m[1]) : null };
}

/** Map a discovered single-select field into the forge.json shape. */
export function toConfigField(field) {
  const options = {};
  for (const o of field.options ?? []) options[optionKey(o.name)] = o.id;
  return { id: field.id, options };
}
