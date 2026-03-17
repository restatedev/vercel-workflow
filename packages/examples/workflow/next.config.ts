import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      "workflow/runtime": "@restatedev/workflow/runtime",
      "workflow/internal/private": "@restatedev/workflow/internal/private",
    },
  },
};

export default withWorkflow(nextConfig);
