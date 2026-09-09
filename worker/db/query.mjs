// Ad-hoc queries against the database in ../.env.
// Usage: node db/query.mjs "SELECT count(*) FROM submissions"
import pg from "pg";
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n")
  .map((l) => l.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const db = new pg.Client({ host: env.host, port: Number(env.port), user: env.username, password: env.password, database: env.database, ssl: { rejectUnauthorized: false } });
await db.connect();
console.table((await db.query(process.argv[2] || "SELECT count(*) AS submissions FROM submissions")).rows);
await db.end();
