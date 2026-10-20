# C4 — digits the text layer gets wrong (research tool, not a gate)

Measures class C4 of `tests/corpus/ERROR_CLASSES.md` on a folder of PDFs:

1. `c4scan.py <docs> <out.json>` — candidates: a digit glyph whose ToUnicode
   digit differs from the embedded font's own Unicode cmap (fontTools).
2. `shape.py` — the arbiter: a glyph's drawn shape against 606 reference
   digits rendered from macOS system fonts (Latin, Arabic-Indic, Persian).
3. `calib.py` / `evalcal.py` — the hand-labeled calibration (120 crops,
   labels in `evalcal.py`, seed 7) — 54/54 and 57/57 on held-out documents.
4. `prevalence.py` — every candidate judged by the arbiter.

Needs: PyMuPDF 1.26.5, fontTools, numpy, opencv-python-headless, Pillow;
macOS for the reference fonts. Paths assume the corpus in `../ar/docs`
(fetch it with `scripts/corpus-cloud/fetch.py`), the scan in `../ar/c4scan3.json`, crops in `../c4crops/`. Not a measuring stick: if it
ever decides whether a change is accepted, it moves under the owner's review
(CLAUDE.md, measuring sticks).
