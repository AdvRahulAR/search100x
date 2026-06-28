/**
 * Cross-encoder re-ranker (optional, opt-in via `rerank: true` in SearchOptions).
 *
 * Uses ms-marco-MiniLM-L-6-v2 via ONNX Runtime Node — no Python, no server.
 * Reads query + passage together and outputs a single relevance score (cross-encoder),
 * which captures semantics that BM25 term-overlap cannot (synonyms, paraphrases,
 * negation, contextual relevance).
 *
 * Setup:
 *   npm install onnxruntime-node
 *   node scripts/download-reranker.mjs   # downloads ~23MB ONNX model to models/
 *
 * Latency: ~30ms per candidate on CPU for MiniLM-L-6 (6 layers, 22M params).
 * Warm session (after first call): ~5ms overhead for session lookup.
 *
 * Blend: final_score = 0.60 × ce_score + 0.40 × cascade_score
 * This preserves the cross-engine consensus signal while letting the CE
 * override clear mismatches between rank and actual relevance.
 */

import { SearchResult } from "./types.js";

// Lazy-loaded to avoid import cost when rerank: false (the common case)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ort: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let session: any = null;

const MODEL_PATH = new URL("../../models/cross-encoder.onnx", import.meta.url).pathname;
const CE_ALPHA   = 0.60;  // cross-encoder weight in the final blend
const MAX_SEQ    = 512;   // MiniLM context window (tokens)

// ── Minimal WordPiece tokenizer for bert-base-uncased ────────────────────────
// Full vocab load is ~900KB. We use a dynamic import so it's only loaded when
// the reranker is actually called.

let vocab: Map<string, number> | null = null;

async function getVocab(): Promise<Map<string, number>> {
  if (vocab) return vocab;
  // vocab.json ships alongside the ONNX model in models/
  const vocabPath = new URL("../../models/vocab.json", import.meta.url).pathname;
  const { readFileSync } = await import("fs");
  const raw  = JSON.parse(readFileSync(vocabPath, "utf-8")) as Record<string, number>;
  vocab = new Map(Object.entries(raw));
  return vocab;
}

function tokenizeWordPiece(text: string, vocab: Map<string, number>): number[] {
  const UNK = vocab.get("[UNK]") ?? 100;
  const ids: number[] = [];

  for (const word of text.toLowerCase().split(/\s+/)) {
    if (vocab.has(word)) {
      ids.push(vocab.get(word)!);
      continue;
    }
    // Greedy longest-match WordPiece
    let start = 0;
    let isUnk = false;
    while (start < word.length) {
      let matched = false;
      for (let end = word.length; end > start; end--) {
        const sub    = start === 0 ? word.slice(start, end) : `##${word.slice(start, end)}`;
        const subId  = vocab.get(sub);
        if (subId !== undefined) {
          ids.push(subId);
          start   = end;
          matched = true;
          break;
        }
      }
      if (!matched) { isUnk = true; break; }
    }
    if (isUnk) ids.push(UNK);
  }

  return ids;
}

function buildInputs(
  query:   string,
  passage: string,
  vocab:   Map<string, number>
): { inputIds: bigint[]; attentionMask: bigint[]; tokenTypeIds: bigint[] } {
  const CLS = vocab.get("[CLS]") ?? 101;
  const SEP = vocab.get("[SEP]") ?? 102;
  const PAD = vocab.get("[PAD]") ?? 0;

  const qIds = tokenizeWordPiece(query,   vocab);
  const pIds = tokenizeWordPiece(passage, vocab);

  // [CLS] query [SEP] passage [SEP]
  // Truncate passage if needed to fit MAX_SEQ
  const overhead = 3; // CLS + 2×SEP
  const maxPLen  = MAX_SEQ - overhead - qIds.length;
  const pTrunc   = pIds.slice(0, Math.max(0, maxPLen));

  const rawIds = [CLS, ...qIds, SEP, ...pTrunc, SEP];
  const seqLen = rawIds.length;

  // Pad to MAX_SEQ
  const padded  = [...rawIds, ...Array(MAX_SEQ - seqLen).fill(PAD)];
  const mask    = [...Array(seqLen).fill(1), ...Array(MAX_SEQ - seqLen).fill(0)];
  const typeIds = [
    ...Array(qIds.length + 2).fill(0),
    ...Array(pTrunc.length + 1).fill(1),
    ...Array(MAX_SEQ - seqLen).fill(0),
  ];

  return {
    inputIds:     padded.map(BigInt),
    attentionMask: mask.map(BigInt),
    tokenTypeIds: typeIds.map(BigInt),
  };
}

async function getSession(): Promise<unknown> {
  if (session) return session;

  if (!ort) {
    try {
      // Dynamic import — not a static dependency; won't fail if not installed
      // until rerank: true is actually used.
      ort = await import("onnxruntime-node" as string);
    } catch {
      throw new Error(
        "[search100x reranker] onnxruntime-node not installed.\n" +
        "Run: npm install onnxruntime-node\n" +
        "Then: node scripts/download-reranker.mjs"
      );
    }
  }

  const { readFileSync } = await import("fs");
  try {
    readFileSync(MODEL_PATH);
  } catch {
    throw new Error(
      `[search100x reranker] Model not found at ${MODEL_PATH}\n` +
      "Run: node scripts/download-reranker.mjs"
    );
  }

  session = await ort.InferenceSession.create(MODEL_PATH, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  });
  return session;
}

/**
 * Re-rank search results using a cross-encoder.
 *
 * Takes top `candidateN` results, scores each query+passage pair, then blends
 * the CE score (60%) with the existing cascade score (40%) and re-sorts.
 *
 * Falls back gracefully (logs warning, returns original order) if onnxruntime-node
 * is not installed or the model file is missing.
 */
export async function rerankResults(
  query:       string,
  results:     SearchResult[],
  candidateN = 20
): Promise<SearchResult[]> {
  if (results.length === 0) return results;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sess: any;
  let v: Map<string, number>;

  try {
    [sess, v] = await Promise.all([getSession(), getVocab()]);
  } catch (err) {
    console.warn(String(err));
    return results;
  }

  const candidates = results.slice(0, candidateN);
  const rest       = results.slice(candidateN);

  const scores = await Promise.all(
    candidates.map(async (r) => {
      const text = r.content ?? r.snippet ?? r.title;
      const { inputIds, attentionMask, tokenTypeIds } = buildInputs(query, text, v);
      const len = inputIds.length;

      const feeds = {
        input_ids:      new ort.Tensor("int64", inputIds,      [1, len]),
        attention_mask: new ort.Tensor("int64", attentionMask, [1, len]),
        token_type_ids: new ort.Tensor("int64", tokenTypeIds,  [1, len]),
      };

      const out    = await sess.run(feeds);
      const logit  = Number((out["logits"].data as Float32Array)[0]);
      // Sigmoid: maps logit to [0,1] probability
      return 1 / (1 + Math.exp(-logit));
    })
  );

  // Blend CE score with existing cascade score
  candidates.forEach((r, i) => {
    r.score = CE_ALPHA * scores[i] + (1 - CE_ALPHA) * r.score;
  });

  // Re-sort candidates, then append the rest (already lower-ranked)
  candidates.sort((a, b) => b.score - a.score);
  return [...candidates, ...rest];
}
