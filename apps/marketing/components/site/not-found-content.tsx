import { ButtonLink } from '@/components/site/button-link';
import { site } from '@/lib/site';

export function NotFoundContent() {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col items-center gap-4 px-6 py-24 text-center">
      <h1 className="text-3xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground text-sm leading-6">
        That URL is not a marketing route. Docs still live under /docs.
      </p>
      <div className="flex gap-2">
        <ButtonLink href="/">Home</ButtonLink>
        <ButtonLink variant="outline" href={site.docs}>
          Docs
        </ButtonLink>
      </div>
    </div>
  );
}
