import { renderMermaidSVG } from "beautiful-mermaid";
import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";

function renderChart(chart: string): string | null {
  try {
    return renderMermaidSVG(chart, {
      bg: "var(--color-fd-background)",
      fg: "var(--color-fd-foreground)",
      interactive: true,
      transparent: true,
    });
  } catch {
    return null;
  }
}

export function Mermaid({ chart }: { chart: string }) {
  const svg = renderChart(chart);
  if (svg === null) {
    return (
      <CodeBlock title="Mermaid">
        <Pre>{chart}</Pre>
      </CodeBlock>
    );
  }
  // oxlint-disable-next-line react/no-danger -- SVG rendered at build time from the docs' own MDX
  return <div dangerouslySetInnerHTML={{ __html: svg }} />;
}
