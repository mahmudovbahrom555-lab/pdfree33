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

## Scope extension — owner APPROVED 2026-11-06 (before the DEV run)
1. **Images with an SMask:** the CMYK image itself is re-encoded; the SMask stream stays byte for byte.
2. **/Decode [1 0 1 0 1 0 1 0] (inverted):** samples are read as a reader sees them and written
   without the array. /Decode of any other form is skipped.

## Owner request 2026-11-06 (after the first blind page): test D at 150 dpi
The owner saw no difference with the eye on L vs D300/D200 and asked to test 150 dpi. This is
BELOW the v0.2 floor "never below 200 dpi" — an owner decision to explore, recorded before the
run. Added grid points D150q85, D150q75; same method (smaller-only, pure-K guard, D vs L). The
floor in criteria v0.2 is not changed by this run; the owner decides after the blind check.

First numbers (0486224, on top of our current output; the leader is a reference only):
- D300q75: −68 %, SSIM min 1.000, ΔE76 0.03;
- D200q75: −74 %, SSIM min 0.988, ΔE76 0.14;
- the leader's recommended: −81 %, 0.966, 0.29.
3778515: nothing (already at 150 dpi; q75 is no smaller). The leader's recommended: −1 %.

## Owner decision 2026-11-06 (after the D150 run)
D150 gave 312 MB vs D200's 316 (−1 % more) with slightly larger texture ΔE → "1 % isn't worth it".
**The 200 dpi floor stays. D = D200q75** (blind round 1: 16/16 "same" for D300q75/D200q75).
Round 2 (D150) is not needed for the decision; its 2 hidden positive controls still tell whether
round 1's method could see a difference at all.
