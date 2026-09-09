// Funnel numbers from the database in ../.env.
// Usage: node db/stats.mjs [days]      (default 14)
import pg from "pg";
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n")
  .map((l) => l.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const db = new pg.Client({ host: env.host, port: Number(env.port), user: env.username, password: env.password, database: env.database, ssl: { rejectUnauthorized: false } });
await db.connect();
const days = Number(process.argv[2]) || 14;
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

console.log(`\nTotals (all time)`);
console.table(await q(`
  SELECT
    (SELECT count(*) FROM events WHERE event = 'visit')                                   AS visits,
    (SELECT count(DISTINCT visitor) FROM events WHERE event = 'visit')                    AS unique_visitors,
    (SELECT count(*) FROM events WHERE event = 'generate_click')                          AS generate_clicks,
    (SELECT count(DISTINCT visitor) FROM events WHERE event = 'generate_click')           AS unique_clickers,
    (SELECT count(*) FROM events WHERE event = 'buy_click')                               AS buy_clicks,
    (SELECT count(*) FROM submissions)                                                    AS links_generated,
    (SELECT count(*) FROM submissions WHERE result_status = 200)                          AS links_working,
    (SELECT count(*) FROM purchases)                                                      AS purchases`));

console.log(`Per day, last ${days} days`);
console.table(await q(`
  WITH d AS (SELECT generate_series(date_trunc('day', now()) - ($1::int - 1) * interval '1 day', date_trunc('day', now()), interval '1 day')::date AS day)
  SELECT d.day::text AS day,
    count(*) FILTER (WHERE e.event = 'visit')                              AS visits,
    count(DISTINCT e.visitor) FILTER (WHERE e.event = 'visit')             AS unique_visitors,
    count(*) FILTER (WHERE e.event = 'generate_click')                     AS generate_clicks,
    count(*) FILTER (WHERE e.event = 'buy_click')                          AS buy_clicks,
    (SELECT count(*) FROM submissions s WHERE s.created_at::date = d.day)  AS links_generated,
    (SELECT count(*) FROM purchases p WHERE p.created_at::date = d.day)    AS purchases
  FROM d LEFT JOIN events e ON e.created_at::date = d.day
  GROUP BY d.day ORDER BY d.day DESC`, [days]));

console.log(`Visitors by country (visits, last ${days} days)`);
console.table(await q(`SELECT coalesce(country, '?') AS country, count(*) AS visits, count(DISTINCT visitor) AS unique_visitors
  FROM events WHERE event = 'visit' AND created_at > now() - $1::int * interval '1 day' GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, [days]));
await db.end();
