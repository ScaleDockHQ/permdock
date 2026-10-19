import {
  ARCHETYPES,
  AUTH,
  BACKENDS,
  FEATURES,
  FRAMEWORKS,
  INTEGRATIONS,
  type Preset,
  SERVICES,
  resolvePreset,
} from "./catalog.ts";

/**
 * Preset codes: `p1` followed by base64url bytes. Version 1 packs, in
 * order, one byte each for the archetype, auth, backend and framework
 * index, then a bitset per multi-select list (features, agent
 * integrations, UI integrations, services), each as many bytes as the list
 * needs. A list only grows at the end, so a code keeps its meaning as the
 * catalogue grows; a new layout gets a new version prefix.
 */
const VERSION = "p1";

const AGENT_INTEGRATIONS = INTEGRATIONS.filter((item) => item.kind === "agent");
const UI_INTEGRATIONS = INTEGRATIONS.filter((item) => item.kind === "ui");

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function toBase64Url(bytes: readonly number[]): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const chunk = (a << 16) | (b << 8) | c;
    const chars =
      index + 1 >= bytes.length ? 2 : index + 2 >= bytes.length ? 3 : 4;
    for (let char = 0; char < chars; char += 1) {
      out += ALPHABET[(chunk >> (18 - 6 * char)) & 63];
    }
  }
  return out;
}

function fromBase64Url(text: string): number[] | undefined {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 4) {
    const group = text.slice(index, index + 4);
    if (group.length === 1) {
      return undefined;
    }
    let chunk = 0;
    for (let char = 0; char < 4; char += 1) {
      const symbol = group[char];
      const value = symbol === undefined ? 0 : ALPHABET.indexOf(symbol);
      if (value < 0) {
        return undefined;
      }
      chunk |= value << (18 - 6 * char);
    }
    bytes.push((chunk >> 16) & 255);
    if (group.length > 2) {
      bytes.push((chunk >> 8) & 255);
    }
    if (group.length > 3) {
      bytes.push(chunk & 255);
    }
  }
  return bytes;
}

function bitset(
  list: readonly { readonly id: string }[],
  picked: readonly string[],
): number[] {
  const bytes = Array.from({ length: Math.ceil(list.length / 8) }, () => 0);
  for (const [index, item] of list.entries()) {
    if (picked.includes(item.id)) {
      bytes[index >> 3] = (bytes[index >> 3] ?? 0) | (1 << (index & 7));
    }
  }
  return bytes;
}

function readBitset<T extends { readonly id: string }>(
  list: readonly T[],
  bytes: readonly number[],
): T["id"][] {
  return list
    .filter((_, index) => ((bytes[index >> 3] ?? 0) >> (index & 7)) & 1)
    .map((item) => item.id);
}

function indexOf(list: readonly { readonly id: string }[], id: string): number {
  return Math.max(
    0,
    list.findIndex((item) => item.id === id),
  );
}

/** The preset code for `preset`, such as `p1AQIDBAc`. */
export function encodePreset(preset: Preset): string {
  const index = indexOf;
  return (
    VERSION +
    toBase64Url([
      index(ARCHETYPES, preset.archetype),
      index(AUTH, preset.auth),
      index(BACKENDS, preset.backend),
      index(FRAMEWORKS, preset.framework),
      ...bitset(FEATURES, preset.features),
      ...bitset(AGENT_INTEGRATIONS, preset.integrations),
      ...bitset(UI_INTEGRATIONS, preset.integrations),
      ...bitset(SERVICES, preset.services),
    ])
  );
}

/**
 * The preset a code stands for, resolved, or `undefined` for a code that
 * is not a version this package reads or does not decode.
 */
export function decodePreset(code: string): Preset | undefined {
  if (!code.startsWith(VERSION)) {
    return undefined;
  }
  const bytes = fromBase64Url(code.slice(VERSION.length));
  if (bytes === undefined) {
    return undefined;
  }
  const pick = <T extends { readonly id: string }>(
    list: readonly T[],
    at: number,
  ): T["id"] | undefined => list[bytes[at] ?? 0]?.id;
  const archetype = pick(ARCHETYPES, 0);
  const auth = pick(AUTH, 1);
  const backend = pick(BACKENDS, 2);
  const framework = pick(FRAMEWORKS, 3);
  if (
    archetype === undefined ||
    auth === undefined ||
    backend === undefined ||
    framework === undefined
  ) {
    return undefined;
  }
  let at = 4;
  const take = (size: number): number[] => {
    const slice = bytes.slice(at, at + size);
    at += size;
    return slice;
  };
  const features = readBitset(FEATURES, take(Math.ceil(FEATURES.length / 8)));
  const agents = readBitset(
    AGENT_INTEGRATIONS,
    take(Math.ceil(AGENT_INTEGRATIONS.length / 8)),
  );
  const ui = readBitset(
    UI_INTEGRATIONS,
    take(Math.ceil(UI_INTEGRATIONS.length / 8)),
  );
  const services = readBitset(SERVICES, take(Math.ceil(SERVICES.length / 8)));
  return resolvePreset({
    archetype,
    auth,
    backend,
    framework,
    features,
    integrations: [...agents, ...ui],
    services,
  });
}
