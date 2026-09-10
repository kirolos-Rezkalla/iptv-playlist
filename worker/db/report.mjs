// Plain-text funnel report for the hourly Slack update.
// Connection: DATABASE_URL env var (used by the cloud routine), else ../.env.
// Usage: node db/report.mjs [window_minutes]     (default 60)
import pg from "pg";
import { existsSync, readFileSync } from "node:fs";

function client() {
  if (process.env.DATABASE_URL) return new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const envPath = new URL("../../.env", import.meta.url);
  if (!existsSync(envPath)) throw new Error("set DATABASE_URL or provide ../.env");
  const env = Object.fromEntries(readFileSync(envPath, "utf8").split("\n")
    .map((l) => l.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
  return new pg.Client({ host: env.host, port: Number(env.port), user: env.username, password: env.password, database: env.database, ssl: { rejectUnauthorized: false } });
}

const minutes = Number(process.argv[2]) || 60;
const db = client();
await db.connect();
const one = async (sql, params) => (await db.query(sql, params)).rows[0];

const ev = await one(`
  SELECT
    count(*)                FILTER (WHERE event = 'visit')          AS visits,
    count(DISTINCT visitor) FILTER (WHERE event = 'visit')          AS people,
    count(*)                FILTER (WHERE event = 'generate_click') AS clicks,
    count(DISTINCT visitor) FILTER (WHERE event = 'generate_click') AS clickers,
    count(*)                FILTER (WHERE event = 'buy_click')      AS buy_clicks,
    count(*)                FILTER (WHERE event = 'visit' AND created_at >= now() - $1::int * interval '1 minute')          AS visits_recent,
    count(DISTINCT visitor) FILTER (WHERE event = 'visit' AND created_at >= now() - $1::int * interval '1 minute')          AS people_recent,
    count(*)                FILTER (WHERE event = 'generate_click' AND created_at >= now() - $1::int * interval '1 minute') AS clicks_recent,
    count(*)                FILTER (WHERE event = 'buy_click' AND created_at >= now() - $1::int * interval '1 minute')      AS buy_clicks_recent
  FROM events`, [minutes]);
const sub = await one(`
  SELECT count(*) AS links, count(*) FILTER (WHERE result_status = 200) AS worked,
         count(*) FILTER (WHERE created_at >= now() - $1::int * interval '1 minute') AS links_recent,
         count(*) FILTER (WHERE result_status = 200 AND created_at >= now() - $1::int * interval '1 minute') AS worked_recent
  FROM submissions`, [minutes]);
const pur = await one(`
  SELECT count(*) AS purchases, coalesce(sum(amount_total), 0) / 100.0 AS revenue,
         count(*) FILTER (WHERE created_at >= now() - $1::int * interval '1 minute') AS purchases_recent,
         coalesce(sum(amount_total) FILTER (WHERE created_at >= now() - $1::int * interval '1 minute'), 0) / 100.0 AS revenue_recent
  FROM purchases`, [minutes]);
const countries = (await db.query(`
  SELECT coalesce(country, '?') AS country, count(DISTINCT visitor) AS people
  FROM events WHERE event = 'visit' AND created_at >= now() - $1::int * interval '1 minute'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 5`, [minutes])).rows;
await db.end();

const n = (v) => Number(v);
const line = (label, recent, total) => `${label}: ${recent} (total ${total})`;
console.log(`Playlist Fixer, last ${minutes} min vs total`);
console.log(line("Visits", n(ev.visits_recent), n(ev.visits)));
console.log(line("People", n(ev.people_recent), n(ev.people)));
console.log(line("Get-my-link clicks", n(ev.clicks_recent), n(ev.clicks)));
console.log(line("Buy clicks", n(ev.buy_clicks_recent), n(ev.buy_clicks)));
console.log(line("Links generated", n(sub.links_recent), n(sub.links)));
console.log(line("Links that worked", n(sub.worked_recent), n(sub.worked)));
console.log(line("Purchases", n(pur.purchases_recent), n(pur.purchases)));
console.log(`Revenue: $${n(pur.revenue_recent).toFixed(2)} (total $${n(pur.revenue).toFixed(2)})`);
if (countries.length) console.log("Recent visitors by country: " + countries.map((c) => `${c.country} ${c.people}`).join(", "));
