import type { NextConfig } from "next";

// Two build targets from one codebase:
// - default: Next.js server (Docker / ECS) that proxies /api/* to the Express API.
// - DEMO:   fully static export (S3 + CloudFront) with an in-browser mock API and demo data.
const demo = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
const apiUrl = process.env.API_URL ?? "http://localhost:4000";

const config: NextConfig = demo
  ? { output: "export", trailingSlash: true, poweredByHeader: false, images: { unoptimized: true } }
  : {
      output: "standalone",
      poweredByHeader: false,
      async rewrites() {
        // On ECS both containers share the task's network namespace, so the API is localhost there too.
        return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
      },
    };

export default config;
