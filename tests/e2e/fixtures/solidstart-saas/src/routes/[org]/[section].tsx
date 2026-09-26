import type { RouteSectionProps } from '@solidjs/router';

import { navItemFor } from '@permdock/e2e-saas-kit/nav';
import { Protected } from 'permdock/solid';
import { Show } from 'solid-js';

import { Forbidden } from '../../lib/forbidden';

export default function Section(props: RouteSectionProps) {
  const item = () => navItemFor(props.params.section ?? '');
  return (
    <Show when={item()} fallback={<h1>Not found</h1>}>
      {(current) => (
        <>
          <h1>{current().label}</h1>
          <Protected
            permission={current().permission}
            fallback={<Forbidden label={current().label} />}
          >
            <p data-testid="section-content">{current().label} content</p>
          </Protected>
        </>
      )}
    </Show>
  );
}
