# Analytics units — what each event counts

The units the funnel is built from, and where each begins and ends. Written
2026-10-25 after `File Added` was found counting only adds that left exactly
one file in the list (#84) and Draw on PDF never sending a result (#85): an
undefined unit gets a different meaning in every tool. Any new tool or event
follows these rules, or changes this file in the same PR.

What is sent at all, and what never is, is the privacy policy (`/privacy/`).
These units must stay inside it: **no identifier links one page load to
another**, so no unit here is a person.

## Session — one page load

`session` in every event: a random key made when the page loads
(`js/analytics.js`), kept in memory only, gone on reload or close. A person
who opens two tool pages is two sessions; a reload is a new session. Never
read a session count as a number of people.

## Tool open — `Tool Open`

Sent each time a tool is shown (`showTool` in `js/app.js`): a tool page
loading, or another tool opened inside the page. It starts an attempt.

## Attempt — `File Added` (def 2, from 2026-10-25)

From a tool opening, or a result, to the next result. `File Added` is sent
once per attempt, at the first add, however many files come at once.

| What happens | Attempt |
|---|---|
| one file, then more | same |
| files removed and added again before a result | same |
| an error (`Tool Error`), a cancel (`Tool Cancel`) | same — the next try continues it |
| a result | ends; the next add starts a new one |
| another tool opened in the page | new |
| page reload | new (new session too) |

Before def 2, `File Added` counted only an add that left exactly one file in
the list. Compare it only within one definition; the old data is not
recomputed.

## Result — `Tool Success`

The tool built its output: one per result, sent when the result is ready
(`_handleSuccess` in `js/app.js`, from `pdfree:success`). A batch (many files
→ one zip) is one result; `Batch Success` carries the file counts. A tool that
delivers its result itself must send it itself, once per result — Draw on PDF
does since #85 (2026-10-25); before that Draw had none. A result ends the
attempt (`pdfree:attempt-done` for such tools).

## Download — `Download`

The download was started: once per result (the automatic one). "Download
again", or Draw exporting the same drawing again, is not counted. Success and
Download are separate facts — successes without downloads mean downloads that
didn't start.

## What these units can't tell

- **People and returns.** No identifier, by design. Proxies only: `App Launch`
  (opened as an installed app), the share of direct visits (Cloudflare Web
  Analytics), searches for the brand (Search Console), and repeat results
  within one page load (`Retry Conversion`, `Quick Retry`).
- **Whether a result was good.** A broken or incomplete file is still a
  `Tool Success`. Quality is measured on the corpus (`tests/corpus/`), never
  inferred from these events.
- **Bots.** Automated browsers that say so (`navigator.webdriver`) send
  nothing; others do. Exclude them at analysis time by a rule written down
  first, keep the raw view beside the filtered one, and never by country alone.
- **Small groups.** A tool or a locale with a handful of sessions is not a
  conversion rate.
