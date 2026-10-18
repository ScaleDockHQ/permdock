import { type JsonLdNode, graph } from "@/lib/structured-data";

export function JsonLd({ nodes }: { nodes: readonly JsonLdNode[] }) {
  // `<` becomes `\u003c` so no string in the payload can close the script element.
  const json = JSON.stringify(graph(nodes)).replaceAll("<", "\\u003c");
  return (
    <script
      type="application/ld+json"
      // oxlint-disable-next-line react/no-danger -- JSON-LD from the site's own constants, `<` escaped above
      dangerouslySetInnerHTML={{ __html: json }}
    />
  );
}
