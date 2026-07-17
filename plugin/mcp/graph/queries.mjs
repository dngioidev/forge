/**
 * Graph queries (spec §9; SP8 T3) — the six MCP tools' logic, pure over the
 * db handle. Parameterized SQL only. Ranked matches are keyword heuristics,
 * not embeddings (schema slot reserved; spec backlog).
 */

const parseMeta = (r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null });

export function findComponent(db, query) {
  const like = `%${query}%`;
  return db.prepare(
    "SELECT id, kind, name, file, meta FROM nodes WHERE kind IN ('component', 'export') AND name LIKE ? ORDER BY kind, name LIMIT 25",
  ).all(like).map(parseMeta);
}

/** Direct users of a symbol (renders edges) or token (uses-token edges), plus file-level importers. */
export function whoUses(db, symbol) {
  const direct = db.prepare(
    "SELECT e.src, e.kind, n.file FROM edges e LEFT JOIN nodes n ON n.id = e.src " +
    "WHERE e.kind IN ('renders', 'uses-token') AND (e.dst LIKE ? OR e.dst = ?) LIMIT 100",
  ).all(`%#${symbol}`, symbol).map((r) => ({ user: r.src, via: r.kind, file: r.file }));
  const files = db.prepare('SELECT file FROM nodes WHERE name = ? AND file IS NOT NULL').all(symbol).map((r) => r.file);
  const importers = files.length === 0 ? [] : db.prepare(
    `SELECT DISTINCT e.src FROM edges e WHERE e.kind IN ('imports', 'tests', 'documents') AND e.dst IN (${files.map(() => '?').join(', ')})`,
  ).all(...files.map((f) => `file:${f}`)).map((r) => ({ user: r.src, via: 'imports-file' }));
  return [...direct, ...importers];
}

/** Props interfaces ranked by member overlap with the given member list. */
export function similarProps(db, members) {
  const want = new Set(members.map((m) => m.toLowerCase()));
  return db.prepare("SELECT id, name, file, meta FROM nodes WHERE kind = 'props-interface'").all()
    .map(parseMeta)
    .map((r) => {
      const have = (r.meta?.members ?? []).map((m) => m.toLowerCase());
      const overlap = have.filter((m) => want.has(m)).length;
      return { ...r, overlap, of: want.size };
    })
    .filter((r) => r.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 10);
}

/** Transitive dependents of files[] over imports/tests/documents edges. */
export function blastRadius(db, files) {
  const hit = new Set(files.map((f) => `file:${f}`));
  let frontier = [...hit];
  while (frontier.length > 0) {
    const ph = frontier.map(() => '?').join(', ');
    const next = db.prepare(
      `SELECT DISTINCT src FROM edges WHERE kind IN ('imports', 'tests', 'documents') AND dst IN (${ph})`,
    ).all(...frontier).map((r) => r.src).filter((s) => !hit.has(s));
    next.forEach((s) => hit.add(s));
    frontier = next;
  }
  const ids = [...hit];
  const ph = ids.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT id, kind, name FROM nodes WHERE id IN (${ph})`).all(...ids);
  return {
    files: rows.filter((r) => r.kind === 'file').map((r) => r.name).filter((n) => !files.includes(n)),
    tests: rows.filter((r) => r.kind === 'test').map((r) => r.name),
    stories: rows.filter((r) => r.kind === 'story').map((r) => r.name),
  };
}

export function codeForTicket(db, ticket) {
  const id = `ticket:${ticket.startsWith('#') ? ticket : `#${ticket}`}`;
  return db.prepare("SELECT dst FROM edges WHERE kind = 'ticket' AND src = ?").all(id)
    .map((r) => r.dst.replace(/^file:/, ''));
}

/** Reuse candidates ranked by keyword hits across export/component/story names and props members. */
export function reuseCandidates(db, description) {
  const words = [...new Set(description.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3))];
  if (words.length === 0) return [];
  const rows = db.prepare(
    "SELECT id, kind, name, file, meta FROM nodes WHERE kind IN ('component', 'export', 'props-interface', 'story')",
  ).all().map(parseMeta);
  return rows
    .map((r) => {
      const hay = `${r.name} ${r.file ?? ''} ${(r.meta?.members ?? []).join(' ')}`.toLowerCase();
      const score = words.filter((w) => hay.includes(w)).length;
      return { id: r.id, kind: r.kind, name: r.name, file: r.file, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 10);
}
