import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGY_PKG_RELPATH, readEmittedMarker, resolveOwnManifest, checkAgyStaleness,
  checkAgyPackageIntegrity, findUnrewrittenPlaceholders, checkAgyRewrite,
  checkAgyJournal, checkAgyAdapter, checkAgyOffload,
} from '../../plugin/scripts/lib/agy-checks.mjs';
import { emitAgyPlugin } from '../../plugin/scripts/agy/emit.mjs';

const byName = (results, name) => results.filter((r) => r.name === name);
const okExec = async () => ({ ok: true, stdout: 'agy 1.1.7', stderr: '', code: 0 });
const missingExec = async () => ({ ok: false, stdout: '', stderr: 'ENOENT', code: -1 });

async function tmpDir(prefix = 'agy-checks-') {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Emit a REAL agy package into a fresh tmp dir at the conventional relpath under `cwd`. */
async function emitReal(cwd, version) {
  const pkgDir = join(cwd, AGY_PKG_RELPATH);
  const res = await emitAgyPlugin({ destRoot: pkgDir, log: () => {} });
  expect(res.ok).toBe(true);
  if (version) {
    const p = join(pkgDir, 'plugin.json');
    const marker = JSON.parse(await readFile(p, 'utf8'));
    marker.version = version;
    await writeFile(p, JSON.stringify(marker, null, 2), 'utf8');
  }
  return pkgDir;
}

describe('agy-checks — gating (AC.1/AC.5 negative case)', () => {
  it('AC-431.5: no emitted package at .agents/plugins/forge -> checkAgyAdapter produces zero results (fully silent)', async () => {
    const cwd = await tmpDir();
    const results = [];
    await checkAgyAdapter({ cwd, exec: okExec, results });
    expect(results).toEqual([]);
  });

  it('readEmittedMarker returns null for a dir with no plugin.json, or a plugin.json whose name != "forge"', async () => {
    const cwd = await tmpDir();
    expect(await readEmittedMarker(cwd)).toBeNull();
    await writeFile(join(cwd, 'plugin.json'), JSON.stringify({ name: 'not-forge' }), 'utf8');
    expect(await readEmittedMarker(cwd)).toBeNull();
  });
});

describe('agy-checks — checkAgyAdapter against a REAL emitted package', () => {
  it('AC-431.1: a freshly emitted package (own version) -> agy-cli ok, agy-package ok, agy-rewrite ok, no journal row', async () => {
    const cwd = await tmpDir();
    const own = await resolveOwnManifest(); // the real checkout's own manifest — its version is what emit.mjs stamps
    await emitReal(cwd, own.manifest.version);
    const results = [];
    await checkAgyAdapter({ cwd, exec: okExec, results });

    expect(byName(results, 'agy-cli')[0].level).toBe('ok');
    expect(byName(results, 'agy-package')[0].level).toBe('ok');
    expect(byName(results, 'agy-rewrite')[0].level).toBe('ok');
    expect(byName(results, 'agy-journal')).toEqual([]); // absent journal -> silent, not a row
    expect(byName(results, 'agy-staleness')[0].level).toBe('ok');
  });

  it('AC-431.1: agy not on PATH -> agy-cli warns but the rest of the block still runs', async () => {
    const cwd = await tmpDir();
    await emitReal(cwd);
    const results = [];
    await checkAgyAdapter({ cwd, exec: missingExec, results });
    expect(byName(results, 'agy-cli')[0].level).toBe('warn');
    expect(byName(results, 'agy-package')[0].level).toBe('ok');
  });

  it('BREAK IT: removing a generated file (mcp_config.json) -> agy-package fails and names it', async () => {
    const cwd = await tmpDir();
    const pkgDir = await emitReal(cwd);
    await rm(join(pkgDir, 'mcp_config.json'));
    const results = [];
    await checkAgyAdapter({ cwd, exec: okExec, results });
    const row = byName(results, 'agy-package')[0];
    expect(row.level).toBe('fail');
    expect(row.msg).toMatch(/mcp_config\.json/);
  });

  it('BREAK IT: removing a shim (hooks/agy-deny.mjs) -> agy-package fails and names it', async () => {
    const cwd = await tmpDir();
    const pkgDir = await emitReal(cwd);
    await rm(join(pkgDir, 'hooks', 'agy-deny.mjs'));
    const results = [];
    await checkAgyAdapter({ cwd, exec: okExec, results });
    const row = byName(results, 'agy-package')[0];
    expect(row.level).toBe('fail');
    expect(row.msg).toMatch(/agy-deny\.mjs/);
  });

  it('BREAK IT: corrupting hooks.json (invalid JSON) -> agy-package fails', async () => {
    const cwd = await tmpDir();
    const pkgDir = await emitReal(cwd);
    await writeFile(join(pkgDir, 'hooks.json'), '{ not json', 'utf8');
    const results = [];
    await checkAgyAdapter({ cwd, exec: okExec, results });
    expect(byName(results, 'agy-package')[0].level).toBe('fail');
  });

  it('AC-431.2: BREAK IT: staling the emitted version behind this forge install -> agy-staleness warns', async () => {
    const cwd = await tmpDir();
    await emitReal(cwd, '0.0.1'); // guaranteed lower than any real forge release
    const results = [];
    await checkAgyAdapter({ cwd, exec: okExec, results });
    const row = byName(results, 'agy-staleness')[0];
    expect(row.level).toBe('warn');
    expect(row.msg).toMatch(/stale/);
  });

  it('AC-431.2: BREAK IT: an emitted version newer than this forge install -> agy-staleness warns the other direction', async () => {
    const cwd = await tmpDir();
    await emitReal(cwd, '999.0.0');
    const results = [];
    await checkAgyAdapter({ cwd, exec: okExec, results });
    const row = byName(results, 'agy-staleness')[0];
    expect(row.level).toBe('warn');
    expect(row.msg).toMatch(/newer/);
  });
});

describe('agy-checks — checkAgyRewrite / #294 regression class', () => {
  it('a clean real emit has no unrewritten ${CLAUDE_PLUGIN_ROOT} placeholders', async () => {
    const cwd = await tmpDir();
    const pkgDir = await emitReal(cwd);
    expect(await findUnrewrittenPlaceholders(pkgDir)).toEqual([]);
    expect((await checkAgyRewrite({ pkgDir })).level).toBe('ok');
  });

  it('BREAK IT: hand-editing an emitted skill to reintroduce ${CLAUDE_PLUGIN_ROOT} -> warns and names the file', async () => {
    const cwd = await tmpDir();
    const pkgDir = await emitReal(cwd);
    const skillFiles = await readdir(join(pkgDir, 'skills'), { withFileTypes: true });
    const firstSkillDir = skillFiles.find((e) => e.isDirectory());
    const target = join(pkgDir, 'skills', firstSkillDir.name, 'SKILL.md');
    const before = await readFile(target, 'utf8').catch(() => '# stub\n');
    await writeFile(target, before + '\nnode "${CLAUDE_PLUGIN_ROOT}/scripts/x.mjs"\n', 'utf8');

    const hits = await findUnrewrittenPlaceholders(pkgDir);
    expect(hits.length).toBeGreaterThan(0);
    const row = await checkAgyRewrite({ pkgDir });
    expect(row.level).toBe('warn');
    expect(row.msg).toMatch(/CLAUDE_PLUGIN_ROOT/);
  });
});

describe('agy-checks — checkAgyPackageIntegrity (unit-level, synthetic fixtures)', () => {
  async function fixture(overrides = {}) {
    const cwd = await tmpDir();
    await mkdir(join(cwd, 'hooks'), { recursive: true });
    await writeFile(join(cwd, 'plugin.json'), JSON.stringify({ name: 'forge', version: '1.0.0', ...overrides.plugin }), 'utf8');
    await writeFile(join(cwd, 'mcp_config.json'), JSON.stringify(overrides.mcp ?? { mcpServers: { 'forge-graph': { command: 'node', args: ['mcp/graph/server.mjs'] } } }), 'utf8');
    await writeFile(join(cwd, 'hooks.json'), JSON.stringify(overrides.hooks ?? {
      'forge-safety': { PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'x' }] }] },
      'forge-capture': { PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'y' }] }] },
    }), 'utf8');
    if (overrides.shims !== false) {
      await writeFile(join(cwd, 'hooks', 'agy-deny.mjs'), '// stub', 'utf8');
      await writeFile(join(cwd, 'hooks', 'agy-capture.mjs'), '// stub', 'utf8');
    }
    return cwd;
  }

  it('a well-formed synthetic package -> ok', async () => {
    const pkgDir = await fixture();
    const marker = JSON.parse(await readFile(join(pkgDir, 'plugin.json'), 'utf8'));
    const row = await checkAgyPackageIntegrity({ pkgDir, marker });
    expect(row.level).toBe('ok');
  });

  it('missing forge-graph in mcp_config.json -> fail', async () => {
    const pkgDir = await fixture({ mcp: { mcpServers: {} } });
    const marker = JSON.parse(await readFile(join(pkgDir, 'plugin.json'), 'utf8'));
    const row = await checkAgyPackageIntegrity({ pkgDir, marker });
    expect(row.level).toBe('fail');
    expect(row.msg).toMatch(/forge-graph/);
  });

  it('missing forge-capture PostToolUse in hooks.json -> fail', async () => {
    const pkgDir = await fixture({ hooks: { 'forge-safety': { PreToolUse: [{}] } } });
    const marker = JSON.parse(await readFile(join(pkgDir, 'plugin.json'), 'utf8'));
    const row = await checkAgyPackageIntegrity({ pkgDir, marker });
    expect(row.level).toBe('fail');
    expect(row.msg).toMatch(/forge-capture/);
  });
});

describe('agy-checks — checkAgyJournal', () => {
  it('absent journal -> null (silent, not a warn)', async () => {
    const cwd = await tmpDir();
    expect(await checkAgyJournal({ cwd })).toBeNull();
  });

  it('valid JSONL -> ok with a count', async () => {
    const cwd = await tmpDir();
    await mkdir(join(cwd, '.forge'), { recursive: true });
    await writeFile(join(cwd, '.forge', 'agy-journal.jsonl'), '{"a":1}\n{"a":2}\n', 'utf8');
    const row = await checkAgyJournal({ cwd });
    expect(row.level).toBe('ok');
    expect(row.msg).toMatch(/2 entries/);
  });

  it('BREAK IT: a malformed line -> warn, names the line number, never echoes raw content', async () => {
    const cwd = await tmpDir();
    await mkdir(join(cwd, '.forge'), { recursive: true });
    await writeFile(join(cwd, '.forge', 'agy-journal.jsonl'), '{"a":1}\nnot json\n', 'utf8');
    const row = await checkAgyJournal({ cwd });
    expect(row.level).toBe('warn');
    expect(row.msg).toMatch(/line 2/);
    expect(row.msg).not.toMatch(/not json/);
  });
});

describe('agy-checks — resolveOwnManifest / checkAgyStaleness (injected ownRoot fixtures)', () => {
  it('Claude layout (root/.claude-plugin/plugin.json) resolves first', async () => {
    const root = await tmpDir();
    await mkdir(join(root, '.claude-plugin'), { recursive: true });
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'forge', version: '2.0.0' }), 'utf8');
    const own = await resolveOwnManifest(root);
    expect(own.manifest.version).toBe('2.0.0');
  });

  it('co-located layout (root/plugin.json) resolves when no .claude-plugin/ exists', async () => {
    const root = await tmpDir();
    await writeFile(join(root, 'plugin.json'), JSON.stringify({ name: 'forge', version: '3.0.0' }), 'utf8');
    const own = await resolveOwnManifest(root);
    expect(own.manifest.version).toBe('3.0.0');
  });

  it('neither layout present -> null (staleness stays silent, never guesses)', async () => {
    const root = await tmpDir();
    expect(await resolveOwnManifest(root)).toBeNull();
    const staleness = await checkAgyStaleness({ pkgDir: join(root, 'pkg'), marker: { version: '1.0.0' }, ownRoot: root });
    expect(staleness).toBeNull();
  });

  it('self-comparison (own manifest path === emitted plugin.json path) -> null, not a false "current"', async () => {
    const root = await tmpDir();
    await writeFile(join(root, 'plugin.json'), JSON.stringify({ name: 'forge', version: '1.0.0' }), 'utf8');
    // pkgDir === root -> own.path resolves to the SAME file as pkgDir/plugin.json
    const staleness = await checkAgyStaleness({ pkgDir: root, marker: { version: '1.0.0' }, ownRoot: root });
    expect(staleness).toBeNull();
  });

  it('AC-431.2: emitted plugin.json with no version field -> warn, distinct from a real staleness warn', async () => {
    const root = await tmpDir();
    await mkdir(join(root, '.claude-plugin'), { recursive: true });
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'forge', version: '1.0.0' }), 'utf8');
    const pkgDir = join(root, 'pkg');
    const staleness = await checkAgyStaleness({ pkgDir, marker: { name: 'forge' }, ownRoot: root });
    expect(staleness.level).toBe('warn');
    expect(staleness.msg).toMatch(/no version field/);
  });
});

describe('agy-checks — checkAgyOffload (AC.4, independent of the adapter block)', () => {
  it('AC-431.5: features.agy off -> null (silent)', async () => {
    expect(await checkAgyOffload({ cfg: { features: {} }, exec: okExec })).toBeNull();
    expect(await checkAgyOffload({ cfg: {}, exec: okExec })).toBeNull();
  });

  it('AC-431.4: features.agy on + agy reachable -> ok', async () => {
    const row = await checkAgyOffload({ cfg: { features: { agy: true } }, exec: okExec });
    expect(row.level).toBe('ok');
  });

  it('AC-431.4: features.agy on + agy NOT reachable -> warn', async () => {
    const row = await checkAgyOffload({ cfg: { features: { agy: true } }, exec: missingExec });
    expect(row.level).toBe('warn');
  });

  it('back-compat geminiSecondOpinion flag also gates the check (core.mjs agyEnabled)', async () => {
    const row = await checkAgyOffload({ cfg: { features: { geminiSecondOpinion: true } }, exec: missingExec });
    expect(row.level).toBe('warn');
  });

  it('fires even when no adapter package was ever emitted — decoupled from checkAgyAdapter', async () => {
    const cwd = await tmpDir(); // no .agents/plugins/forge here at all
    const adapterResults = [];
    await checkAgyAdapter({ cwd, exec: missingExec, results: adapterResults });
    expect(adapterResults).toEqual([]); // adapter block silent
    const offload = await checkAgyOffload({ cfg: { features: { agy: true } }, exec: missingExec });
    expect(offload.level).toBe('warn'); // offload block still fires
  });
});
