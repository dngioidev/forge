/**
 * Graph store (spec §9; SP8 T1): SQLite via built-in node:sqlite — no native
 * builds on Windows, zero deps. Parameterized SQL ONLY; every statement takes
 * bound values. The embedding column is a schema slot (spec backlog), unused.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const DB_RELPATH = join('.forge', 'graph.db');

export const NODE_KINDS = ['file', 'component', 'export', 'props-interface', 'token', 'story', 'test', 'icon', 'ticket'];
export const EDGE_KINDS = ['imports', 'renders', 'uses-token', 'tests', 'documents', 'ticket'];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    file TEXT,
    meta TEXT,
    embedding BLOB
  );
  CREATE INDEX IF NOT EXISTS idx_nodes_kind_name ON nodes(kind, name);
  CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file);
  CREATE TABLE IF NOT EXISTS edges (
    src TEXT NOT NULL,
    dst TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (src, dst, kind)
  );
  CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst, kind);
`;

export function openDb(cwd, { memory = false } = {}) {
  let db;
  if (memory) {
    db = new DatabaseSync(':memory:');
  } else {
    const path = join(cwd, DB_RELPATH);
    mkdirSync(dirname(path), { recursive: true });
    db = new DatabaseSync(path);
  }
  db.exec(SCHEMA);
  return db;
}

/** Rebuild = wipe and repopulate; the graph is derived state, always safe to drop. */
export function resetDb(db) {
  db.exec('DELETE FROM edges; DELETE FROM nodes;');
}

export function upsertNode(db, { id, kind, name, file = null, meta = null }) {
  if (!NODE_KINDS.includes(kind)) throw new Error(`unknown node kind '${kind}' — valid: ${NODE_KINDS.join(', ')}`);
  db.prepare(
    'INSERT INTO nodes (id, kind, name, file, meta) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name, file = excluded.file, meta = excluded.meta',
  ).run(id, kind, name, file, meta == null ? null : JSON.stringify(meta));
}

export function upsertEdge(db, { src, dst, kind }) {
  if (!EDGE_KINDS.includes(kind)) throw new Error(`unknown edge kind '${kind}' — valid: ${EDGE_KINDS.join(', ')}`);
  db.prepare('INSERT OR IGNORE INTO edges (src, dst, kind) VALUES (?, ?, ?)').run(src, dst, kind);
}

/**
 * Incremental unit: drop what a file CONTRIBUTED before re-adding it — only
 * edges originating (src) in the file's scope. Edges pointing AT this file
 * belong to other files' scopes and must survive a reindex of this one;
 * ticket edges originate from ticket nodes and are untouched by design.
 */
export function deleteFileScope(db, file) {
  const ids = db.prepare('SELECT id FROM nodes WHERE file = ? OR id = ?').all(file, `file:${file}`).map((r) => r.id);
  if (ids.length === 0) return;
  const ph = ids.map(() => '?').join(', ');
  db.prepare(`DELETE FROM edges WHERE src IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM nodes WHERE id IN (${ph})`).run(...ids);
}

export function counts(db) {
  return {
    nodes: db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n,
    edges: db.prepare('SELECT COUNT(*) AS n FROM edges').get().n,
  };
}
