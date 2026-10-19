import { decodePreset, generatePreset } from "permdock/preset";

/** The shadcn registry item a preset code installs, or `null` for a code this version cannot read. */
export function presetItem(
  code: string,
  origin: string,
): Readonly<Record<string, unknown>> | null {
  const preset = decodePreset(code);
  if (preset === undefined) {
    return null;
  }
  const generated = generatePreset(preset);
  return {
    $schema: "https://ui.shadcn.com/schema/registry-item.json",
    name: `preset-${generated.code}`,
    type: "registry:block",
    title: `PermDock ${preset.archetype} preset`,
    description: `The ${preset.archetype} preset (${preset.features.join(", ")}) on ${preset.framework}, with ${preset.auth} auth and a ${preset.backend} backend: permissions, policy, app definition and wiring. Rules stay in the permdock package.`,
    dependencies: generated.dependencies,
    registryDependencies: generated.recipes.map(
      (recipe) => `${origin}/r/${recipe.replace("@permdock/", "")}.json`,
    ),
    files: generated.files.map((file) => ({
      path: file.path,
      type: "registry:file",
      target: `~/${file.path}`,
      content: file.contents,
    })),
    docs: `Edit this preset at ${origin}/create?preset=${generated.code}, then run npx permdock doctor.`,
  };
}
