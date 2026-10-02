import { styleText } from 'node:util';

type Format = Parameters<typeof styleText>[0];

/** Terminal styling for human output; with `color` off every helper returns plain text and words for marks. */
export type Style = {
  readonly color: boolean;
  readonly paint: (format: Format, text: string) => string;
  readonly errorMark: string;
  readonly warnMark: string;
};

export function createStyle(color: boolean): Style {
  const paint = (format: Format, text: string): string =>
    color ? styleText(format, text, { validateStream: false }) : text;
  return {
    color,
    paint,
    errorMark: color ? paint('red', '✖') : 'error',
    warnMark: color ? paint('yellow', '⚠') : 'warn',
  };
}

/**
 * Whether a stream takes colour. On a TTY `hasColors()` honours `NO_COLOR`,
 * `FORCE_COLOR` and `TERM`; a pipe colours only under a non-zero `FORCE_COLOR`.
 */
export function streamHasColors(
  stream: NodeJS.WriteStream,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (stream.isTTY === true) {
    return stream.hasColors(env);
  }
  const force = env['FORCE_COLOR'];
  return force !== undefined && force !== '0' && force !== 'false';
}
