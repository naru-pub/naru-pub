import { config } from "dotenv";

// Next loads .env on its own, but a plain tsx script does not. Without this a
// missing DATABASE_URL does not fail: node-postgres quietly falls back to its
// own defaults (local socket, database named after the current user), so a
// migration aimed at a configured database can land in an unrelated one
// instead. Load the same file Next would, then refuse to run without a URL.
config();

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Refusing to run against node-postgres defaults; " +
      "set it in control-plane/.env or in the environment.",
  );
}
