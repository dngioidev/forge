#!/usr/bin/env node
/**
 * autopilot reactive filing — turn a need surfaced mid-delivery into a tracked,
 * linked ticket instead of dropping it (#130, spec §7). Thin wrapper over
 * board/create.mjs: it maps the delivery "kind" to a board type and links the
 * new ticket to the driving ticket. The loop then picks it up in a later pass.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { makeBoardCtx } from '../lib/boardctx.mjs';
import { runCreate } from '../board/create.mjs';

// Delivery kinds → board type options (epic/item/bug/test). No 'spike' type — a
// spike is tracked as an item whose body says "spike:" (deliver's spike route).
export const KIND_TO_TYPE = { bug: 'bug', test: 'test', spike: 'item', feature: 'item', chore: 'item', item: 'item' };

export function toType(kind) {
  return KIND_TO_TYPE[kind] ?? 'item';
}

/**
 * File one follow-up. `spec`: { title, body, kind, from (driving issue#),
 * priority?, size? }. Returns the created issue number. `create` is injected
 * for testing; defaults to the real board/create.mjs.
 */
export async function fileWork(ctx, spec, create = runCreate, log = console.log) {
  if (!spec?.title) return { ok: false, error: 'title is required' };
  const body = `${spec.body ?? ''}${spec.from ? `\n\n_Filed by forge:autopilot while delivering #${spec.from}._` : ''}`;
  const res = await create(ctx, {
    title: spec.title,
    body,
    type: toType(spec.kind),
    priority: spec.priority ?? 'p2',
    size: spec.size ?? 's',
    status: 'backlog',
    parent: spec.parent ?? null,
    unknownFlags: [],
  }, log);
  if (!res.ok) return res;
  return { ok: true, number: res.number, kind: spec.kind ?? 'item' };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  makeBoardCtx({ gh, cwd: process.cwd() }).then(async (ctx) => {
    if (!ctx.ok) { console.error(ctx.error); process.exit(1); }
    const argv = process.argv.slice(2);
    const get = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
    const res = await fileWork(ctx, {
      title: get('--title'), body: get('--body') ?? '', kind: get('--kind') ?? 'item',
      from: get('--from') ? Number(get('--from')) : null, parent: get('--parent') ? Number(get('--parent')) : null,
    });
    if (!res.ok) { console.error(`file failed: ${res.error}`); process.exit(1); }
    console.log(`filed #${res.number} (${res.kind})`);
  });
}
