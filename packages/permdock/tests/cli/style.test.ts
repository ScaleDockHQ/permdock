import { describe, expect, it } from 'vitest';

import { createStyle, streamHasColors } from '../../src/cli/style.ts';

function stream(tty: boolean, colors = true): NodeJS.WriteStream {
  // SAFETY: streamHasColors reads only isTTY and hasColors.
  return {
    isTTY: tty,
    hasColors: () => colors,
  } as unknown as NodeJS.WriteStream;
}

describe('createStyle', () => {
  it('returns plain text and word marks without colour', () => {
    const style = createStyle(false);
    expect(style.paint('red', 'x')).toBe('x');
    expect([style.errorMark, style.warnMark]).toEqual(['error', 'warn']);
  });

  it('wraps text in ANSI codes and uses glyph marks with colour', () => {
    const style = createStyle(true);
    expect(style.paint('red', 'x')).toBe('\u001B[31mx\u001B[39m');
    expect(style.errorMark).toContain('✖');
    expect(style.warnMark).toContain('⚠');
  });
});

describe('streamHasColors', () => {
  it('asks a TTY', () => {
    expect(streamHasColors(stream(true, true), {})).toBe(true);
    expect(streamHasColors(stream(true, false), {})).toBe(false);
  });

  it('colours a pipe only under a non-zero FORCE_COLOR', () => {
    expect(streamHasColors(stream(false), {})).toBe(false);
    expect(streamHasColors(stream(false), { FORCE_COLOR: '1' })).toBe(true);
    expect(streamHasColors(stream(false), { FORCE_COLOR: '0' })).toBe(false);
  });
});
