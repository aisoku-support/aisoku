const jp = (value: number[]) => String.fromCodePoint(...value);
export const TOPIC_CATEGORIES = [
  jp([0x30c8, 0x30ec, 0x30f3, 0x30c9]),
  jp([0x30a8, 0x30f3, 0x30bf, 0x30e1]),
  jp([0x30b5, 0x30d6, 0x30ab, 0x30eb]),
  jp([0x30de, 0x30cd, 0x30fc]),
  `IT${jp([0x30fb])}${jp([0x30ac, 0x30b8, 0x30a7, 0x30c3, 0x30c8])}`,
  jp([0x9664, 0x5916]),
] as const;
export type TopicCategory = typeof TOPIC_CATEGORIES[number];
export type GemmaResult = {
  article_id: string;
  subject: string;
  event: string;
  category: TopicCategory;
  topic_text: string;
  facts?: string[];
  thread_title?: string | null;
};
export type GemmaStage1Result = Omit<GemmaResult, "facts" | "topic_text">;
export type ParseFailure = { articleId: string; errorType: string; reason?: string };
export type GemmaParseResult = {
  results: GemmaResult[];
  failures: ParseFailure[];
};

export type GemmaFactsResult = { article_id: string; facts: string[] };
const trailingIdentifier = /[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+$/;

export type RepetitionFailureReason =
  | "repeated_substring"
  | "repeated_structure"
  | "dominant_phrase"
  | "tail_repetition"
  | "low_diversity";

const repeatedSubstring = (value: string): RepetitionFailureReason | null => {
  const compact = value.replace(/\s+/g, "");
  if (compact.length < 12) return null;
  const maxUnit = Math.min(64, Math.floor(compact.length / 6));

  // Search every offset: Gemma often emits valid-looking text before the loop.
  for (let start = 0; start < compact.length; start++) {
    for (let unitLength = 1; unitLength <= maxUnit; unitLength++) {
      const unit = compact.slice(start, start + unitLength);
      if (unit.length !== unitLength) continue;
      if (/^a+$/.test(unit)) continue;
      let repetitions = 1;
      while (compact.startsWith(unit, start + repetitions * unitLength)) repetitions++;
      const covered = repetitions * unitLength;
      if (repetitions >= 6 && covered >= 12 && covered / compact.length >= 0.45) {
        return unitLength <= 8 ? "repeated_structure" : "repeated_substring";
      }
    }
  }

  const tail = compact.slice(-280);
  if (tail.length >= 24) {
    const tailResult = repeatedSubstringInRegion(tail);
    if (tailResult && tailResult.covered / tail.length >= 0.6) return "tail_repetition";
  }

  if (compact.length >= 48) {
    if (/^a+$/.test(compact)) return null;
    const frequencies = new Map<string, number>();
    for (const char of compact) frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
    const maxFrequency = Math.max(...frequencies.values());
    const bigrams = new Set(Array.from({ length: compact.length - 1 }, (_, i) => compact.slice(i, i + 2)));
    if (frequencies.size <= 4 && maxFrequency / compact.length >= 0.7 && bigrams.size <= 8) {
      return "low_diversity";
    }
  }
  return null;
};

const repeatedSubstringInRegion = (value: string): { covered: number } | null => {
  for (let start = 0; start < value.length; start++) {
    for (let unitLength = 1; unitLength <= Math.min(64, Math.floor(value.length / 6)); unitLength++) {
      const unit = value.slice(start, start + unitLength);
      if (/^a+$/.test(unit)) continue;
      let repetitions = 1;
      while (unit.length === unitLength && value.startsWith(unit, start + repetitions * unitLength)) repetitions++;
      if (repetitions >= 6) return { covered: repetitions * unitLength };
    }
  }
  return null;
};

export function detectGemmaRepetition(value: string): RepetitionFailureReason | null {
  return repeatedSubstring(value);
}

export function parseGemmaStage1Response(text: string, inputIds: string[]) {
  const parsed = parseGemmaResponse(text, inputIds, true);
  return {
    results: parsed.results.map(({ facts: _facts, topic_text: _topic, ...result }) => ({ ...result, topic_text: `${result.subject} | ${result.event}`, facts: [] })),
    failures: parsed.failures,
  } satisfies { results: GemmaStage1Result[]; failures: ParseFailure[] };
}

export function parseGemmaFactsResponse(text: string, inputIds: string[]) {
  // Stage 2 is one article per request. Gemma returns one plain-text fact per line.
  if (inputIds.length !== 1) {
    return {
      results: [],
      failures: inputIds.map((articleId) => ({
        articleId,
        errorType: "invalid_facts_batch_size",
      })),
    };
  }

  const normalized = text.trim();
  const responseRepetition = detectGemmaRepetition(normalized);
  if (responseRepetition) {
    return {
      results: [],
      failures: [{
        articleId: inputIds[0],
        errorType: "repetition_loop",
        reason: responseRepetition,
      }],
    };
  }

  const facts = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const repetition = facts.map((fact) => detectGemmaRepetition(fact)).find(Boolean);
  if (repetition) {
    return {
      results: [],
      failures: [{
        articleId: inputIds[0],
        errorType: "repetition_loop",
        reason: repetition,
      }],
    };
  }

  return {
    results: [{ article_id: inputIds[0], facts }],
    failures: [],
  };
}

export function normalizeThreadTitle(
  value: unknown,
  sourceTitle: string,
  sourceDescription: string | null,
): string | null {
  if (typeof value !== "string") return null;
  let title = value.trim();
  if (!title) return null;
  const suffix = title.match(trailingIdentifier)?.[0];
  if (
    suffix && !`${sourceTitle}\n${sourceDescription ?? ""}`.includes(suffix)
  ) title = title.slice(0, -suffix.length).trimEnd();
  return title && Array.from(title).length <= 47 ? title : null;
}
export function parseGemmaResponse(
  text: string,
  inputIds: string[],
  allowMissingFacts = false,
): GemmaParseResult {
  let value: unknown;
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(
    /\s*```$/,
    "",
  ).trim();
  try {
    value = JSON.parse(normalized);
  } catch {
    const responseRepetition = detectGemmaRepetition(normalized);
    if (responseRepetition) {
      return {
        results: [],
        failures: inputIds.map((articleId) => ({
          articleId,
          errorType: "repetition_loop",
          reason: responseRepetition,
        })),
      };
    }
    return {
      results: [],
      failures: inputIds.map((articleId) => ({
        articleId,
        errorType: "invalid_json",
      })),
    };
  }
  const rows: any[] | null = Array.isArray(value)
    ? value
    : (value && typeof value === "object" &&
        Array.isArray((value as any).articles)
      ? (value as any).articles
      : null);
  if (!rows) {
    return {
      results: [],
      failures: inputIds.map((articleId) => ({
        articleId,
        errorType: "invalid_json",
      })),
    };
  }
  const counts = new Map<number, number>();
  const results: GemmaResult[] = [];
  const failures: ParseFailure[] = [];
  for (const r of rows) {
    const index = Number.isInteger(r?.index) ? r.index : -1;
    if (index < 0 || index >= inputIds.length) {
      failures.push({
        articleId: `index:${index}`,
        errorType: "index_out_of_range",
      });
      continue;
    }
    const id = inputIds[index];
    counts.set(index, (counts.get(index) ?? 0) + 1);
    if (counts.get(index)! > 1) continue;
    const subject = typeof r.subject === "string" ? r.subject.trim() : "";
    const event = typeof r.event === "string" ? r.event.trim() : "";
    if (!TOPIC_CATEGORIES.includes(r.category)) {
      failures.push({ articleId: id, errorType: "invalid_category" });
      continue;
    }
    if (r.category === TOPIC_CATEGORIES[5]) {
      results.push({ article_id: id, subject: "", event: "", category: r.category, topic_text: "", facts: [] });
      continue;
    }
    if (!allowMissingFacts && (!Array.isArray(r.facts) || r.facts.some((fact: unknown) => typeof fact !== "string"))) {
      failures.push({ articleId: id, errorType: "invalid_facts" });
      continue;
    }
    if (!subject || !event) {
      failures.push({
        articleId: id,
        errorType: !subject ? "empty_subject" : "empty_event",
      });
      continue;
    }
    const facts = allowMissingFacts ? [] : r.facts as string[];
    const repetition = [subject, event, ...facts].map(detectGemmaRepetition).find(Boolean);
    if (repetition) {
      failures.push({ articleId: id, errorType: "repetition_loop", reason: repetition });
      continue;
    }
    if (Array.from(subject).length > 40) {
      failures.push({ articleId: id, errorType: "subject_too_long" });
      continue;
    }
    if (Array.from(event).length > 50) {
      failures.push({ articleId: id, errorType: "event_too_long" });
      continue;
    }
    results.push({
      article_id: id,
      subject,
      event,
      category: r.category,
      topic_text: `${subject} | ${event}`,
      facts,
    });
  }
  for (let i = 0; i < inputIds.length; i++) {
    if (!counts.has(i)) {
      failures.push({
        articleId: inputIds[i],
        errorType: "missing_article_result",
      });
    } else if (counts.get(i)! > 1) {
      failures.push({
        articleId: inputIds[i],
        errorType: "duplicate_article_result",
      });
    }
  }
  const failed = new Set(failures.map((f) => f.articleId));
  return {
    results: results.filter((r) => !failed.has(r.article_id)),
    failures,
  };
}
