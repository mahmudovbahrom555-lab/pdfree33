# @pdfree/pdf2read-server

Self-hosted REST API for [`@pdfree/pdf2read-core`](../pdf2read-core) — `POST` a PDF, get structured
reading blocks back. Runs on **your own** infrastructure; no file this processes ever touches
pdfree.io's servers, same guarantee as [pdfree.io's browser tool](https://pdfree.io/?tool=read) and
the CLI, just as a REST API instead — useful for batch-reflowing a document library, or feeding a
"read this PDF on my phone" pipeline that isn't a browser tab.

## Quick start (Docker)

```bash
# Build from the REPO ROOT, not this directory — see the Dockerfile's own
# header comment for why (it needs access to js/, same as `npm run sync`).
git clone https://github.com/mahmudovbahrom555-lab/pdfree33
cd pdfree33
docker build -f packages/pdf2read-server/Dockerfile -t pdf2read-server .
docker run -p 8080:8080 pdf2read-server
```

```bash
curl --data-binary @report.pdf -H "Content-Type: application/pdf" \
  http://localhost:8080/reflow -o report.json
```

## API

- **`POST /reflow`** — body: raw PDF bytes, `Content-Type: application/pdf` (or
  `application/octet-stream`). Response: `{ pages, pageCount }` JSON, `Content-Type: application/json`.
- **`GET /health`** — `{"status":"ok"}`, for container orchestration health/readiness checks.

No multipart/form-data — send the PDF's raw bytes directly as the request body, exactly what
`curl --data-binary @file.pdf` already does above.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port. |
| `MAX_BODY_BYTES` | `52428800` (50 MB) | Reject larger uploads with `413`, checked while streaming — never buffers an oversized upload fully into memory first. |
| `TIMEOUT_MS` | `60000` (60 s) | Hard deadline per conversion. Enforced via a real `worker_threads` `terminate()` — see [Architecture](#architecture-why-a-worker-thread) below for why a simpler same-thread timeout doesn't actually work for this. |
| `MAX_CONCURRENT` | `4` | Max simultaneous conversions. Each one is a real `worker_threads` Worker (its own V8 isolate) — with no cap, N simultaneous large-PDF requests spawn N simultaneous workers with no bound, a real OOM path on a self-hosted box with limited RAM. |
| `QUEUE_TIMEOUT_MS` | `30000` (30 s) | How long a request waits for a free conversion slot once `MAX_CONCURRENT` is already busy, before giving up with `503`. |

## Security — read this before exposing it beyond localhost

**There is no built-in authentication.** Same posture as
[`@pdfree/pdf2md-server`](../pdf2md-server) — the expectation is that *you* put it behind your own
reverse proxy, firewall, VPN, or auth layer if it's reachable from anywhere untrusted. Running it
open on the public internet with no auth in front means anyone who finds it can burn your CPU/memory
converting PDFs.

What IS handled here:
- **Request size limit** (`MAX_BODY_BYTES`) — rejects oversized uploads before fully buffering them.
- **PDF signature check** — the body must start with the real `%PDF-` magic bytes every valid PDF has;
  an obviously-not-a-PDF upload is rejected with `400` before ever consuming a conversion slot or
  spawning a worker, not just a nicer error after the fact.
- **Concurrency limit + queue** (`MAX_CONCURRENT`, `QUEUE_TIMEOUT_MS`) — bounds how many worker
  threads can be alive at once; requests beyond the limit queue briefly rather than each spawning
  their own unbounded worker.
- **Real, enforced timeout** (`TIMEOUT_MS`) — a stuck/adversarial PDF's conversion is forcibly killed
  via a worker thread, not just abandoned in the background while the client gets an early response.
- **Non-root container user** (`USER node` in the Dockerfile).
- **`HEALTHCHECK`** in the Dockerfile — container orchestrators (Docker, Compose, Kubernetes-via-probe
  translation, etc.) can detect a wedged/unresponsive container automatically.
- Everything `@pdfree/pdf2read-core` already does: `isEvalSupported: false` (mitigates
  [CVE-2024-4367](https://github.com/advisories/GHSA-wgrm-67xf-hhpq)) and `disableJavaScript: true` —
  inherited automatically through the same `pdfToReadingBlocks()` call, nothing extra needed here.

What is NOT handled, by design, in v1: authentication, rate limiting, TLS termination (put a reverse
proxy in front for HTTPS). These are exactly the concerns a reverse proxy/API gateway already solves
well — not reinvented here.

## Resource usage

Same architecture as [`@pdfree/pdf2md-server`](../pdf2md-server) — each conversion is a real
`worker_threads` Worker (its own V8 isolate), so expect similar overhead per in-flight request (that
sibling package's own README has real, directly-measured numbers for its own workload — a useful
ballpark, not identical since the actual per-page work differs). Measured directly for THIS package,
not assumed: a real end-to-end test run (11 requests total, including 2 that each spawn a second
concurrent worker) kept RSS in the same tens-of-MB range you'd expect from a handful of short-lived
V8 isolates — set a real container memory limit regardless (`docker run -m 512m ...` or your
orchestrator's equivalent) as the practical backstop for production traffic patterns this quick local
run doesn't represent, not a substitute for load-testing your own real workload.

## Architecture — why a worker thread

The conversion runs in `convertWorker.js`, a separate `worker_threads` `Worker`, not the same thread
as the HTTP server. Same real, verified reason as
[`@pdfree/pdf2md-server`](../pdf2md-server)'s own architecture: a same-thread `Promise.race()`
against `AbortSignal.timeout()`/`setTimeout()` does **not** reliably enforce a deadline for this kind
of workload — pdf.js's per-page `await` chain resolves fast enough to stay entirely in the microtask
queue, starving Node's timer/macrotask phase for the full duration (see that package's own README for
the full, directly-reproduced 130-page/20MB case this was found on — the underlying extraction engine
is a shared sibling, so the same failure mode applies here). Running the conversion in a worker
thread means the main thread's own event loop is never blocked by it, so its timeout timer fires
reliably, and `worker.terminate()` forcibly kills the worker regardless of what it's doing
internally — confirmed directly by this package's own test suite (`SECURITY: a slow conversion is
really cut off by TIMEOUT_MS...`, a real 200ms timeout against a real multi-page PDF).

## Example: docker-compose

```yaml
services:
  pdf2read:
    build:
      context: .              # repo root
      dockerfile: packages/pdf2read-server/Dockerfile
    ports:
      - "8080:8080"
    environment:
      - MAX_BODY_BYTES=52428800
      - TIMEOUT_MS=60000
    restart: unless-stopped
```

## Development (without Docker)

```bash
cd packages/pdf2read-server
npm install --omit=optional
npm test    # real end-to-end tests: real HTTP requests, real PDFs, real security-path checks
npm start   # PORT=8080 node server.js
```

## License

AGPL-3.0-only, same as the parent project.
