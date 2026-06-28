/**
 * Downloads ms-marco-MiniLM-L-6-v2 ONNX model + vocab to models/
 * Run once: node scripts/download-reranker.mjs
 *
 * Model source: Hugging Face cross-encoder/ms-marco-MiniLM-L-6-v2
 * Size: ~23 MB ONNX, ~226 KB vocab
 */

import { createWriteStream, mkdirSync, existsSync } from "fs";
import { pipeline } from "stream/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(__dirname, "..", "models");

const FILES = [
  {
    url:  "https://huggingface.co/cross-encoder/ms-marco-MiniLM-L-6-v2/resolve/main/onnx/model.onnx",
    dest: "cross-encoder.onnx",
    size: "~23 MB",
  },
  {
    url:  "https://huggingface.co/cross-encoder/ms-marco-MiniLM-L-6-v2/resolve/main/vocab.txt",
    dest: "vocab.json",      // we convert txt → json map below
    size: "~226 KB",
    convert: true,
  },
];

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  await pipeline(res.body, createWriteStream(dest));
}

async function convertVocabTxtToJson(txtPath, jsonPath) {
  const { readFileSync, writeFileSync } = await import("fs");
  const lines = readFileSync(txtPath, "utf-8").split("\n");
  const vocab = {};
  lines.forEach((tok, i) => {
    const t = tok.trim();
    if (t) vocab[t] = i;
  });
  writeFileSync(jsonPath, JSON.stringify(vocab));
  const { unlinkSync } = await import("fs");
  unlinkSync(txtPath);
}

if (!existsSync(MODELS_DIR)) mkdirSync(MODELS_DIR, { recursive: true });

for (const f of FILES) {
  const dest = join(MODELS_DIR, f.dest);
  const tmpDest = f.convert ? dest.replace(".json", ".txt") : dest;

  if (existsSync(dest)) {
    console.log(`✓ ${f.dest} already exists — skipping`);
    continue;
  }

  process.stdout.write(`Downloading ${f.dest} (${f.size})... `);
  await download(f.url, tmpDest);

  if (f.convert) {
    await convertVocabTxtToJson(tmpDest, dest);
  }

  console.log("done");
}

console.log("\n✅ Reranker model ready. Enable with: { rerank: true } in search options.");
