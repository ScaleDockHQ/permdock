import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';
import { type NextRequest, NextResponse } from 'next/server';

import { docsContentRoute, docsRoute } from '@/lib/shared';

const docsPath = rewritePath(
  `${docsRoute}{/*path}`,
  `${docsContentRoute}{/*path}/content.md`,
);
const suffixPath = rewritePath(
  `${docsRoute}{/*path}.md`,
  `${docsContentRoute}{/*path}/content.md`,
);

export default function proxy(request: NextRequest): NextResponse {
  const suffix = suffixPath.rewrite(request.nextUrl.pathname);
  if (suffix !== false) {
    return NextResponse.rewrite(new URL(suffix, request.nextUrl));
  }

  if (isMarkdownPreferred(request)) {
    const markdownPath = docsPath.rewrite(request.nextUrl.pathname);

    if (markdownPath !== false) {
      return NextResponse.rewrite(new URL(markdownPath, request.nextUrl), {
        headers: { Vary: 'Accept' },
      });
    }
  }

  return NextResponse.next();
}
