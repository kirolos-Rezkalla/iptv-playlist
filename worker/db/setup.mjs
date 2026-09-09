// Creates the database named in ../.env (if missing) and applies schema.sql.
// Usage: node db/setup.mjs            (run from worker/)
import pg from "pg";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n")
    .map((l) => l.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]),
);
const { username, password, host, port, database } = env;
if (!username || !password || !host || !port || !database) throw new Error("username/password/host/port/database missing in .env");
const base = { host, port: Number(port), user: username, password, ssl: { rejectUnauthorized: false } };

const admin = new pg.Client({ ...base, database: "defaultdb" });
await admin.connect();
const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
if (exists.rowCount === 0) { await admin.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`); console.log(`created database ${database}`); }
else console.log(`database ${database} already exists`);
await admin.end();

const db = new pg.Client({ ...base, database });
await db.connect();
await db.query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
const tables = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1");
console.log("tables:", tables.rows.map((t) => t.table_name).join(", "));
await db.end();
