import { Frame, FramePanel } from '@/components/reui/frame';
import { siteCounts } from '@/lib/counts';

export function StatsPanel() {
  const counts = siteCounts();
  const cards = [
    {
      title: 'Adapters',
      subtitle: 'First-class entries in the package',
      value: String(counts.adapters),
      subtext: 'UI, HTTP, agents, data, auth',
    },
    {
      title: 'Standards',
      subtitle: 'Tracked in the docs tree',
      value: String(counts.standards),
      subtext: 'Specs PermDock follows or implements',
    },
    {
      title: 'Package tests',
      subtitle: 'Unit and type tests in packages/',
      value: String(counts.tests),
      subtext: '*.test.ts files under packages',
    },
  ] as const;

  return (
    <Frame className="w-full">
      <FramePanel className="grid grid-cols-1 overflow-hidden p-0! md:grid-cols-3">
        {cards.map((card) => (
          <div
            key={card.title}
            className="border-border border-b p-6 last:border-b-0 md:border-r md:border-b-0 md:last:border-r-0"
          >
            <p className="text-lg font-semibold">{card.title}</p>
            <p className="text-muted-foreground text-sm">{card.subtitle}</p>
            <p className="mt-6 text-3xl font-bold tracking-tight">
              {card.value}
            </p>
            <p className="text-muted-foreground mt-1.5 text-sm">
              {card.subtext}
            </p>
          </div>
        ))}
      </FramePanel>
    </Frame>
  );
}
