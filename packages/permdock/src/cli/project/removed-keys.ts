/**
 * Config keys a release removed, with the message that names their replacement.
 * `parseConfig` refuses them: an unknown key only warns, and a removed key that
 * warns would silently stop doing its job.
 */
const REMOVED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "doctor.waivers":
    "doctor.waivers moved into the doctor.baseline file in 0.32; run permdock codemod 0.32",
  "doctor.ignore":
    "doctor.ignore moved into the doctor.baseline file in 0.32; run permdock codemod 0.32",
});

/** The message for a removed key at `path`, such as `doctor.waivers`. */
export function removedKey(path: string): string | undefined {
  return Object.hasOwn(REMOVED_KEYS, path) ? REMOVED_KEYS[path] : undefined;
}
