-- Runs inside the `iptv` database. Idempotent.

-- One row each time someone generates a playlist link on the front page.
CREATE TABLE IF NOT EXISTS submissions (
  id            bigserial PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  kind          text NOT NULL CHECK (kind IN ('m3u', 'xtream')),
  m3u_url       text,
  xtream_host   text,
  xtream_user   text,
  xtream_pass   text,
  hls           boolean NOT NULL DEFAULT false,
  source_hash   char(16) NOT NULL,          -- same hash access codes are bound to
  access_email  text,                       -- from the access code, if any
  access_ref    text,                       -- Stripe session id in the code
  master        boolean NOT NULL DEFAULT false,
  result_status integer,                    -- HTTP status the playlist check returned
  lang          text,
  ip            inet,
  country       text,
  user_agent    text
);
CREATE INDEX IF NOT EXISTS submissions_created_at_idx ON submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS submissions_source_hash_idx ON submissions (source_hash);

-- One row per completed Stripe Checkout, written when the welcome page mints the code.
CREATE TABLE IF NOT EXISTS purchases (
  id                bigserial PRIMARY KEY,
  created_at        timestamptz NOT NULL DEFAULT now(),
  stripe_session_id text NOT NULL UNIQUE,
  email             text,
  source_hash       char(16) NOT NULL,
  amount_total      integer,                -- minor units, as Stripe reports
  currency          text,
  paid_at           timestamptz,
  expires_at        timestamptz NOT NULL,
  ip                inet,
  country           text
);
CREATE INDEX IF NOT EXISTS purchases_email_idx ON purchases (email);

-- Page views and button clicks reported by the front page (client beacon; the
-- landing page is served from the edge cache so the server never sees views).
CREATE TABLE IF NOT EXISTS events (
  id          bigserial PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  event       text NOT NULL CHECK (event IN ('visit', 'generate_click', 'buy_click', 'welcome_visit')),
  visitor     text,                         -- random id kept in the browser, to count unique people
  lang        text,
  page        text,
  referrer    text,
  ip          inet,
  country     text,
  user_agent  text
);
CREATE INDEX IF NOT EXISTS events_event_created_idx ON events (event, created_at DESC);
CREATE INDEX IF NOT EXISTS events_visitor_idx ON events (visitor);
