import { SYNONYMS } from "./transformer.js";

const QUESTION_WORDS = new Set(["what", "how", "why", "who", "where", "when", "which", "are", "is", "do", "does", "can", "should"]);

/**
 * Generates up to 2 arithmetic reformulations of the query:
 * 1. Question form: if query is declarative, convert to question ("GDPR fine" → "What is a GDPR fine?")
 * 2. Keyword form: if query is a question, strip to keywords ("What are GDPR requirements?" → "GDPR requirements")
 * 3. Expanded form: if a synonym exists (from the existing SYNONYMS map), substitute one key term
 * 
 * Returns array of [original, ...reformulations] (max 3 total).
 * Pure string arithmetic — no network, no model.
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
  // 2. Question form (if query is declarative and not extremely long)
  else if (words.length > 0 && words.length <= 5) {
    const isPlural = words[words.length - 1].endsWith("s");
    const prefix = isPlural ? "What are" : "What is a";
    results.push(`${prefix} ${trimmed}?`);
  }

  // 3. Expanded form (if a synonym exists)
  for (const [term, alts] of Object.entries(SYNONYMS)) {
    if (lower.includes(term) && alts.length > 0) {
      const regex = new RegExp(`\\b${term}\\b`, "i");
      if (regex.test(trimmed)) {
        results.push(trimmed.replace(regex, alts[0]));
        break; // only do one replacement to keep size <= 3
      }
    }
  }

  return [...new Set(results)].slice(0, 3);
}
