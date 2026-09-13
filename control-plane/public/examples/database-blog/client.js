import { config } from "./config.js";
export async function connect() {
  const sdk = await import("https://naru.pub/sdk/1.0.0/naru-data.js");
  // A page on <login>.naru.pub finds its own site; config.site is for others.
  const site = config.site ? { site: config.site } : undefined;
  return {
    collection: (name) => sdk.collection(name, site),
    ownerSession: () => sdk.ownerSession(site),
    signIn: (collections) => sdk.signIn({ ...site, collections }),
  };
}
