import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { CARDS_DIR, AGENTS_DIR, compileCard, ROLES, MODELS } from '../../plugin/scripts/backends/compile.mjs';

describe('role cards (AC-4.1)', () => {
  it('all 12 roles have a card and only those', async () => {
    const cards = (await readdir(CARDS_DIR)).filter((f) => f.endsWith('.md')).map((f) => basename(f, '.md'));
    expect(cards.sort()).toEqual([...ROLES].sort());
  });

  it('every card carries the required sections + the honesty clause', async () => {
    for (const role of ROLES) {
      const card = await readFile(join(CARDS_DIR, `${role}.md`), 'utf8');
      for (const section of ['## Mission', '## Checklist', '## Guardrails', '## Output contract']) {
        expect(card, `${role} missing ${section}`).toContain(section);
      }
      expect(card, `${role} missing honesty clause`).toContain('"Unknown" is a valid answer');
      expect(card, `${role} missing report contract`).toContain('"verdict": "pass|fail"');
    }
  });

  it('AC-97.1: output contracts ask for a concise body, not free-prose (token pass, #97)', async () => {
    for (const role of ROLES) {
      const card = await readFile(join(CARDS_DIR, `${role}.md`), 'utf8');
      expect(card, `${role} still uses the verbose "Markdown body (" lead`).not.toContain('Markdown body (');
      expect(card, `${role} missing the concise-body instruction`).toContain('concise, bullets over prose');
    }
  });

  it('compiled agents are in sync with their cards (freshness gate)', async () => {
    for (const role of ROLES) {
      const card = await readFile(join(CARDS_DIR, `${role}.md`), 'utf8');
      const agent = await readFile(join(AGENTS_DIR, `${role}.md`), 'utf8');
      expect(agent, `${role} agent stale — run: node plugin/scripts/backends/compile.mjs`).toBe(compileCard(role, card));
    }
  });

  it('AC-101.1: every role pins a right-sized model; read-only roles carry tool allowlists', async () => {
    // "enough to do, not too generous": lookup on haiku, gates/writing on sonnet, only second-opinion on opus.
    expect(MODELS.investigator).toBe('haiku');
    expect(MODELS.librarian).toBe('haiku');
    expect(MODELS.reviewer).toBe('sonnet');   // the security net — not skimped to a cheaper tier
    expect(MODELS.security).toBe('sonnet');
    expect(MODELS['second-opinion']).toBe('opus');
    for (const role of ROLES) {
      const agent = await readFile(join(AGENTS_DIR, `${role}.md`), 'utf8');
      expect(agent, `${role} missing its model pin`).toMatch(new RegExp(`^model: ${MODELS[role]}$`, 'm'));
    }
    const librarian = await readFile(join(AGENTS_DIR, 'librarian.md'), 'utf8');
    expect(librarian).toMatch(/^tools: Read, Grep, Glob$/m);
    const implementer = await readFile(join(AGENTS_DIR, 'implementer.md'), 'utf8');
    expect(implementer).not.toMatch(/^tools:/m);
  });
});
