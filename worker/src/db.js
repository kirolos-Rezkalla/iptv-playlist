/**
 * Storage in the DigitalOcean managed PostgreSQL database (see db/schema.sql).
 * Client: node-postgres (pg).
 * Everything here is best-effort and off the request path: a database outage
 * must never stop a playlist from being generated. Without a HYPERDRIVE binding
 * or DATABASE_URL the functions are no-ops.
 */
import pg from "pg";

/**
 * A client is {connect(), insert(table, row, onConflict?), end()}. node-postgres
 * uses Cloudflare's socket API under nodejs_compat.
 *
 * In production the URL comes from the Hyperdrive binding: Hyperdrive does the
 * TLS to DigitalOcean (sslmode=require) and hands the worker a plain local
 * connection. A direct DATABASE_URL only works from Node (db/*.mjs), because
 * Workers verify certificates against public CAs and DigitalOcean's managed
 * databases use a private CA.
 */
function pgClient(url) {
  const viaHyperdrive = /hyperdrive/.test(new URL(url).hostname);
  const client = new pg.Client({ connectionString: url, ssl: viaHyperdrive ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 10_000 });
  return {
    connect: () => client.connect(),
    insert(table, row, onConflict = "") {
      const cols = Object.keys(row);
      const params = cols.map((_, i) => `$${i + 1}`);
      return client.query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${params.join(", ")}) ${onConflict}`, cols.map((c) => row[c]));
    },
    end: () => client.end(),
  };
}
let factory = pgClient;

/** Tests swap the client out; production never calls this. */
export function _setSqlFactory(f) { factory = f; }

/** Hyperdrive binding first, DATABASE_URL second, else nothing. */
export function databaseUrl(env) {
  return env.HYPERDRIVE?.connectionString || env.DATABASE_URL || null;
}

function withDb(env, ctx, work) {
  const url = databaseUrl(env);
  if (!url) return Promise.resolve(false);
  const run = (async () => {
    const db = factory(url);
    try { await db.connect(); await work(db); return true; }
    catch (e) { console.error("db:", e.message); return false; }
    finally { try { await db.end(); } catch {} }
  })();
  if (ctx?.waitUntil) ctx.waitUntil(run);
  return run;
}

/** Where the request came from, for both tables. */
export function requestMeta(request) {
  return {
    ip: request.headers.get("cf-connecting-ip") || null,
    country: request.cf?.country || null,
    user_agent: (request.headers.get("user-agent") || "").slice(0, 300) || null,
  };
}

/**
 * One row per link generated on the front page.
 * cfg is the parsed link config; access is the verified access code (or null); master marks the operator key.
 */
export function recordSubmission(env, ctx, { cfg, access, master, status, lang, meta }) {
  const row = {
    kind: cfg.xtream ? "xtream" : "m3u",
    m3u_url: cfg.xtream ? null : cfg.source.href,
    xtream_host: cfg.xtream?.origin ?? null,
    xtream_user: cfg.xtream?.user ?? null,
    xtream_pass: cfg.xtream?.pass ?? null,
    hls: !!cfg.hls,
    source_hash: cfg.sourceHash,
    access_email: access?.email || null,
    access_ref: access?.ref || null,
    master: !!master,
    result_status: Number.isInteger(status) ? status : null,
    lang: lang === "en" || lang === "ar" ? lang : null,
    ip: meta.ip, country: meta.country, user_agent: meta.user_agent,
  };
  return withDb(env, ctx, (db) => db.insert("submissions", row));
}

export const EVENTS = new Set(["visit", "generate_click", "buy_click", "welcome_visit"]);

/** A page view or button click reported by the front page. */
export function recordEvent(env, ctx, { event, visitor, lang, page, referrer, meta }) {
  const row = {
    event,
    visitor: typeof visitor === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(visitor) ? visitor : null,
    lang: lang === "en" || lang === "ar" ? lang : null,
    page: typeof page === "string" ? page.slice(0, 200) : null,
    referrer: typeof referrer === "string" && referrer ? referrer.slice(0, 500) : null,
    ip: meta.ip, country: meta.country, user_agent: meta.user_agent,
  };
  return withDb(env, ctx, (db) => db.insert("events", row));
}

/** One row per paid Stripe Checkout Session; re-visits of the welcome page do not duplicate it. */
export function recordPurchase(env, ctx, { session, src, exp, meta }) {
  const row = {
    stripe_session_id: session.id,
    email: session.customer_details?.email || null,
    source_hash: src,
    amount_total: Number.isInteger(session.amount_total) ? session.amount_total : null,
    currency: session.currency || null,
    paid_at: session.created ? new Date(Number(session.created) * 1000) : null,
    expires_at: new Date(exp * 1000),
    ip: meta.ip, country: meta.country,
  };
  return withDb(env, ctx, (db) => db.insert("purchases", row, "ON CONFLICT (stripe_session_id) DO NOTHING"));
}
