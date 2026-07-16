import { loadConfig, CONFIG_RELPATH } from './config.mjs';
import { getRepoInfo, optionKey } from './board.mjs';

/**
 * Board context: forge.json + repo identity + item operations, resolved once
 * per script run. Every ID comes from config — no hand-built GraphQL ids
 * (spec §6). All gh calls flow through the injected wrapper.
 */
export async function makeBoardCtx({ gh, cwd }) {
  const cfg = await loadConfig(cwd);
  if (!cfg.ok) return { ok: false, error: `${CONFIG_RELPATH} invalid or missing: ${cfg.errors[0]}` };
  const repo = await getRepoInfo(gh);
  if (!repo.ok) return { ok: false, error: repo.error };
  const board = cfg.config.board;

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

    async listItems() {
      const res = await gh(
        ['project', 'item-list', String(board.projectNumber), '--owner', repo.owner, '--format', 'json', '--limit', '500'],
        { parseJson: true },
      );
      if (!res.ok) return { ok: false, error: res.stderr || 'item-list failed' };
      return { ok: true, items: res.json.items ?? [] };
    },

    async findItemByIssue(issueNumber) {
      const list = await this.listItems();
      if (!list.ok) return list;
      return { ok: true, item: list.items.find((i) => i.content?.number === issueNumber) ?? null };
    },

    async addItemByUrl(url) {
      const res = await gh(
        ['project', 'item-add', String(board.projectNumber), '--owner', repo.owner, '--url', url, '--format', 'json'],
        { parseJson: true },
      );
      if (!res.ok) return { ok: false, error: res.stderr || 'item-add failed' };
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
