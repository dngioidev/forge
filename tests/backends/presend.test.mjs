import { describe, it, expect } from 'vitest';
import { scanPrompt, shannonEntropy } from '../../plugin/scripts/backends/presend.mjs';

describe('pre-send scan (AC-4.4)', () => {
  it('refuses known secret patterns', () => {
    const cases = [
      'here is ghp_abcdefghijklmnopqrstuvwx1234567890',
      'AWS_KEY: AKIAIOSFODNN7EXAMPLE',
      '-----BEGIN RSA PRIVATE KEY-----',
      'MY_API_TOKEN = "supersecretvalue1"',
      'jwt: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpM',
    ];
    for (const c of cases) {
      const r = scanPrompt(`role card text\n${c}\ntask brief`);
      expect(r.ok, c).toBe(false);
    }
  });

  it('refuses high-entropy credential-shaped tokens but allows git/sha256 hashes', () => {
    expect(scanPrompt('token: kJ8xQ2mZ9vL4pR7nT3wY6bC1dF5gH0aSeI9oU2xK').ok).toBe(false);
    expect(scanPrompt('merge sha 34820ce9c18128c671f4785092f76c734de337ba is fine').ok).toBe(true);
  });

  it('allows ordinary prompts: code, paths, markdown', () => {
    const ok = scanPrompt('## Task brief\nRefactor plugin/scripts/lib/config.mjs per docs/specs/2026-07-15-forge-platform-design.md — validateConfig should return typed errors.');
    expect(ok.ok).toBe(true);
  });

  it('entropy helper behaves', () => {
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
    expect(shannonEntropy('kJ8xQ2mZ9vL4pR7n')).toBeGreaterThan(3.5);
  });
});
