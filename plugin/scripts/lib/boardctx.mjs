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

    async findItemByIssue(issueNumber) {
      const list = await this.listItems();
      if (!list.ok) return list;
      const fromList = list.items.find((i) => i.content?.number === issueNumber);
      if (fromList) return { ok: true, item: fromList };
      // Fallback (#114): `gh project item-list` indexes lag behind item creation,
      // so a freshly-added item (e.g. from a batch) can be absent for a while and
      // move/receipt would wrongly report "not on board". The issue side is
      // consistent immediately — ask it for membership + the item id.
      return this.findItemViaIssue(issueNumber);
    },

    /** Issue-side lookup: parameterized GraphQL (inline-literal law), returns a minimal item or null. */
    async findItemViaIssue(issueNumber) {
      const res = await gh([
        'api', 'graphql',
        '-F', `number=${issueNumber}`,
        '-f', `owner=${repo.owner}`,
        '-f', `name=${repo.name}`,
        '-f', 'query=query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ issue(number:$number){ projectItems(first:20){ nodes { id project { number } } } } } }',
      ], { parseJson: true });
      if (!res.ok) return { ok: true, item: null }; // best-effort: no fallback item
      const nodes = res.json?.data?.repository?.issue?.projectItems?.nodes ?? [];
      const node = nodes.find((n) => n.project?.number === board.projectNumber);
      return { ok: true, item: node ? { id: node.id, content: { number: issueNumber }, viaFallback: true } : null };
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
