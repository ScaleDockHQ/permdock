import type { NextConfig } from "next";

import { withWorkflow } from "workflow/next";

const config: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1"],
};

export default withWorkflow(config);
