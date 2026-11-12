-- SPDX-License-Identifier: AGPL-3.0-only
-- ============================================================
--  scripts/analytics/weekly-review.sql — the weekly Analytics Engine review
--  (owner: "analytics before new features", 2026-11-11). Run each query in
--  the Cloudflare dashboard (Workers → Analytics Engine → SQL), export CSV.
--  Rank by PEOPLE (distinct sessions), never by events.
--
--  Columns (src/index.js _dataPointFromEvent, tests/analyticsEvent.test.js):
--    index1 event · blob1 locale · blob2 tool · blob3 session
--    blob4.. the event's own key=value props, then the server's
--    country, device, browser, os, app; then the client's x_… context.
--    Tool Error: blob4 error_type, blob5 country, blob6 device, blob7 browser,
--      blob8 os, blob9 app (wechat/qq/dingtalk/none), then from 2026-11-11
--      blob10 x_size (size band), blob11 x_hidden (tab hidden since the run
--      started), blob12 x_acted (a person pressed or typed on the page).
--    Rage Click: blob2 tool (from 2026-11-11; '' on the homepage), blob4 target.
--
--  Analytics Engine SQL limits (checked 2026-11-11): no subqueries
--  ("IN (SELECT …)"), no max()/min() on strings; for a list of sessions use
--  blob3 = 'a' OR blob3 = 'b' (an IN list once failed with "unable to find
--  type of column").
-- ============================================================


-- 1. Errors by tool and type — people, events (7 days)
SELECT blob2 AS tool, blob4 AS error, COUNT(DISTINCT blob3) AS people, COUNT() AS events
FROM pdfree_events
WHERE timestamp > NOW() - INTERVAL '7' DAY AND index1 = 'Tool Error'
GROUP BY tool, error ORDER BY people DESC LIMIT 60;


-- 2. People, not bots: sessions that added a file and hit an error; ok = later successes
SELECT blob2 AS tool, blob3 AS session,
  SUM(if(index1 = 'File Added', 1, 0)) AS files_added,
  SUM(if(index1 = 'Tool Error', 1, 0)) AS errors,
  SUM(if(index1 = 'Tool Success', 1, 0)) AS ok
FROM pdfree_events
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY tool, session
HAVING errors > 0 AND files_added > 0
ORDER BY errors DESC LIMIT 100;


-- 3. Errors with context (from 2026-11-11): size, hidden tab, a person acting
SELECT blob2 AS tool, blob4 AS error, blob10 AS size, blob11 AS hidden, blob12 AS acted,
  COUNT(DISTINCT blob3) AS people
FROM pdfree_events
WHERE timestamp > NOW() - INTERVAL '7' DAY AND index1 = 'Tool Error'
GROUP BY tool, error, size, hidden, acted ORDER BY people DESC LIMIT 80;


-- 4. Rage clicks by tool and element (tool from 2026-11-11)
SELECT blob2 AS tool, blob4 AS target, COUNT(DISTINCT blob3) AS people
FROM pdfree_events
WHERE timestamp > NOW() - INTERVAL '7' DAY AND index1 = 'Rage Click'
GROUP BY tool, target ORDER BY people DESC LIMIT 40;


-- 5. On-site search: what people look for and don't find (30 days)
SELECT blob1 AS locale, blob4 AS query, COUNT(DISTINCT blob3) AS people
FROM pdfree_events
WHERE timestamp > NOW() - INTERVAL '30' DAY AND index1 = 'Search Miss'
GROUP BY locale, query ORDER BY people DESC LIMIT 80;


-- 6. One tool before/after a deploy — replace the tool and the deploy time (UTC)
SELECT if(timestamp > toDateTime('2026-11-11 00:00:00'), 'after', 'before') AS period,
  index1 AS event, blob4 AS detail, COUNT(DISTINCT blob3) AS people, COUNT() AS events
FROM pdfree_events
WHERE timestamp > NOW() - INTERVAL '14' DAY AND blob2 = 'compress'
  AND index1 IN ('Tool Error', 'Tool Success', 'Tool Notice')
GROUP BY period, event, detail ORDER BY period, people DESC LIMIT 80;


-- 7. Timeline of chosen sessions — paste the ids from query 2 or 4
SELECT timestamp, blob3 AS session, index1 AS event, blob2 AS tool, blob4 AS detail,
  blob6 AS device, blob7 AS browser, blob9 AS app
FROM pdfree_events
WHERE timestamp > NOW() - INTERVAL '15' DAY
  AND (blob3 = '<session-1>' OR blob3 = '<session-2>' OR blob3 = '<session-3>')
ORDER BY session, timestamp LIMIT 300;


-- 8. Growth week over week — people (page loads with a tool open), all countries
--    and Ethiopia apart (one organization's batch work, 2026-10-28 on: it swings
--    the total both ways). Keep the numbers week by week; one week is not a trend.
SELECT if(timestamp > NOW() - INTERVAL '7' DAY, 'this', 'prev') AS period,
  if(blob4 = 'country=ET', 'ET', 'rest') AS part, COUNT(DISTINCT blob3) AS people
FROM pdfree_events
WHERE timestamp > NOW() - INTERVAL '14' DAY AND index1 = 'Tool Open'
GROUP BY period, part ORDER BY part, period;
--    Baseline 2026-11-12: prev 10,055 → this 11,091 (ET 1,224 → 653).
--    With it, read the Workers daily request peak in the Cloudflare dashboard
--    (Workers → Metrics): at 50,000 a day (half the free 100,000; past it the
--    whole site errors until 00:00 UTC) the owner moves to the paid plan.
