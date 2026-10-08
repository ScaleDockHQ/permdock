const clock = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
});

/**
 * When the read behind a region ran and how long it took. A cache hit shows
 * the time of the run that filled the entry, so a revisit repeats it.
 */
export function DataSource(props: {
  readonly name: string;
  readonly loaded: { readonly loadedAt: number; readonly tookMs: number };
}) {
  return (
    <p
      data-testid="data-source"
      data-source={props.name}
      data-loaded-at={props.loaded.loadedAt}
    >
      <small>
        {props.name} read in {props.loaded.tookMs} ms at{" "}
        {clock.format(props.loaded.loadedAt)} UTC
      </small>
    </p>
  );
}
