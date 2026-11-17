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
--    Rage Click: blob2 tool (from 2026-11-11; '' on the homepage), blob4 target,
--      blob5 country … blob9 app, from 2026-11-18 blob10 x_edited (a text field's value
--      changed within 2 s of the clicks: yes/no; n/a elsewhere).
--    Tool Success, pdf2word: blob4 input_size, blob5 output_size, blob6 mode,
--      from 2026-11-14 blob7 pages (1–5/6–20/21–100/> 100), blob8 ocr (yes/no),
--      then country (blob9 — was blob7 before); double1 duration_s.
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
--    edited=yes on a field: clicked to select and retype, not trouble.
SELECT blob2 AS tool, blob4 AS target, blob10 AS edited, COUNT(DISTINCT blob3) AS people
FROM pdfree_events
WHERE timestamp > NOW() - INTERVAL '7' DAY AND index1 = 'Rage Click'
GROUP BY tool, target, edited ORDER BY people DESC LIMIT 40;


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


-- 9. Compress "fit into a size" (from 2026-11-13): which sizes people ask for, how often
--    they fit, at which setting (0 lossless … 9 72 dpi q0.30), in how many tries.
--    Columns: blob4 target ("4 MB", "500 KB"), blob5 input_size, blob6 result
--    ("fits" | "over ≤10%" | "over 10–50%" | "over 50–100%" | "over >2×"),
--    double1 step, double2 runs.
SELECT blob4 AS target, blob6 AS result, COUNT(DISTINCT blob3) AS people,
  avg(double1) AS avg_step, avg(double2) AS avg_runs
FROM pdfree_events
WHERE timestamp > NOW() - INTERVAL '30' DAY AND index1 = 'Compress Target'
GROUP BY target, result ORDER BY people DESC LIMIT 60;


-- 10. PDF to Word time by page range and text recognition (from 2026-11-14):
--     a quarter of 1–10 MB runs took over 2 min and nothing said why.
--     blob7 pages, blob8 ocr (yes/no), double1 duration_s (rounded to 5 s).
SELECT blob7 AS pages, blob8 AS ocr, COUNT(DISTINCT blob3) AS people, COUNT() AS runs,
  avg(double1) AS avg_s, SUM(if(double1 > 120, 1, 0)) AS over_2_min
FROM pdfree_events
WHERE timestamp > toDateTime('2026-11-14 03:00:00') AND index1 = 'Tool Success' AND blob2 = 'pdf2word'
GROUP BY pages, ocr ORDER BY runs DESC LIMIT 40;


-- 11. Notices and hand-offs between tools (Fill with no fields → Draw, Resize/Manga → N-up)
SELECT index1 AS event, blob2 AS tool, blob4 AS detail, blob5 AS detail2,
  COUNT(DISTINCT blob3) AS people
FROM pdfree_events
WHERE timestamp > NOW() - INTERVAL '14' DAY
  AND (index1 = 'Tool Notice' OR index1 = 'Cross Sell Click'
       OR (index1 = 'File Added' AND blob2 = 'fill'))
GROUP BY event, tool, detail, detail2 ORDER BY people DESC LIMIT 60;


-- 12. Files a tool turned away when added (from 2026-11-14): which tool, which extension.
--     Word to PDF and ".doc": is converting old .doc files (a ~100 MB converter) worth it?
SELECT blob2 AS tool, blob4 AS ext, COUNT(DISTINCT blob3) AS people, COUNT() AS events
FROM pdfree_events
WHERE timestamp > NOW() - INTERVAL '7' DAY AND index1 = 'File Rejected'
GROUP BY tool, ext ORDER BY people DESC LIMIT 40;


-- 13. JPG→PDF's scanner hint (from 2026-11-16): one photo shows "Photo of a paper page?
--     Open it in Document Scanner"; a click carries the photo there. Pre-registered:
--     after 7 days, clicks / shows under ~3 % → remove the hint; above → keep it and
--     check that clickers get a scan (13b). A session id lives one page load, so the
--     scanner marks the photo it received (Tool Notice photo_from_jpg2pdf).
SELECT
  COUNT(DISTINCT if(index1 = 'Tool Notice' AND blob2 = 'jpg2pdf' AND blob4 = 'notice=scan_hint', blob3, '')) - max(if(index1 = 'Tool Notice' AND blob2 = 'jpg2pdf' AND blob4 = 'notice=scan_hint', 0, 1)) AS shown,
  COUNT(DISTINCT if(index1 = 'Cross Sell Click' AND blob4 = 'from=jpg2pdf' AND blob5 = 'to=scanDocument', blob3, '')) - max(if(index1 = 'Cross Sell Click' AND blob4 = 'from=jpg2pdf' AND blob5 = 'to=scanDocument', 0, 1)) AS clicked
FROM pdfree_events
WHERE timestamp > toDateTime('2026-11-17 00:00:00');

-- 13b. Scanner page loads that received the photo: did they save a PDF?
SELECT blob3 AS session,
  SUM(if(index1 = 'Tool Notice' AND blob4 = 'notice=photo_from_jpg2pdf', 1, 0)) AS got_photo,
  SUM(if(index1 = 'Tool Success', 1, 0)) AS scanned
FROM pdfree_events
WHERE timestamp > toDateTime('2026-11-17 00:00:00') AND blob2 = 'scanDocument'
GROUP BY session HAVING got_photo > 0 ORDER BY scanned LIMIT 200;


-- 14. Funnel per tool — people (page loads) who opened, added a file, PRESSED the
--     button (Tool Start, from 2026-11-17), got a result, hit an error, cancelled.
--     Analytics Engine rejects NULL in if(): '' stands in and is taken off again.
SELECT blob2 AS tool,
  COUNT(DISTINCT if(index1 = 'Tool Open', blob3, ''))    - max(if(index1 = 'Tool Open', 0, 1))    AS opened,
  COUNT(DISTINCT if(index1 = 'File Added', blob3, ''))   - max(if(index1 = 'File Added', 0, 1))   AS added_file,
  COUNT(DISTINCT if(index1 = 'Tool Start', blob3, ''))   - max(if(index1 = 'Tool Start', 0, 1))   AS pressed,
  COUNT(DISTINCT if(index1 = 'Tool Success', blob3, '')) - max(if(index1 = 'Tool Success', 0, 1)) AS succeeded,
  COUNT(DISTINCT if(index1 = 'Tool Error', blob3, ''))   - max(if(index1 = 'Tool Error', 0, 1))   AS hit_error,
  COUNT(DISTINCT if(index1 = 'Tool Cancel', blob3, ''))  - max(if(index1 = 'Tool Cancel', 0, 1))  AS cancelled
FROM pdfree_events
WHERE timestamp > toDateTime('2026-11-18 00:00:00') AND blob2 != ''
GROUP BY tool ORDER BY opened DESC LIMIT 60;

