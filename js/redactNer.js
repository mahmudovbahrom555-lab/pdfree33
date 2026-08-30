// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  redactNer.js — opt-in "AI Name Detection (Beta)" for js/redactUI.js's
//  existing PII-pattern search. Runs Xenova/bert-base-NER (transformers.js,
//  ONNX Runtime Web/WASM) client-side, entirely in-browser — same
//  no-server-round-trip guarantee as every other tool on this site.
//
//  Scoped to PERSON + LOCATION entities only (not ORG/MISC) — these are
//  the two PII categories regex genuinely cannot cover (js/redactUI.js's
//  own PII_PATTERNS handles email/phone/card/IBAN/URL, all of which HAVE
//  a reliable format; a person's name or address does not).
//
//  REAL, VERIFIED LIMITATION (tested directly this session, not assumed):
//  bert-base-NER is English-only (trained on CoNLL-2003). Tested live
//  against a real Uzbek document — it completely missed the actual PII
//  name present and instead tagged fragments of ordinary Uzbek words as
//  false-positive ORG entities. This is NOT a "works a bit worse on other
//  languages" situation — it doesn't understand them at all. Ship English-
//  only, on purpose, honestly labeled in the UI (rdct_ai_name_disclosure) —
//  do NOT silently offer this for non-English documents.
//
//  Also verified live: transformers.js's token-classification pipeline for
//  THIS model does NOT support aggregation_strategy the way the Python
//  HuggingFace API does (still returns raw per-subword B-/I- tags, no
//  merged entity_group/start/end) — mergeNerTokens() below does that
//  merging by hand. Batch array input (`ner([str1, str2, ...])`) DOES work
//  and returns a parallel nested array — used here to run one inference
//  call across every text item on every page instead of one call per item.
// ============================================================

import { loadTransformersJs } from './lazyLibs.js';

const MODEL_NAME = 'Xenova/bert-base-NER';
const _ENTITY_TYPES = new Set(['PER', 'LOC']); // ORG/MISC excluded — see header
const _MIN_SCORE = 0.5; // floor to cut obvious noise; final result is still opt-in + user-reviewed

let _ner = null;

async function _ensurePipeline(onProgress) {
  if (_ner) return _ner;
  const { pipeline, env } = await loadTransformersJs();
  env.allowLocalModels = false;
  _ner = await pipeline('token-classification', MODEL_NAME, { progress_callback: onProgress });
  return _ner;
}

// Merges a raw per-subword token-classification result (B-/I- tags, no
// aggregation) into clean entity spans. Pure function, no browser API —
// see tests/redactNer.test.js.
//
// Rules:
//  - A "##"-prefixed word is a wordpiece continuation of the current
//    token — glued on with no space (bert's tokenizer convention).
//  - An "I-<type>" tag immediately following a span of the SAME type
//    (not a wordpiece) is a new whole word still part of the same
//    entity ("Smith" after "John") — joined with a single space.
//  - A "B-<type>" tag always starts a fresh span, even if the previous
//    span was the same type (two back-to-back distinct entities).
//  - Anything else (a different type, ORG/MISC, or a gap) closes the
//    current span.
// Punctuation dropped between merged words (e.g. a hyphen in a
// hyphenated surname) is a known, accepted simplification — the
// resulting text may not be an exact substring of the source in that
// rare case, and the caller's position lookup already skips entities
// it can't find, rather than guessing.
export function mergeNerTokens(tokens) {
  const spans = [];
  let current = null;

  for (const tok of tokens) {
    const tag = tok.entity || '';
    const dash = tag.indexOf('-');
    const type = dash === -1 ? tag : tag.slice(dash + 1);
    const isBegin = tag.startsWith('B-');
    const isInside = tag.startsWith('I-');
    const relevant = _ENTITY_TYPES.has(type);
    const isWordpiece = tok.word.startsWith('##');
    const cleanWord = isWordpiece ? tok.word.slice(2) : tok.word;

    if (relevant && isWordpiece && current && current.type === type) {
      current.text += cleanWord;
      current.minScore = Math.min(current.minScore, tok.score);
      continue;
    }
    if (relevant && isInside && !isBegin && current && current.type === type) {
      current.text += ' ' + cleanWord;
      current.minScore = Math.min(current.minScore, tok.score);
      continue;
    }

    if (current) spans.push(current);
    current = relevant ? { text: cleanWord, type, minScore: tok.score } : null;
  }
  if (current) spans.push(current);

  return spans.filter(s => s.minScore >= _MIN_SCORE);
}

/**
 * Runs NER over a batch of independent text strings (one call, not one
 * per string — see header) and returns the merged entity spans found in
 * each, aligned by index with the input array.
 * @param {string[]} texts
 * @param {(p: object) => void} [onProgress] - transformers.js progress_callback
 *   shape ({status, file, progress, loaded, total}), only fires meaningfully
 *   the first time (model download), forwarded as-is for the caller's own
 *   loading UI.
 * @returns {Promise<{text, type, minScore}[][]>}
 */
export async function detectEntitiesBatch(texts, onProgress) {
  if (texts.length === 0) return [];
  const ner = await _ensurePipeline(onProgress);
  const results = await ner(texts);
  // A single-string call returns a flat token array, not nested — normalize
  // so this function's own contract (always one array of spans per input
  // string) holds regardless of batch size.
  const perText = texts.length === 1 && !Array.isArray(results[0]) ? [results] : results;
  return perText.map(mergeNerTokens);
}
