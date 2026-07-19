import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, resetDb, upsertNode, upsertEdge, deleteFileScope, counts, NODE_KINDS } from '../../plugin/mcp/graph/db.mjs';
import { rebuild, indexFiles, fileKind, loadTsMorph } from '../../plugin/mcp/graph/indexer.mjs';
import { findComponent, whoUses, similarProps, blastRadius, codeForTicket, reuseCandidates } from '../../plugin/mcp/graph/queries.mjs';
import { makeHandler, validateInput, canonicalize, TOOLS, makeGraphState } from '../../plugin/mcp/graph/server.mjs';
import { parseTicketLog, scanTickets, installHook, HOOK_MARKER } from '../../plugin/scripts/graph/graphctl.mjs';
import { runDoctor } from '../../plugin/scripts/doctor.mjs';
import { fakeGh, REPO_VIEW, AUTH_OK } from '../helpers/fakegh.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'graph-ts');
const noop = () => {};

// index once — ts-morph project creation is the slow part
let db;
beforeAll(async () => {
  db = openDb(FIXTURE, { memory: true });
  const res = await rebuild(db, FIXTURE);
  expect(res).toMatchObject({ ok: true, files: 5 });
}, 60_000);

describe('graph db (AC-8.1)', () => {
  it('AC-8.1: upserts are idempotent and SQL is parameterized end-to-end', () => {
    const d = openDb('.', { memory: true });
    upsertNode(d, { id: 'export:a.ts#x', kind: 'export', name: "x'); DROP TABLE nodes; --", file: 'a.ts' });
    upsertNode(d, { id: 'export:a.ts#x', kind: 'export', name: "x'); DROP TABLE nodes; --", file: 'a.ts' });
    upsertEdge(d, { src: 'file:a.ts', dst: 'file:b.ts', kind: 'imports' });
    upsertEdge(d, { src: 'file:a.ts', dst: 'file:b.ts', kind: 'imports' });
    expect(counts(d)).toEqual({ nodes: 1, edges: 1 });
    expect(findComponent(d, "'); DROP")).toHaveLength(1); // still queryable — nothing was executed
    expect(() => upsertNode(d, { id: 'x', kind: 'nonsense', name: 'x' })).toThrow(/unknown node kind/);
  });

  it('AC-8.1: rebuild wipes and repopulates (re-run does not duplicate)', async () => {
    const before = counts(db);
    const res = await rebuild(db, FIXTURE);
    expect(res.ok).toBe(true);
    expect(counts(db)).toEqual(before);
  });

  it('deleteFileScope keeps ticket edges (git history is not file content)', () => {
    const d = openDb('.', { memory: true });
    upsertNode(d, { id: 'file:a.ts', kind: 'file', name: 'a.ts', file: 'a.ts' });
    upsertNode(d, { id: 'ticket:#7', kind: 'ticket', name: '#7' });
    upsertEdge(d, { src: 'ticket:#7', dst: 'file:a.ts', kind: 'ticket' });
    upsertEdge(d, { src: 'file:a.ts', dst: 'file:b.ts', kind: 'imports' });
    deleteFileScope(d, 'a.ts');
    expect(counts(d).edges).toBe(1); // imports edge gone, ticket edge kept
  });
});

describe('indexer (AC-8.2)', () => {
  it('AC-8.2: extracts components, exports, props interfaces from the fixture', () => {
    const comps = findComponent(db, 'utton').filter((r) => r.kind === 'component');
    expect(comps.map((c) => c.name)).toContain('Button');
    expect(findComponent(db, 'formatDate')[0]).toMatchObject({ kind: 'export', name: 'formatDate' });
    const props = similarProps(db, ['label', 'onClick', 'variant']);
    expect(props[0]).toMatchObject({ name: 'ButtonProps', overlap: 3 });
  });

  it('AC-8.2: file kinds and typed edges — imports/tests/documents', () => {
    expect(fileKind('src/Card.test.tsx')).toBe('test');
    expect(fileKind('src/Button.stories.tsx')).toBe('story');
    expect(fileKind('src/Card.tsx')).toBe('file');
    const users = whoUses(db, 'Card');
    expect(users.some((u) => u.user === 'file:src/Card.test.tsx' && u.via === 'imports-file')).toBe(true);
  });

  it('AC-8.2: a repo where ts-morph is unresolvable gets the teaching fallback error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-nots-'));
    const res = await loadTsMorph(dir);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/grep-first|fallback/i);
    expect(res.error).toMatch(/permanent/i);
  });
});

describe('MCP stdio protocol (AC-8.3)', () => {
  const handler = () => makeHandler({ db, root: FIXTURE, graphEnabled: true });
  const call = (name, args) => handler()({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

  it('AC-8.3: initialize, tools/list, tools/call round-trip', () => {
    const h = handler();
    const init = h({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
    expect(init.result.protocolVersion).toBeTruthy();
    expect(init.result.serverInfo.name).toBe('forge-graph');
    const list = h({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(list.result.tools.map((t) => t.name).sort()).toEqual(
      ['blast_radius', 'code_for_ticket', 'find_component', 'reuse_candidates', 'similar_props', 'who_uses'],
    );
    const res = call('find_component', { query: 'Button' });
    expect(res.result.isError).toBe(false);
    expect(JSON.parse(res.result.content[0].text).length).toBeGreaterThan(0);
  });

  it('AC-8.3: unknown tool, invalid input, unknown method, notification', () => {
    const h = handler();
    expect(call('rm_rf', {}).error.code).toBe(-32602);
    expect(call('find_component', {}).error.message).toMatch(/missing required 'query'/);
    expect(call('find_component', { query: 'x', extra: 1 }).error.message).toMatch(/unknown argument/);
    expect(call('similar_props', { members: [] }).error.message).toMatch(/>= 1 items/);
    expect(h({ jsonrpc: '2.0', id: 9, method: 'nope' }).error.code).toBe(-32601);
    expect(h({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(null);
    expect(h({ method: 'tools/list' }).error.code).toBe(-32600);
  });

  it('features.graph off: every call answers with the teaching error, server never crashes', () => {
    const h = makeHandler({ db: null, root: FIXTURE, graphEnabled: false });
    const res = h({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_component', arguments: { query: 'x' } } });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('features.graph is off');
  });

  it('AC-105.1: graph state re-reads features.graph per call — toggle needs no restart, db opened lazily + memoized', async () => {
    let enabled = false;
    const opened = [];
    const open = () => { const db = { closed: false, close() { this.closed = true; } }; opened.push(db); return db; };
    const state = makeGraphState(FIXTURE, { isEnabled: async () => enabled, open });

    // off at startup: no db opened
    expect(await state()).toMatchObject({ enabled: false, db: null });
    expect(opened.length).toBe(0);

    // flip on mid-session (as `graphctl rebuild` would): next call sees it, db opened lazily
    enabled = true;
    const s1 = await state();
    expect(s1.enabled).toBe(true);
    expect(s1.db).toBe(opened[0]);
    expect(opened.length).toBe(1);

    // memoized — a second enabled call reuses the same db, no reopen
    expect((await state()).db).toBe(opened[0]);
    expect(opened.length).toBe(1);

    // flip off: db closed and dropped
    enabled = false;
    expect(await state()).toMatchObject({ enabled: false, db: null });
    expect(opened[0].closed).toBe(true);
  });
});

describe('queries (AC-8.4)', () => {
  it('AC-8.4: who_uses Button — renders edges + importing files', () => {
    const users = whoUses(db, 'Button');
    expect(users.some((u) => u.user === 'component:src/Card.tsx#Card' && u.via === 'renders')).toBe(true);
    expect(users.some((u) => u.user === 'file:src/Card.tsx')).toBe(true);
    expect(users.some((u) => u.user === 'file:src/Button.stories.tsx')).toBe(true);
  });

  it('AC-8.4: blast_radius is transitive and buckets tests/stories', () => {
    const r = blastRadius(db, ['src/Button.tsx']);
    expect(r.files).toContain('src/Card.tsx');
    expect(r.tests).toContain('src/Card.test.tsx'); // via Card, not a direct import
    expect(r.stories).toContain('src/Button.stories.tsx');
  });

  it('AC-8.4: similar_props ranks by member overlap; reuse_candidates ranks by keywords', () => {
    const props = similarProps(db, ['onClick', 'title']);
    expect(props[0].name).toBe('CardProps');
    const reuse = reuseCandidates(db, 'a clickable button with a label');
    expect(reuse[0].name).toMatch(/Button/);
    expect(reuseCandidates(db, '!!')).toEqual([]);
  });
});

describe('ticket edges (AC-8.5)', () => {
  it('AC-8.5: parseTicketLog maps (#n) commits to their files', () => {
    const log = [
      '@@forge@@feat(board): digest flow metrics (#9)', '',
      'plugin/scripts/board/digest.mjs', 'tests/board.test.mjs', '',
      '@@forge@@chore: no ref here', '',
      'README.md', '',
      '@@forge@@fix(learn): nul byte (#9) and also (#12)', '',
      'plugin/scripts/learn/distill.mjs', '',
    ].join('\n');
    const map = parseTicketLog(log);
    expect([...map.get('9')]).toEqual(expect.arrayContaining(['plugin/scripts/board/digest.mjs', 'plugin/scripts/learn/distill.mjs']));
    expect([...map.get('12')]).toEqual(['plugin/scripts/learn/distill.mjs']);
    expect(map.get('9').has('README.md')).toBe(false); // ref-less commit's files attach to nothing
  });

  it('AC-8.5: scanTickets writes ticket nodes/edges; code_for_ticket reads them back', async () => {
    const d = openDb('.', { memory: true });
    const exec = async () => ({ ok: true, code: 0, stdout: '@@forge@@feat: thing (#42)\n\nsrc/thing.ts\nsrc/other.ts\n', stderr: '' });
    const res = await scanTickets(d, '.', exec);
    expect(res).toMatchObject({ ok: true, tickets: 1, edges: 2 });
    expect(codeForTicket(d, '#42').sort()).toEqual(['src/other.ts', 'src/thing.ts']);
    expect(codeForTicket(d, '42').sort()).toEqual(['src/other.ts', 'src/thing.ts']);
    expect(codeForTicket(d, '#7')).toEqual([]);
  });
});

describe('path hardening (AC-8.6)', () => {
  it('AC-8.6: canonicalize refuses traversal outside the repo root', () => {
    expect(canonicalize(FIXTURE, 'src/Button.tsx')).toBe('src/Button.tsx');
    expect(canonicalize(FIXTURE, './src/../src/Card.tsx')).toBe('src/Card.tsx');
    expect(canonicalize(FIXTURE, '../../secrets.txt')).toBe(null);
    expect(canonicalize(FIXTURE, '/etc/passwd')).toBe(null);
    // a drive-letter path is only absolute on Windows; on POSIX it's a (weird) relative name
    if (process.platform === 'win32') expect(canonicalize(FIXTURE, 'C:\\Windows\\system32')).toBe(null);
  });

  it('AC-8.6: blast_radius via the server refuses escaping paths', () => {
    const h = makeHandler({ db, root: FIXTURE, graphEnabled: true });
    const res = h({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'blast_radius', arguments: { files: ['../../../etc'] } } });
    expect(res.error.message).toMatch(/inside the repo root/);
  });
});

describe('incremental + hook (AC-8.7)', () => {
  it('AC-8.7: reindex touches only the named files rows', async () => {
    const d = openDb(FIXTURE, { memory: true });
    await rebuild(d, FIXTURE);
    upsertNode(d, { id: 'export:src/utils.ts#SENTINEL', kind: 'export', name: 'SENTINEL', file: 'src/utils.ts' });
    const before = counts(d);
    const res = await indexFiles(d, FIXTURE, ['src/Button.tsx']);
    expect(res).toMatchObject({ ok: true, files: 1 });
    // Button's rows re-created identically; utils' sentinel untouched
    expect(counts(d)).toEqual(before);
    expect(findComponent(d, 'SENTINEL')).toHaveLength(1);
    const gone = await indexFiles(d, FIXTURE, ['src/utils.ts']);
    expect(gone.ok).toBe(true);
    expect(findComponent(d, 'SENTINEL')).toHaveLength(0); // real reindex replaced the fake row
  });

  it('AC-8.7: install-hook writes post-commit once; re-run is a no-op; foreign hooks are never clobbered', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-hook-'));
    await mkdir(join(dir, '.git'), { recursive: true });
    const first = await installHook(dir);
    expect(first).toMatchObject({ ok: true, installed: true });
    expect(await readFile(join(dir, '.git', 'hooks', 'post-commit'), 'utf8')).toContain(HOOK_MARKER);
    expect(await installHook(dir)).toMatchObject({ ok: true, installed: false });

    const dir2 = await mkdtemp(join(tmpdir(), 'forge-hook2-'));
    await mkdir(join(dir2, '.git', 'hooks'), { recursive: true });
    await writeFile(join(dir2, '.git', 'hooks', 'post-commit'), '#!/bin/sh\necho mine\n', 'utf8');
    const clash = await installHook(dir2);
    expect(clash.ok).toBe(false);
    expect(clash.error).toMatch(/already exists/);
    expect(await readFile(join(dir2, '.git', 'hooks', 'post-commit'), 'utf8')).toContain('echo mine');
  });
});

describe('doctor graph checks (AC-8.8)', () => {
  async function cwdWithGraphOn({ tsconfig }) {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-docgraph-'));
    const committed = JSON.parse(await readFile(join(process.cwd(), '.claude', 'forge.json'), 'utf8'));
    committed.features = { ...(committed.features ?? {}), graph: true };
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'forge.json'), JSON.stringify(committed), 'utf8');
    await writeFile(join(cwd, '.gitignore'), '.forge/\n', 'utf8');
    if (tsconfig) await writeFile(join(cwd, 'tsconfig.json'), '{}', 'utf8');
    return cwd;
  }
  const ghAllOk = () => fakeGh([['auth status', AUTH_OK], ['repo view', REPO_VIEW], [() => true, { ok: false, stderr: 'x' }]]).gh;

  it('AC-8.8: features.graph on + no tsconfig -> actionable ⚠ naming the permanent fallback', async () => {
    const res = await runDoctor({ gh: ghAllOk(), cwd: await cwdWithGraphOn({ tsconfig: false }), log: noop });
    const g = res.results.find((r) => r.name === 'graph');
    expect(g).toMatchObject({ level: 'warn' });
    expect(g.msg).toContain('TypeScript repos only');
  });

  it('AC-8.8: features.graph on + tsconfig but ts-morph unresolvable -> ⚠ with the install hint', async () => {
    const res = await runDoctor({ gh: ghAllOk(), cwd: await cwdWithGraphOn({ tsconfig: true }), log: noop });
    const g = res.results.find((r) => r.name === 'graph');
    expect(g).toMatchObject({ level: 'warn' });
    expect(g.hint).toContain('ts-morph');
  });
});

describe('schema slots', () => {
  it('node kinds carry the full spec §9 set (embedding column reserved)', () => {
    for (const k of ['file', 'component', 'export', 'props-interface', 'token', 'story', 'test', 'icon']) {
      expect(NODE_KINDS).toContain(k);
    }
    expect(TOOLS).toHaveLength(6);
  });
});
