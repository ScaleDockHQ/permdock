import type { ReactNode } from "react";

import {
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/reui/frame";

export function OrgFrame(props: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Frame spacing="sm">
      <FramePanel>
        <FrameHeader>
          <FrameTitle data-testid="page-title">{props.title}</FrameTitle>
        </FrameHeader>
        {props.children}
      </FramePanel>
    </Frame>
  );
}
