# CMYK mode D (lossy, stays CMYK) — measurement before any browser code, PRE-REGISTERED 2026-11-06

Owner (2026-11-06): start D. The leader's recommended mode keeps CMYK and re-encodes it
(0486224: −81 %, SSIM min 0.966, ΔE 0.29); its strong mode converts CMYK → RGB (3778515:
ΔE 3.06), which breaks print workflows. Our D = CMYK stays CMYK (criteria v0.2: CMYK → RGB
forbidden). The leader is a reference point, never a threshold (owner, 2026-11-05).

## Prototype (Python, measurement only)
- **Targets:** DeviceCMYK 8-bit images, DCT or Flate, no SMask/Mask (v0.2 scope).
- **Effective dpi:** computed over all placements of the image (MuPDF image rects), the largest
  rect deciding. Never below 200 dpi. Images whose effective dpi is already <= the target are
  not resampled (quality step only).
- **Encoder:** Pillow CMYK JPEG (Adobe convention, inverted samples), 4:4:4, no colour transform.
- **Grid:**
  - D300-q85, D300-q75, D200-q85, D200-q75 (dpi target, JPEG quality);
  - L (lossless) as the zero reference;
  - the original re-encoded twice at the same setting (run-to-run noise).
- **A file is kept smaller-only:** if the D result isn't smaller, the original image stays (rule C).

## Documents
- DEV: the CMYK documents of all52 (cb-data/all52.txt) that have target images.
- REF: the two leader files 0486224, 3778515 (with the leader's outputs) — reported separately.

## Metrics (criteria v0.2, level 2)
- **V1 pure K:** pixels with C = M = Y = 0 in the original keep C, M, Y <= 2/255.
- **V2/V3 ΔE2000 by 8×8 block at 150 dpi:**
  - the image samples are converted to Lab through the document's OutputIntent, or else
    Ghostscript's default_cmyk.icc as a CONDITIONAL measurement profile (flagged);
  - flat blocks (low variance) and textured blocks are reported separately — mean, p95, max.
- **V5 plates:** Ghostscript tiffsep (Ghostscript version logged), page by page; mean |Δ| and
  p99 per C, M, Y, K plate, as a % of 255; spot plates by name.
- **Page SSIM (min)** and size ratio — the same compare_pack.py as the leader comparison, so
  the numbers line up.

## Thresholds
The v0.2 values are HYPOTHESES, calibrated here — nothing passes or fails in this stage. They
are calibrated against L (must give 0), the run-to-run noise, and the D grid. The owner approves
the thresholds; then the owner's blind check (worse / same / can't tell) on D pairs.

## Not in this stage
Browser code (decoder, 4-channel encoder, worker), presets, UI.
