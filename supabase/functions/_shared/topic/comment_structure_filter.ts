export type CommentStructureDetection = {
  excluded: boolean;
  postCandidates: number;
  repeatedHeaders: number;
};

const POST_NUMBER_PATTERN = /(?:^|[^\d])(\d{1,3})\s*[:\uFF1A](?!\s*\d)\s*/gu;
const HEADER_WINDOW_CHARS = 130;

/** Detect a repeated numbered-post header pattern without interpreting body meaning. */
export function detectCommentDominatedBody(
  body: unknown,
): CommentStructureDetection {
  const empty = { excluded: false, postCandidates: 0, repeatedHeaders: 0 };
  if (typeof body !== "string" || body.length === 0) return empty;

  try {
    const candidates = [...body.matchAll(POST_NUMBER_PATTERN)];
    let repeatedHeaders = 0;
    for (let index = 0; index < candidates.length; index++) {
      const current = candidates[index];
      const start = current.index! + current[0].length;
      const end = candidates[index + 1]?.index ?? body.length;
      const header = body.slice(
        start,
        Math.min(end, start + HEADER_WINDOW_CHARS),
      );
      const hasMultipleSeparators =
        (header.match(/[:\uFF1A]/gu)?.length ?? 0) >= 2;
      const hasDate =
        /(?:\b\d{4}[./-]\d{1,2}(?:[./-]\d{1,2})?|\d{1,2}月\d{1,2}日|\b\d{1,2}:\d{2}(?::\d{2})?)/u
          .test(header);
      const hasId = /(?:\bID\s*[:\uFF1A]\s*|\b[A-Za-z0-9+/_-]{8,}\b)/iu.test(
        header,
      );
      const signals = Number(hasMultipleSeparators) + Number(hasDate) +
        Number(hasId);
      if (signals >= 2) repeatedHeaders++;
    }

    const postCandidates = candidates.length;
    return {
      excluded: repeatedHeaders >= 5 &&
        repeatedHeaders / postCandidates >= 0.5,
      postCandidates,
      repeatedHeaders,
    };
  } catch {
    // Fail open: malformed input or an unexpected parsing failure follows the usual flow.
    return empty;
  }
}
