// Prints the connection URL for `wrangler secret put DATABASE_URL`. Do not paste its output anywhere else.
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n")
  .map((l) => l.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
process.stdout.write(`postgresql://${encodeURIComponent(env.username)}:${encodeURIComponent(env.password)}@${env.host}:${env.port}/${env.database}?sslmode=require`);
