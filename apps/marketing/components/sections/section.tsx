import type { ReactNode } from 'react';

export function Section({
  id,
  eyebrow,
  title,
  description,
  children,
}: {
  id?: string;
  eyebrow?: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="mx-auto w-full max-w-6xl scroll-mt-20 px-6 py-16 md:px-8"
    >
      <div className="mb-8 flex max-w-2xl flex-col gap-3">
        {eyebrow ? (
          <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            {eyebrow}
          </p>
        ) : null}
        <h2 className="text-foreground text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
          {title}
        </h2>
        {description ? (
          <p className="text-muted-foreground text-base leading-7 text-pretty">
            {description}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}
