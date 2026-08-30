// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  formulaOcr.js — real math-formula OCR via Texo/FormulaNet
//  (@huggingface/transformers, ONNX Runtime Web/WASM). AGPL-3.0
//  licensed (both code and weights, huggingface.co/alephpi/FormulaNet)
//  — matches this project's own license exactly.
//
//  Preprocessing is a faithful port of Texo-web's own pipeline
//  (github.com/alephpi/Texo-web, app/composables/workers/ocr.ts +
//  imageProcessor.ts — read directly from their source, not guessed):
//  grayscale -> invert-if-mostly-dark -> crop-to-content ->
//  resize-with-BLACK-padding to 384x384 -> normalize (mean=0.7931,
//  std=0.1738, their published UniMERNet constants). The black
//  padding (not white) looks backwards for a white-background formula
//  crop but is intentional — matches how the reference implementation
//  feeds the model, presumably matching its training convention.
//
//  Real, verified constraint (tested directly this session, not
//  assumed from docs): model.generate({ inputs, output_scores: true,
//  return_dict_in_generate: true }) does NOT return a .scores property
//  for this model — only { sequences, past_key_values }. No per-token
//  confidence is obtainable this way. Consequence: recognizeFormula()
//  has no confidence tier — every result must be presented to the
//  reader with a visible disclosure by the caller (see
//  js/pdf2mdCore.js), never silently trusted. Real accuracy measured
//  this session across 17 diverse formulas: ~71% semantically correct,
//  including one severe failure (a function name misread into unrelated
//  symbols) — see pdf2md_formula_ocr_feasibility_2026_08 memory.
// ============================================================

import { loadTransformersJs } from './lazyLibs.js';

const MODEL_NAME     = 'alephpi/FormulaNet';
const UNIMERNET_MEAN = 0.7931;
const UNIMERNET_STD  = 0.1738;
const TARGET          = 384; // model's required square input size

let _model     = null;
let _tokenizer = null;

async function _ensureModel(onProgress) {
  if (_model && _tokenizer) return;
  const { VisionEncoderDecoderModel, PreTrainedTokenizer, env } = await loadTransformersJs();
  env.allowLocalModels = false;
  _model = await VisionEncoderDecoderModel.from_pretrained(MODEL_NAME, {
    dtype: 'fp32',
    progress_callback: onProgress,
  });
  _tokenizer = await PreTrainedTokenizer.from_pretrained(MODEL_NAME);
}

// ── Preprocessing (faithful port — see header comment) ──────────────

function _canvasFromBlob(bitmap) {
  const canvas = document.createElement('canvas');
  canvas.width  = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white'; // fix transparent background, same as the reference impl
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  return canvas;
}

function _toGrey(canvas) {
  const ctx = canvas.getContext('2d');
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const grey = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i++) {
    grey[i] = Math.round((data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3);
  }
  return { grey, width, height };
}

// Inverts if the image is mostly dark (e.g. a dark-mode/white-on-black
// crop) — a no-op for the overwhelming majority of real PDF page
// renders, which are already black-text-on-white.
function _maybeInvert(grey) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < grey.length; i++) hist[grey[i]]++;
  const threshold = 200;
  let black = 0, white = 0;
  for (let v = 0; v < threshold; v++) black += hist[v];
  for (let v = threshold; v < 256; v++) white += hist[v];
  if (black < white) return grey;
  const inverted = new Uint8ClampedArray(grey.length);
  for (let i = 0; i < grey.length; i++) inverted[i] = 255 - grey[i];
  return inverted;
}

function _cropMargin(grey, width, height) {
  let max = -Infinity, min = Infinity;
  for (let i = 0; i < grey.length; i++) {
    if (grey[i] > max) max = grey[i];
    if (grey[i] < min) min = grey[i];
  }
  if (max === min) return { grey, width, height };
  const threshold = 200;
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const normalized = ((grey[idx] - min) / (max - min)) * 255;
      if (normalized < threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const cw = maxX - minX, ch = maxY - minY;
  if (maxX < minX || maxY < minY || cw <= 0 || ch <= 0) return { grey, width, height };
  const cropped = new Uint8ClampedArray(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) cropped[y * cw + x] = grey[(y + minY) * width + (x + minX)];
  }
  return { grey: cropped, width: cw, height: ch };
}

// Resize (preserving aspect ratio, thumbnail-fit) then center on a
// TARGET x TARGET canvas padded with BLACK (0) — see header comment on
// why black, not white.
function _resizeWithPadding(grey, width, height) {
  const scale = TARGET / Math.min(width, height);
  let newW = Math.round(width * scale);
  let newH = Math.round(height * scale);
  if (newW > TARGET || newH > TARGET) {
    const ratio = Math.min(TARGET / newW, TARGET / newH);
    newW = Math.max(1, Math.round(newW * ratio));
    newH = Math.max(1, Math.round(newH * ratio));
  }

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = width; srcCanvas.height = height;
  const srcCtx = srcCanvas.getContext('2d');
  const srcImgData = srcCtx.createImageData(width, height);
  for (let i = 0; i < grey.length; i++) {
    srcImgData.data[i * 4] = srcImgData.data[i * 4 + 1] = srcImgData.data[i * 4 + 2] = grey[i];
    srcImgData.data[i * 4 + 3] = 255;
  }
  srcCtx.putImageData(srcImgData, 0, 0);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = TARGET; outCanvas.height = TARGET;
  const outCtx = outCanvas.getContext('2d');
  outCtx.fillStyle = 'black';
  outCtx.fillRect(0, 0, TARGET, TARGET);
  const padW = Math.floor((TARGET - newW) / 2);
  const padH = Math.floor((TARGET - newH) / 2);
  outCtx.drawImage(srcCanvas, 0, 0, width, height, padW, padH, newW, newH);

  const outData = outCtx.getImageData(0, 0, TARGET, TARGET).data;
  const out = new Uint8ClampedArray(TARGET * TARGET);
  for (let i = 0; i < TARGET * TARGET; i++) out[i] = outData[i * 4];
  return out;
}

function _normalize(grey) {
  const out = new Float32Array(grey.length);
  for (let i = 0; i < grey.length; i++) out[i] = (grey[i] / 255.0 - UNIMERNET_MEAN) / UNIMERNET_STD;
  return out;
}

async function _preprocess(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = _canvasFromBlob(bitmap);
  bitmap.close?.();
  let { grey, width, height } = _toGrey(canvas);
  grey = _maybeInvert(grey);
  ({ grey, width, height } = _cropMargin(grey, width, height));
  const resized = _resizeWithPadding(grey, width, height);
  return _normalize(resized);
}

/**
 * Recognizes a math formula from a cropped image (the same crop
 * pdf2mdCore.js's existing display-formula feature already produces).
 * No confidence score is available (see header comment) — the caller
 * MUST present a visible disclosure alongside the result, never trust
 * it silently.
 * @param {Blob} imageBlob - PNG/JPEG blob of the cropped formula.
 * @param {(info: object) => void} [onProgress] - forwarded to the
 *   model loader's own progress_callback on first use (76MB download).
 * @returns {Promise<{ latex: string }>}
 */
export async function recognizeFormula(imageBlob, onProgress) {
  await _ensureModel(onProgress);
  const array = await _preprocess(imageBlob);
  const { Tensor, cat } = await loadTransformersJs();
  const tensor = new Tensor('float32', array, [1, 1, TARGET, TARGET]);
  const pixel_values = cat([tensor, tensor, tensor], 1);
  const outputs = await _model.generate({ inputs: pixel_values });
  const text = _tokenizer.batch_decode(outputs, { skip_special_tokens: true })[0];
  return { latex: text.trim() };
}
