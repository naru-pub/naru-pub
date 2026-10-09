import { withSentryConfig } from "@sentry/nextjs";
import sdkAliases from "./sdk/aliases.json" with { type: "json" };
/** @type {import('next').NextConfig} */
const nextConfig = {
  // The Dockerfile's web image runs .next/standalone/server.js.
  output: "standalone",
  // /sdk/1/ follows the newest 1.x release, so a site that imports it gets
  // compatible fixes; /sdk/<exact version>/ never changes once released. In
  // production the edge Worker answers naru.pub/sdk/* (edge/src/sdk.ts) with
  // the same files and aliases; these serve local development and the smoke
  // test.
  async rewrites() {
    return Object.entries(sdkAliases).map(([alias, version]) => ({
      source: `/sdk/${alias}/:path*`,
      destination: `/sdk/${version}/:path*`,
    }));
  },
  async headers() {
    return [
      {
        source: "/sdk/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Cache-Control", value: "no-cache" },
        ],
      },
      // Next types files by extension, and to it .ts is an MPEG transport
      // stream; declarations are text an editor or a person reads.
      {
        source: "/sdk/:version/:file*.d.ts",
        headers: [{ key: "Content-Type", value: "text/plain; charset=utf-8" }],
      },
      {
        source: "/database/authorize",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
  serverExternalPackages: ["@node-rs/argon2"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "r2.naru.pub",
        pathname: "/**",
      },
    ],
  },
};

export default withSentryConfig(
  withSentryConfig(nextConfig, {
    // For all available options, see:
    // https://www.npmjs.com/package/@sentry/webpack-plugin#options

    org: "jihyeok-seo",
    project: "naru-pub",

    // Only print logs for uploading source maps in CI
    silent: !process.env.CI,

    // For all available options, see:
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

    // Upload a larger set of source maps for prettier stack traces (increases build time)
    widenClientFileUpload: true,

    // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
    // This can increase your server load as well as your hosting bill.
    // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
    // side errors will fail.
    tunnelRoute: "/monitoring",

    // Automatically tree-shake Sentry logger statements to reduce bundle size
    disableLogger: true,

    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,
  }),
);
