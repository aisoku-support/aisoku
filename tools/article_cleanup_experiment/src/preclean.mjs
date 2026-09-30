import { inspect } from './cleaner.mjs';

// Readability前は、関連記事系の小さな独立コンテナだけを対象にする。
export function preClean(root) {
  const removed = [];
  const candidates = [...root.querySelectorAll('div,section,aside,article,ul,ol,nav')];
  candidates.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
  for (const el of candidates) {
    if (!el.isConnected || el.closest('[data-preclean-removed]')) continue;
    const x = inspect(el);
    const hasRelatedHeading = x.heading && !el.querySelector('form');
    const smallIndependent = x.chars > 0 && x.chars <= 500 && x.links >= 2 && x.linkDensity >= .35 && x.naturalLong === 0;
    const hasLongProse = x.naturalLong > 0 || x.chars > 500;
    // sponsoredは既存safeルールをpost-cleanとの比較対象にするためpreでは扱わない。
    if (hasRelatedHeading && smallIndependent && !hasLongProse && x.score >= 7) {
      const parentDepth = (() => { let n = 0, p = el.parentElement; while (p && p !== root) { n++; p = p.parentElement; } return n; })();
      removed.push({ removed_at: 'pre', tag: el.tagName.toLowerCase(), text_preview: x.text.slice(0, 160), chars: x.chars, links: x.links, link_density: Number(x.linkDensity.toFixed(3)), score: x.score, reasons: [...x.reasons, 'small_independent_container'], ancestor_depth: parentDepth, natural_prose_chars: x.naturalLong, child_count: el.children.length });
      el.setAttribute('data-preclean-removed', 'true'); el.remove();
    }
  }
  return removed;
}
