#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(here, "index.json");
const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));

const args = process.argv.slice(2);
let max = index.retrieval?.defaultMaxRecords ?? 5;
const maxFlag = args.findIndex((arg) => arg === "--max");
if (maxFlag >= 0) {
  const parsed = Number(args[maxFlag + 1]);
  if (Number.isFinite(parsed) && parsed > 0) max = Math.floor(parsed);
  args.splice(maxFlag, 2);
}

const query = args.join(" ").trim();
if (!query) {
  console.error('Usage: node memory/query.mjs "<task query>" [--max N]');
  process.exit(2);
}

const normalize = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .toLowerCase();

const queryNorm = normalize(query);
const tokens = [...new Set(queryNorm.split(/[\s/\\:()[\]{}.,;'"\-]+/u).filter((x) => x.length >= 2))];

const weights = index.retrieval?.scoring ?? {};
const wKeyword = weights.exactKeyword ?? 6;
const wTag = weights.tag ?? 4;
const wPath = weights.relatedPath ?? 5;
const wSummary = weights.summaryToken ?? 2;
const activeBoost = weights.activeBoost ?? 3;
const priorityDivisor = weights.priorityDivisor ?? 25;

function phraseHits(values, weight) {
  let score = 0;
  const hits = [];
  for (const raw of values ?? []) {
    const value = normalize(raw);
    if (!value) continue;
    if (queryNorm.includes(value)) {
      score += weight;
      hits.push(raw);
      continue;
    }
    for (const token of tokens) {
      if (value.includes(token) || token.includes(value)) {
        score += Math.max(1, Math.floor(weight / 2));
        hits.push(raw);
        break;
      }
    }
  }
  return { score, hits };
}

const ranked = index.records.map((record) => {
  let score = 0;
  const reasons = [];

  for (const [values, weight, label] of [
    [record.keywords, wKeyword, "keyword"],
    [record.tags, wTag, "tag"],
    [record.relatedPaths, wPath, "path"]
  ]) {
    const hit = phraseHits(values, weight);
    score += hit.score;
    if (hit.hits.length) reasons.push(`${label}: ${[...new Set(hit.hits)].slice(0, 5).join(", ")}`);
  }

  const summary = normalize(record.summary);
  const summaryHits = tokens.filter((token) => summary.includes(token));
  score += summaryHits.length * wSummary;
  if (summaryHits.length) reasons.push(`summary: ${summaryHits.slice(0, 5).join(", ")}`);

  if (record.status === "active") score += activeBoost;
  score += Number(record.priority ?? 0) / priorityDivisor;

  return { ...record, score, reasons };
})
  .filter((record) => record.score > 0)
  .sort((a, b) => b.score - a.score || b.priority - a.priority || a.id.localeCompare(b.id))
  .slice(0, max);

console.log(JSON.stringify({
  query,
  max,
  matches: ranked.map(({ id, path, status, priority, summary, score, reasons }) => ({
    id,
    path,
    status,
    priority,
    summary,
    score: Number(score.toFixed(2)),
    reasons
  }))
}, null, 2));
