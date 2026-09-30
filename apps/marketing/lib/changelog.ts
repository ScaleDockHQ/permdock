export type ChangelogChange = {
  readonly text: string;
  readonly hash?: string;
};

export type ChangelogRelease = {
  readonly packageName: string;
  readonly version: string;
  readonly kind: 'Minor' | 'Patch' | 'Major';
  readonly changes: readonly ChangelogChange[];
};

const heading = /^## (?<version>[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/u;
const kindHeading = /^### (?<kind>Major|Minor|Patch) Changes$/u;
const changeLine = /^- (?:(?<hash>[0-9a-f]{7,40}): )?(?<text>.+)$/u;

export function parseChangelog(
  markdown: string,
  packageName: string,
): ChangelogRelease[] {
  const lines = markdown.split('\n');
  const releases: ChangelogRelease[] = [];
  let version: string | undefined;
  let kind: ChangelogRelease['kind'] | undefined;
  let changes: ChangelogChange[] = [];

  function flush(): void {
    if (version !== undefined && kind !== undefined && changes.length > 0) {
      releases.push({
        packageName,
        version,
        kind,
        changes,
      });
    }
    changes = [];
  }

  for (const line of lines) {
    const versionMatch = heading.exec(line);
    if (versionMatch?.groups?.['version'] !== undefined) {
      flush();
      version = versionMatch.groups['version'];
      kind = undefined;
      continue;
    }
    const kindMatch = kindHeading.exec(line);
    if (kindMatch?.groups?.['kind'] !== undefined) {
      flush();
      // SAFETY: the kindHeading regex only captures the release kinds ChangelogRelease['kind'] lists
      kind = kindMatch.groups['kind'] as ChangelogRelease['kind'];
      continue;
    }
    const changeMatch = changeLine.exec(line);
    if (changeMatch?.groups?.['text'] !== undefined && kind !== undefined) {
      const hash = changeMatch.groups['hash'];
      if (hash === undefined) {
        changes.push({ text: changeMatch.groups['text'] });
      } else {
        changes.push({ text: changeMatch.groups['text'], hash });
      }
    }
  }
  flush();
  return releases;
}

export function latestReleases(
  releases: readonly ChangelogRelease[],
  count: number,
): ChangelogRelease[] {
  return releases.slice(0, count);
}
