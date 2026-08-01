import { describe, it, expect } from 'vitest';
import { splitSegments } from '../../plugin/scripts/lib/shell-split.mjs';

describe('splitSegments (#320 — shared shell-segment splitter)', () => {
  it('AC-320.1: splits on &&, ||, ;, |, and newlines, trimming and dropping empties', () => {
    expect(splitSegments('a && b || c ; d | e\nf')).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(splitSegments('git push origin main')).toEqual(['git push origin main']);
    expect(splitSegments('  foo  ;;  bar  ')).toEqual(['foo', 'bar']);
    expect(splitSegments('')).toEqual([]);
  });
});
