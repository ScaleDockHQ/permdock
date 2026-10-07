export const instant = true;

export default function Overview() {
  return (
    <section>
      <h1 data-testid="page-title">Overview</h1>
      <p>
        The links above are gated by your role in this organization. They come
        from a private-cached snapshot, so switching organizations or pages
        never waits for an access check.
      </p>
    </section>
  );
}
