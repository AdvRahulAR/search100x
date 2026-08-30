import { SYNONYMS } from "./transformer.js";

const QUESTION_WORDS = new Set(["what", "how", "why", "who", "where", "when", "which", "are", "is", "do", "does", "can", "should"]);

// ── Legal & Institutional Entity Chunker ───────────────────────────────────────

const LEGAL_STATUTE_PATTERNS = [
  /\b([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)*\s+(?:Act|Code|Bill|Rules|Regulation|Regulations|Order))\b/gi,
  /\b(Section\s+\d+[A-Za-z]*)\b/gi,
  /\b(Article\s+\d+[A-Za-z]*)\b/gi,
  /\b(BNS|IPC|CrPC|CPC|IT Act|GDPR|HIPAA|CCPA|SEBI|RBI|NCLT|NCLAT)\b/gi,
  /\b(Supreme Court|High Court|Tribunal)\b/gi,
];

/** Indian law transition synonyms — old acts ↔ new acts */
const LEGAL_SYNONYMS: Record<string, string[]> = {
  "ipc":          ["bharatiya nyaya sanhita", "bns"],
  "bns":          ["indian penal code", "ipc"],
  "crpc":         ["bharatiya nagarik suraksha sanhita", "bnss"],
  "bnss":         ["code of criminal procedure", "crpc"],
  "evidence act": ["bharatiya sakshya adhiniyam", "bsa"],
  "bsa":          ["indian evidence act", "evidence act"],
  "sec":          ["section"],
  "section":      ["sec"],
};

/**
 * Extracts high-signal legal instruments and institutional entities from a query.
 */
export function extractKeyEntities(query: string): string[] {
  const entities: string[] = [];
  for (const pat of LEGAL_STATUTE_PATTERNS) {
    const matches = query.match(pat);
    if (matches) {
      for (const m of matches) {
        if (!entities.some(e => e.toLowerCase() === m.toLowerCase())) {
          entities.push(m.trim());
        }
      }
    }
  }
  return entities;
}

/**
 * Generates arithmetic reformulations of the query:
 * 1. Keyword form: if query is a question, strip to keywords
 * 2. Question form: if query is declarative, convert to question
 * 3. Quoted entity form: for long queries (>= 6 words), extract core legal entities
 * 4. Expanded form: substitute key terms via SYNONYMS map
 */
export function reformulateQuery(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const lower = trimmed.toLowerCase();
  const words = lower.split(/\s+/);
  const results = [trimmed];

  const isQuestion = words.length > 0 && (QUESTION_WORDS.has(words[0]) || trimmed.endsWith("?"));

  // 1. Keyword form (if query is a question)
  if (isQuestion) {
    const cleanWords = trimmed
      .replace(/\?$/, "")
      .split(/\s+/)
      .filter(w => !QUESTION_WORDS.has(w.toLowerCase()));
    if (cleanWords.length > 0) {
      results.push(cleanWords.join(" "));
    }
  } 
  // 2. Question form (if query is declarative and concise)
  else if (words.length > 0 && words.length <= 5) {
    const isPlural = words[words.length - 1].endsWith("s");
    const prefix = isPlural ? "What are" : "What is a";
    results.push(`${prefix} ${trimmed}?`);
  }

  // 3. Quoted entity chunking for long/complex legal queries
  if (words.length >= 6) {
    const entities = extractKeyEntities(trimmed);
    if (entities.length > 0) {
      const quotedEntities = entities.map(e => `"${e}"`).join(" ");
      // Remove entities from remainder to get keywords
      let remainder = trimmed;
      for (const e of entities) {
        const escaped = e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        remainder = remainder.replace(new RegExp(escaped, "gi"), " ");
      }
      const coreKeywords = remainder
        .replace(/[^a-zA-Z0-9\s]/g, "")
        .split(/\s+/)
        .filter(w => w.length > 3 && !QUESTION_WORDS.has(w.toLowerCase()))
        .slice(0, 3)
        .join(" ");

      const keyphraseQuery = `${quotedEntities} ${coreKeywords}`.trim();
      if (keyphraseQuery && keyphraseQuery !== trimmed) {
        results.push(keyphraseQuery);
      }
    }
  }

  // 3.5 Legal synonym expansion
  for (const [term, alts] of Object.entries(LEGAL_SYNONYMS)) {
    const termRegex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (termRegex.test(lower) && alts.length > 0) {
      const expanded = trimmed.replace(termRegex, alts[0]);
      if (expanded !== trimmed && !results.includes(expanded)) {
        results.push(expanded);
      }
      break; // Only one legal synonym expansion per query
    }
  }

  // 4. Expanded form (if a synonym exists)
  for (const [term, alts] of Object.entries(SYNONYMS)) {
    if (lower.includes(term) && alts.length > 0) {
      const regex = new RegExp(`\\b${term}\\b`, "i");
      if (regex.test(trimmed)) {
        results.push(trimmed.replace(regex, alts[0]));
        break;
      }
    }
  }

  return [...new Set(results)].slice(0, 4);
}
