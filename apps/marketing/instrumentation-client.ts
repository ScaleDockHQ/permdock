import { captureRouterTransitionStart, init } from '@sentry/nextjs';

import { sentryOptions } from '@/lib/monitoring';

init(sentryOptions());

export const onRouterTransitionStart = captureRouterTransitionStart;
