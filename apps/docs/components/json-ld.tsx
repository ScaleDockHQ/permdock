export function JsonLd({ data }: { data: Readonly<Record<string, unknown>> }) {
  // `<` becomes `\u003c` so no string in the payload can close the script element.
  const json = JSON.stringify(data).replaceAll("<", "\\u003c");
  return (
    <script
      type="application/ld+json"
      // oxlint-disable-next-line react/no-danger -- JSON-LD from the docs' own frontmatter, `<` escaped above
      dangerouslySetInnerHTML={{ __html: json }}
    />
  );
}
