import { describe, it, expect } from 'vitest';
import { upsertBlock, markedBody, hasMarker, begin, end } from '../../plugin/scripts/lib/markers.mjs';

describe('markers', () => {
  it('appends a block to text without one, preserving existing content', () => {
    const out = upsertBlock('Epic body here.', 'digest', '| table |');
    expect(out).toContain('Epic body here.');
    expect(out).toContain(`${begin('digest')}\n| table |\n${end('digest')}`);
  });

  it('AC-2.5: replaces only inside the markers on re-run', () => {
    const v1 = upsertBlock('Intro text.\n\nOutro text.', 'digest', 'OLD');
    const v2 = upsertBlock(v1, 'digest', 'NEW');
    expect(v2).toContain('Intro text.');
    expect(v2).toContain('NEW');
    expect(v2).not.toContain('OLD');
    expect(v2.match(new RegExp('forge:digest:begin', 'g')).length).toBe(1);
  });

  it('handles empty starting text', () => {
    const out = upsertBlock('', 'digest', 'X');
    expect(out.startsWith(begin('digest'))).toBe(true);
  });

  it('markedBody/hasMarker round-trip', () => {
    const b = markedBody('trail:pr', 'hello');
    expect(hasMarker(b, 'trail:pr')).toBe(true);
    expect(hasMarker(b, 'trail:plan')).toBe(false);
    expect(hasMarker(null, 'trail:pr')).toBe(false);
  });
});
