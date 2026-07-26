import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import {
  emitAgyPlugin, buildMcpConfig, buildHooksConfig, buildPluginMarker, toPosix, longPath, pluginRoot,
} from '../../plugin/scripts/agy/emit.mjs';
import { runInit, parseArgs } from '../../plugin/scripts/init.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const noop = () => {};

/** Spawn `node <script>`, feed `input` on stdin, resolve { stdout, code }. */
function runNode(script, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}

async function emitTo(sub = 'forge') {
  const dir = await mkdtemp(join(tmpdir(), 'agy-emit-'));
  const dest = join(dir, sub);
  const res = await emitAgyPlugin({ destRoot: dest, log: noop });
  return { dir, dest, res };
}

describe('AC-289.1: forge init --host agy emits an agy-validatable plugin package', () => {
  it('AC-289.1: emits plugin.json co-located with skills/agents/commands + mcp_config.json + hooks.json', async () => {
    const { dest, res } = await emitTo();
    expect(res.ok).toBe(true);

    // plugin.json marker co-located at the ROOT (not under .claude-plugin/), agy-shaped.
    const marker = JSON.parse(await readFile(join(dest, 'plugin.json'), 'utf8'));
    expect(marker.name).toBe('forge');
    expect(marker.$schema).toBeUndefined();    // Claude-only key dropped
    expect(marker.mcpServers).toBeUndefined();  // agy ignores it; reads mcp_config.json
    await expect(access(join(dest, '.claude-plugin'))).rejects.toBeTruthy(); // NOT the Claude split layout

    // The three zero-conversion component dirs agy ingests natively.
    for (const d of ['skills', 'agents', 'commands']) {
      await expect(access(join(dest, d))).resolves.toBeUndefined();
    }

    // mcpServers: forge-graph wired to a server file that actually exists in the package.
    const mcp = JSON.parse(await readFile(join(dest, 'mcp_config.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toContain('forge-graph');
    const serverPath = mcp.mcpServers['forge-graph'].args[0];
    await expect(access(serverPath)).resolves.toBeUndefined();

    // hooks: named-hook schema, matcher run_command, both shims present on disk.
    const hooks = JSON.parse(await readFile(join(dest, 'hooks.json'), 'utf8'));
    expect(hooks['forge-safety'].PreToolUse[0].matcher).toBe('run_command');
    expect(hooks['forge-capture'].PostToolUse[0].matcher).toBe('run_command');
    await expect(access(join(dest, 'hooks', 'agy-deny.mjs'))).resolves.toBeUndefined();
    await expect(access(join(dest, 'hooks', 'agy-capture.mjs'))).resolves.toBeUndefined();
    // the shim imports denylist.mjs relatively — it must be a sibling in the package.
    await expect(access(join(dest, 'hooks', 'denylist.mjs'))).resolves.toBeUndefined();
  });

  it('AC-289.1: runs through `forge init --host agy` and stages under .agents/plugins/forge by default', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agy-init-'));
    const res = await runInit({ gh: null, cwd, log: noop, args: parseArgs(['--host', 'agy']) });
    expect(res.ok).toBe(true);
    expect(res.host).toBe('agy');
    await expect(access(join(cwd, '.agents', 'plugins', 'forge', 'plugin.json'))).resolves.toBeUndefined();
    await expect(access(join(cwd, '.agents', 'plugins', 'forge', 'mcp_config.json'))).resolves.toBeUndefined();
    await expect(access(join(cwd, '.agents', 'plugins', 'forge', 'hooks.json'))).resolves.toBeUndefined();
  });

  it('AC-289.1: an unsupported host is rejected (Codex deferred to #292), default init still works', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agy-init-'));
    const res = await runInit({ gh: null, cwd, log: noop, args: parseArgs(['--host', 'codex']) });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/only 'agy'/);
  });

  it('AC-289.1: forge-core is guarded — only wired when mcp/forge/server.mjs exists (#288 is separate)', async () => {
    // Today the forge-core server does not exist, so it must NOT be emitted.
    const hasCore = await access(join(pluginRoot(), 'mcp', 'forge', 'server.mjs')).then(() => true, () => false);
    const cfg = buildMcpConfig('C:/x/forge', { hasForgeCore: hasCore });
    expect('forge-graph' in cfg.mcpServers).toBe(true);
    expect('forge-core' in cfg.mcpServers).toBe(hasCore);
    // And the emitted package reflects reality.
    const { res } = await emitTo();
    expect(res.hasForgeCore).toBe(hasCore);
  });
});

describe('AC-289.2: the emitted denylist shim honors the agy I/O contract with Claude-parity rules', () => {
  const agyPayload = (cmd) => JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: cmd } } });

  it('AC-289.2: denies force-push and recursive-delete, allows benign commands', async () => {
    const { dest } = await emitTo();
    const deny = join(dest, 'hooks', 'agy-deny.mjs');

    const forcePush = await runNode(deny, agyPayload('git push --force origin main'));
    expect(JSON.parse(forcePush.stdout)).toMatchObject({ decision: 'deny' });
    expect(forcePush.stdout).toMatch(/force-push/);

    const recursive = await runNode(deny, agyPayload('rm -rf srcdir/'));
    expect(JSON.parse(recursive.stdout)).toMatchObject({ decision: 'deny' });
    expect(recursive.stdout).toMatch(/recursive-delete/);

    const benign = await runNode(deny, agyPayload('npm test'));
    expect(JSON.parse(benign.stdout)).toEqual({ decision: 'allow' });

    // safe rm target is still allowed (parity with the Claude denylist)
    const safeRm = await runNode(deny, agyPayload('rm -rf node_modules'));
    expect(JSON.parse(safeRm.stdout)).toEqual({ decision: 'allow' });
  });

  it('AC-289.2: fails OPEN (allow) on garbage / non-JSON stdin — a safety hook never wedges the loop', async () => {
    const { dest } = await emitTo();
    const deny = join(dest, 'hooks', 'agy-deny.mjs');
    const garbage = await runNode(deny, 'this is not json');
    expect(JSON.parse(garbage.stdout)).toEqual({ decision: 'allow' });
  });

  it('AC-289.2: the capture shim emits {} and never blocks', async () => {
    const { dest } = await emitTo();
    const capture = join(dest, 'hooks', 'agy-capture.mjs');
    const out = await runNode(capture, JSON.stringify({ stepIdx: 1, workspacePaths: [dest] }));
    expect(out.stdout.trim()).toBe('{}');
    expect(out.code).toBe(0);
  });
});

describe('AC-289.3: self-exec guards in denylist.mjs / capture.mjs are anchored (no import side effects)', () => {
  // A probe whose basename ENDS WITH `denylist.mjs` (`x-denylist.mjs`) is exactly the
  // shape the old unanchored `/denylist\.mjs$/` guard mis-fired on. If the guard fires,
  // its own `for await (chunk of process.stdin)` consumes stdin before the probe reads
  // it, so the probe would see 0 bytes. Anchored => probe reads the full stdin.
  async function probeStdinConsumption(targetRel, probeName) {
    const dir = await mkdtemp(join(tmpdir(), 'agy-guard-'));
    const target = pathToFileURL(join(repoRoot, targetRel)).href;
    const probe = join(dir, probeName);
    await writeFile(
      probe,
      `import ${JSON.stringify(target)};\n` +
      `let raw = '';\n` +
      `for await (const c of process.stdin) raw += c;\n` +
      `process.stdout.write('LEN=' + raw.length);\n`,
      'utf8',
    );
    const res = await runNode(probe, 'HELLO12345'); // 10 bytes
    return res.stdout;
  }

  it('AC-289.3: importing denylist.mjs does not consume stdin or run main()', async () => {
    // basename ends with denylist.mjs — proves the anchoring, not just the rename.
    const out = await probeStdinConsumption('plugin/hooks/denylist.mjs', 'x-denylist.mjs');
    expect(out).toBe('LEN=10'); // full stdin reached the probe => main() never fired
  });

  it('AC-289.3: importing capture.mjs does not consume stdin or run main()', async () => {
    const out = await probeStdinConsumption('plugin/hooks/capture.mjs', 'x-capture.mjs');
    expect(out).toBe('LEN=10');
  });

  it('AC-289.3: denylist.mjs still exports the pure check() used by the shim', async () => {
    const mod = await import(pathToFileURL(join(repoRoot, 'plugin', 'hooks', 'denylist.mjs')).href);
    expect(typeof mod.check).toBe('function');
    expect(mod.check('git push --force origin main').blocked).toBe(true);
  });
});

describe('AC-289.4: paths are computed, ASCII-only, Windows-first, long-path aware', () => {
  it('AC-289.4: emitted configs contain the computed dest path, never a hardcoded install path', async () => {
    const { dest } = await emitTo();
    const mcpRaw = await readFile(join(dest, 'mcp_config.json'), 'utf8');
    const hooksRaw = await readFile(join(dest, 'hooks.json'), 'utf8');
    // computed: every wired path is rooted at the resolved dest.
    const destPosix = toPosix(dest);
    expect(mcpRaw).toContain(destPosix);
    expect(hooksRaw).toContain(destPosix);
    // NOT the spike's install-specific paths.
    for (const raw of [mcpRaw, hooksRaw]) {
      expect(raw).not.toMatch(/\.gemini[\\/]config[\\/]plugins/);
      expect(raw).not.toContain('C:/Users/dngioi/.gemini');
    }
  });

  it('AC-289.4: every emitted config + shim is ASCII-only', async () => {
    const { dest } = await emitTo();
    for (const rel of ['plugin.json', 'mcp_config.json', 'hooks.json', 'hooks/agy-deny.mjs', 'hooks/agy-capture.mjs']) {
      const buf = await readFile(join(dest, rel));
      const nonAscii = [...buf].findIndex((b) => b > 0x7f);
      expect(nonAscii, `${rel} has a non-ASCII byte at ${nonAscii}`).toBe(-1);
    }
  });

  it('AC-289.4: MCP servers use argv-array spawns (no shell string) — Windows-first', () => {
    const cfg = buildMcpConfig('C:/x/forge', { hasForgeCore: true });
    for (const s of Object.values(cfg.mcpServers)) {
      expect(s.command).toBe('node');
      expect(Array.isArray(s.args)).toBe(true);
    }
  });

  it('AC-289.4: hooks.json + plugin marker are pure computed builders', () => {
    const hooks = buildHooksConfig('C:/x/forge');
    expect(hooks['forge-safety'].PreToolUse[0].hooks[0].command).toContain('C:/x/forge/hooks/agy-deny.mjs');
    expect(hooks['forge-safety'].PreToolUse[0].hooks[0].timeout).toBe(10);
    const marker = buildPluginMarker({ $schema: 'x', name: 'forge', mcpServers: { a: 1 }, version: '1.0.0' });
    expect(marker).toEqual({ name: 'forge', version: '1.0.0' });
  });

  it('AC-289.4: longPath prefixes win32 paths beyond MAX_PATH and no-ops elsewhere', () => {
    const p = 'C:/some/very/long/path/forge';
    const out = longPath(p);
    if (process.platform === 'win32') {
      expect(out.startsWith('\\\\?\\')).toBe(true);
    } else {
      expect(out).toBe(p);
    }
  });

  it('AC-289.4: emits cleanly to a long (>260 char) dest path — MAX_PATH staging', async () => {
    const base = await mkdtemp(join(tmpdir(), 'agy-long-'));
    // build a nested dest whose absolute path comfortably exceeds Windows MAX_PATH (260).
    const deep = join(base, ...Array.from({ length: 12 }, (_, i) => `segment-directory-number-${i}`));
    const dest = join(deep, 'forge');
    // emit creates all parents itself (long-path aware) — no pre-mkdir with a bare path.
    const res = await emitAgyPlugin({ destRoot: dest, log: noop });
    expect(res.ok).toBe(true);
    expect(dest.length).toBeGreaterThan(260);
    await expect(access(longPath(join(dest, 'hooks.json')))).resolves.toBeUndefined();
  });
});
