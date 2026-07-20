#!/usr/bin/env node
/**
 * Compile role cards → Claude-native subagent definitions (spec §5). Each agent
 * carries an explicit `model:` pin sized to its job (MODELS below) so subagents
 * never inherit the session's model by default. Read-only roles also get
 * read-only tool allowlists.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CARDS_DIR = join(PLUGIN_ROOT, 'cards');
export const AGENTS_DIR = join(PLUGIN_ROOT, 'agents');

/** The canonical role set — one card + one compiled agent each (spec §5). */
export const ROLES = [
  'implementer', 'reviewer', 'security', 'design-reviewer', 'scoper',
  'test-architect', 'devops', 'designer', 'investigator', 'librarian', 'second-opinion',
  'planner',
];

/**
 * Per-role model pin (#101) — "enough to do, not too generous":
 *   haiku  — pure search/lookup, safe to be cheap
 *   sonnet — reasoning + writing, and the review/security gates (don't skimp on the safety net)
 *   opus   — only second-opinion: its whole value is stronger independent eyes, and it's on-demand
 */
export const MODELS = {
  investigator: 'haiku',
  librarian: 'haiku',
  reviewer: 'sonnet',
  security: 'sonnet',
  scoper: 'sonnet',
  'test-architect': 'sonnet',
  implementer: 'sonnet',
  designer: 'sonnet',
  'design-reviewer': 'sonnet',
  devops: 'sonnet',
  'second-opinion': 'opus',
  planner: 'sonnet', // decomposition + AC mapping needs real reasoning
};

/** Read-only roles (spec §13 blast-radius control). Reviewer-shaped roles get Bash for diffs/tests. */
const TOOLS = {
  reviewer: 'Read, Grep, Glob, Bash',
  security: 'Read, Grep, Glob, Bash',
  'design-reviewer': 'Read, Grep, Glob, Bash',
  scoper: 'Read, Grep, Glob',
  investigator: 'Read, Grep, Glob',
  librarian: 'Read, Grep, Glob',
  'second-opinion': 'Read, Grep, Glob',
  planner: 'Read, Grep, Glob', // drafts the plan read-only; the orchestrator writes + commits it
  // write-capable roles (implementer, test-architect, devops, designer) inherit all tools
};

export function compileCard(role, cardBody) {
  const missionMatch = /## Mission\r?\n(.+?)(?:\r?\n)/s.exec(cardBody);
  const description = (missionMatch?.[1] ?? role).trim();
  const model = MODELS[role] ? `\nmodel: ${MODELS[role]}` : '';
  const tools = TOOLS[role] ? `\ntools: ${TOOLS[role]}` : '';
  return `---\nname: ${role}\ndescription: ${description}${model}${tools}\n---\n\n<!-- generated from plugin/cards/${role}.md by scripts/backends/compile.mjs — edit the card, not this file -->\n\n${cardBody}`;
}

export async function compileAll({ cardsDir = CARDS_DIR, agentsDir = AGENTS_DIR } = {}) {
  await mkdir(agentsDir, { recursive: true });
  const out = [];
  for (const f of (await readdir(cardsDir)).filter((f) => f.endsWith('.md')).sort()) {
    const role = basename(f, '.md');
    const card = await readFile(join(cardsDir, f), 'utf8');
    const compiled = compileCard(role, card);
    await writeFile(join(agentsDir, f), compiled, 'utf8');
    out.push(role);
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  compileAll().then((roles) => console.log(`compiled ${roles.length} agents: ${roles.join(', ')}`));
}
