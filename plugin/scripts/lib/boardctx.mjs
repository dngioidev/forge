import { loadConfig, CONFIG_RELPATH } from './config.mjs';
import { getRepoInfo, optionKey } from './board.mjs';

/**
 * Board context: forge.json + repo identity + item operations, resolved once
 * per script run. Every ID comes from config — no hand-built GraphQL ids
 * (spec §6). All gh calls flow through the injected wrapper.
 */
export async function makeBoardCtx({ gh, cwd, now = Date.now, itemsTtlMs = 15000 }) {
  const cfg = await loadConfig(cwd);
  if (!cfg.ok) return { ok: false, error: `${CONFIG_RELPATH} invalid or missing: ${cfg.errors[0]}` };
  const repo = await getRepoInfo(gh);
  if (!repo.ok) return { ok: false, error: repo.error };
  const board = cfg.config.board;

  // #360 AC.3 — field/option IDs already come from forge.json (resolved once by
  // loadConfig, never re-fetched per board op — see resolveOption below). The
  // remaining per-run GraphQL hot path is `project item-list`, which every
  // read-path re-fetches (500 items). A short-TTL memo dedupes repeated reads
  // within a resolved ctx — notably the long-lived MCP session, where one
  // memoized ctx serves board_status / autopilot_select across many calls. Every
  // mutation through this ctx busts the memo, so a re-read after a move sees the
  // new state (preserves the #178 verify-after-move contract).
  let itemsCache = null; // { at, value }
  const invalidateItems = () => { itemsCache = null; };

  // #528 AC-1 — id -> fieldKey, so the scoped per-issue query (below) can map
  // GraphQL fieldValues back onto the same { status, priority, size, type, … }
  // shape listItems() already produces, without any field-name string
  // matching (sidesteps the #550 Type/Kind alias entirely — ids never rename).
  const fieldIdToKey = new Map(Object.entries(board.fields).map(([key, f]) => [f.id, key]));

  const ctx = {
    ok: true,
    gh,
    cwd,
    config: cfg.config,
    owner: repo.owner,
    repo: repo.name,
    projectNumber: board.projectNumber,
    projectId: board.projectId,
    fields: board.fields,
    deliveryLogIssue: board.deliveryLogIssue ?? null,

    /** key -> optionId, with an error that teaches the valid keys. */
    resolveOption(fieldKey, key) {
      const field = board.fields[fieldKey];
      if (!field) return { ok: false, error: `unknown field '${fieldKey}' (valid: ${Object.keys(board.fields).join(', ')})` };
      const id = field.options[key];
      if (!id) return { ok: false, error: `unknown ${fieldKey} '${key}' — valid ${fieldKey} keys: ${Object.keys(field.options).join(', ')}` };
      return { ok: true, fieldId: field.id, optionId: id };
    },

    /** #360: memoized per ctx (TTL + invalidate-on-mutation). `refresh` forces a re-fetch. */
    async listItems({ refresh = false } = {}) {
      if (!refresh && itemsCache && (now() - itemsCache.at) < itemsTtlMs) return itemsCache.value;
      const res = await gh(
        ['project', 'item-list', String(board.projectNumber), '--owner', repo.owner, '--format', 'json', '--limit', '500'],
        { parseJson: true },
      );
      if (!res.ok) return { ok: false, error: res.stderr || 'item-list failed' }; // never cache a failure
      const value = { ok: true, items: res.json.items ?? [] };
      itemsCache = { at: now(), value };
      return value;
    },

    /** Force the next listItems() to re-fetch (e.g. after an out-of-band board change). */
    invalidateItems,

    /**
     * #528 AC-1 — a single-item lookup no longer defaults to a full-board
     * `listItems()` scan. `findItemViaIssue` (scoped, issue-side — #114
     * established this is consistent for ITEM MEMBERSHIP specifically) is now
     * the PRIMARY path; the full scan is only the fallback, and only when the
     * scoped path comes back empty/unusable — never the other way round.
     * Correctness over savings: a scoped miss or a transient `gh api graphql`
     * failure both fall through to the full scan rather than ever reporting
     * "not found" on their say-so alone (pinned by AC-114.1-fallback in
     * tests/board.test.mjs).
     *
     * NOT used for a read that must see a field value THIS SAME PROCESS just
     * mutated — see `findItemFresh` below.
     */
    async findItemByIssue(issueNumber) {
      // findItemViaIssue always resolves ok:true (best-effort — see its own
      // docblock), so the only branch that matters is whether it found an item.
      const viaIssue = await this.findItemViaIssue(issueNumber);
      if (viaIssue.item) return viaIssue;
      return this.findItemFresh(issueNumber);
    },

    /**
     * #528 (reviewer fix-wave) — a read-after-write-GUARANTEED lookup, always
     * via the full `listItems()` scan, never the scoped issue-side query.
     * `findItemByIssue`'s fallback uses this; `verifyStatusMoved` (move.mjs)
     * calls it directly for its #178 post-mutation re-read, which must see a
     * field value THIS SAME PROCESS just changed. Measured live against the
     * real board while delivering #528: the scoped query
     * (`findItemViaIssue`) is NOT immediately consistent for FIELD VALUES
     * after a `project item-edit` mutation — a same-process, zero-delay
     * re-read via the scoped query still returned the pre-mutation value,
     * even though #114 already established issue-side membership itself
     * (whether the item is on the project at all) IS immediate. The full
     * scan already is immediately consistent for field values — #178's own
     * "did NOT persist" detection has depended on that since it shipped; a
     * stale scan would have made it misfire constantly.
     */
    async findItemFresh(issueNumber) {
      const list = await this.listItems();
      if (!list.ok) return list;
      const fromList = list.items.find((i) => i.content?.number === issueNumber);
      return { ok: true, item: fromList ?? null };
    },

    /**
     * Issue-side lookup: parameterized GraphQL (inline-literal law). Returns
     * the item WITH field values (#528 AC-1 — previously id-only, which is why
     * this used to be fallback-only: callers like move.mjs/close.mjs read
     * status/priority/size/type/assignees off the returned item via
     * itemFieldKey). Field values are matched back to forge's field keys by
     * id (fieldIdToKey), never by display name, so this is immune to a board
     * where the field was renamed (or the #550 Type/Kind alias).
     */
    async findItemViaIssue(issueNumber) {
      const res = await gh([
        'api', 'graphql',
        '-F', `number=${issueNumber}`,
        '-f', `owner=${repo.owner}`,
        '-f', `name=${repo.name}`,
        '-f', `query=query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ issue(number:$number){ assignees(first:10){ nodes { login } } projectItems(first:20){ nodes { id project { number } fieldValues(first:20){ nodes { __typename ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { id } } } } } } } } } }`,
      ], { parseJson: true });
      if (!res.ok) return { ok: true, item: null }; // best-effort: caller falls back to the full scan
      const issueNode = res.json?.data?.repository?.issue;
      const nodes = issueNode?.projectItems?.nodes ?? [];
      const node = nodes.find((n) => n.project?.number === board.projectNumber);
      if (!node) return { ok: true, item: null };
      // #528: renamed from `viaFallback` — this is the PRIMARY path now, not
      // a fallback (the name predates the flip; kept as a flag, just retitled).
      const item = { id: node.id, content: { number: issueNumber }, viaScopedLookup: true };
      for (const fv of node.fieldValues?.nodes ?? []) {
        const key = fieldIdToKey.get(fv.field?.id);
        if (key && typeof fv.name === 'string') item[key] = fv.name;
      }
      item.assignees = (issueNode?.assignees?.nodes ?? []).map((a) => a.login);
      return { ok: true, item };
    },

    async addItemByUrl(url) {
      const res = await gh(
        ['project', 'item-add', String(board.projectNumber), '--owner', repo.owner, '--url', url, '--format', 'json'],
        { parseJson: true },
      );
      if (!res.ok) return { ok: false, error: res.stderr || 'item-add failed' };
      invalidateItems(); // a new item invalidates the cached list (#360)
      return { ok: true, itemId: res.json.id };
    },

    async setSelect(itemId, fieldKey, key) {
      const opt = this.resolveOption(fieldKey, key);
      if (!opt.ok) return opt;
      const res = await gh([
        'project', 'item-edit', '--id', itemId, '--project-id', board.projectId,
        '--field-id', opt.fieldId, '--single-select-option-id', opt.optionId,
      ]);
      if (!res.ok) return { ok: false, error: res.stderr || `set ${fieldKey}=${key} failed` };
      invalidateItems(); // the field changed — a re-read must be fresh (#178 verify-after-move)
      return { ok: true };
    },

    /** Current option key of an item's field, from item-list's display name. */
    itemFieldKey(item, fieldKey) {
      const name = item?.[fieldKey === 'type' ? 'type' : fieldKey];
      return typeof name === 'string' ? optionKey(name) : null;
    },
  };
  return ctx;
}
