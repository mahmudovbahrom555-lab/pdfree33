# @pdfree/pdf2md-server

Self-hosted REST API for [`@pdfree/pdf2md-core`](../pdf2md-core) — `POST` a PDF, get Markdown back.
Runs on **your own** infrastructure; no file this processes ever touches pdfree.io's servers, same
guarantee as [pdfree.io's browser tool](https://pdfree.io/pdf-to-markdown/) and the CLI, just as a
REST API instead — the shape developer tools like Marker/Docling/HURIDOCS are usually reached
through. See [the real output-quality benchmark](https://pdfree.io/blog/pdf-to-markdown-benchmark/).

## Quick start (Docker)

```bash
# Build from the REPO ROOT, not this directory — see the Dockerfile's own
# header comment for why (it needs access to js/, same as `npm run sync`).
git clone https://github.com/mahmudovbahrom555-lab/pdfree33
cd pdfree33
docker build -f packages/pdf2md-server/Dockerfile -t pdf2md-server .
docker run -p 8080:8080 pdf2md-server
```

```bash
curl --data-binary @report.pdf -H "Content-Type: application/pdf" \
  http://localhost:8080/convert -o report.md
```

## API

- **`POST /convert`** — body: raw PDF bytes, `Content-Type: application/pdf` (or
  `application/octet-stream`). Response: Markdown text, `Content-Type: text/markdown`.
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

**There is no built-in authentication.** This matches how HURIDOCS and similar self-hosted
PDF/document tools are typically deployed — the expectation is that *you* put it behind your own
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
- Everything `@pdfree/pdf2md-core` already does: `isEvalSupported: false` (mitigates
  [CVE-2024-4367](https://github.com/advisories/GHSA-wgrm-67xf-hhpq)) and `disableJavaScript: true` —
  inherited automatically through the same `pdfToMarkdown()` call, nothing extra needed here.

What is NOT handled, by design, in v1: authentication, rate limiting, TLS termination (put a reverse
proxy in front for HTTPS). These are exactly the concerns a reverse proxy/API gateway already solves
well — not reinvented here.

## Resource usage — real numbers, not estimates

Each conversion is a real `worker_threads` Worker (its own V8 isolate) — measured directly, not
assumed: RSS started around 55MB idle, climbed to ~224MB after 30 sequential timeout-triggering
requests (each spawning and `terminate()`-ing a worker), then stayed essentially flat through 60
requests (~223MB) and only crept to ~242MB by 100 requests. That pattern — fast initial growth, then
near-flat — is consistent with normal Node/V8 worker-thread memory retention (isolate creation
overhead the OS doesn't eagerly reclaim) plateauing, not an unbounded per-request leak; a real leak
would show roughly constant growth per batch, which this doesn't. Give the container at least
**~300-400MB** of memory headroom in practice, not a minimal 128MB limit, and set a real container
memory limit regardless (`docker run -m 512m ...` or your orchestrator's equivalent) as the practical
backstop — standard practice for any long-running service, not a substitute for the above finding.

## Architecture — why a worker thread

The conversion runs in `convertWorker.js`, a separate `worker_threads` `Worker`, not the same thread
as the HTTP server. This was verified to matter, not a stylistic choice: a same-thread
`Promise.race()` against `AbortSignal.timeout()`/`setTimeout()` was tried first and does **not**
reliably enforce a deadline for this workload — confirmed directly on a real 130-page/20MB PDF that a
timer scheduled mid-conversion can fail to fire at all until the whole conversion finishes, because
pdf.js's per-page `await` chain resolves fast enough to stay entirely in the microtask queue,
starving Node's timer/macrotask phase for the full duration. A same-thread timeout would still
return an HTTP response to the client on schedule, but the real conversion keeps burning CPU
unbounded in the background — a real DoS vector for a server accepting untrusted uploads, not a
cosmetic issue. Running the conversion in a worker thread means the main thread's own event loop is
never blocked by it, so its timeout timer fires reliably, and `worker.terminate()` forcibly kills the
worker regardless of what it's doing internally.

## Example: docker-compose

```yaml
services:
  pdf2md:
    build:
      context: .              # repo root
      dockerfile: packages/pdf2md-server/Dockerfile
    ports:
      - "8080:8080"
    environment:
      - MAX_BODY_BYTES=52428800
      - TIMEOUT_MS=60000
    restart: unless-stopped
```

## Development (without Docker)

```bash
cd packages/pdf2md-server
npm install --omit=optional
npm test    # real end-to-end tests: real HTTP requests, real PDFs, real security-path checks
npm start   # PORT=8080 node server.js
```

## License

AGPL-3.0-only, same as the parent project.
