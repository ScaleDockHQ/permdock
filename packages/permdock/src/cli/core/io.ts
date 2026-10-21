import type { Style } from "./style.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;

/**
 * A spinner on a terminal stderr; a plain line elsewhere, so logs and CI output
 * stay readable. `done` replaces the spinner with a final line.
 */
export function progressReporter(input: {
  readonly write: (text: string) => void;
  readonly tty: boolean;
  readonly style: Style;
}): (message: string) => { readonly done: (message?: string) => void } {
  return (message) => {
    if (!input.tty) {
      input.write(`${message}\n`);
      return {
        done: (final) => {
          if (final !== undefined) {
            input.write(`${final}\n`);
          }
        },
      };
    }
    let frame = 0;
    const draw = (): void => {
      input.write(
        `\r${input.style.paint("cyan", FRAMES[frame % FRAMES.length] ?? "")} ${message}`,
      );
      frame += 1;
    };
    draw();
    const timer = setInterval(draw, FRAME_MS);
    timer.unref();
    return {
      done: (final) => {
        clearInterval(timer);
        input.write(
          `\r\u001B[2K${final === undefined ? "" : `${input.style.okMark} ${final}\n`}`,
        );
      },
    };
  };
}

/** The value of a `--*-stdin` secret: stdin up to the first newline, trimmed. */
export async function readSecret(
  readStdin: (() => Promise<string>) | undefined,
): Promise<string | undefined> {
  if (readStdin === undefined) {
    return undefined;
  }
  const text = (await readStdin()).split(/\r?\n/u, 1)[0]?.trim() ?? "";
  return text === "" ? undefined : text;
}
