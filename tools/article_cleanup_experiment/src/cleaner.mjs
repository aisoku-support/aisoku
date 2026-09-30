const RELATED = /関連記事|おすすめ記事|あわせて読みたい|こちらもおすすめ/;
const CTA = /会員登録|ログイン|続きを読むには|商品を見る|購読|登録はこちら/;
const blockTags = new Set(['P','DIV','SECTION','ASIDE','ARTICLE','UL','OL','TABLE','FIGURE','FORM','H2','H3','H4']);
const prosePunct = /[。！？.!?]/g;

function stats(el) {
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  const links = [...el.querySelectorAll('a')];
  const linkText = links.map(a => a.textContent || '').join('').length;
  const chars = text.length;
  const punctuation = (text.match(prosePunct) || []).length;
  const paragraphs = [...el.querySelectorAll('p')].filter(p => p.textContent.trim().length > 0);
  const naturalLong = paragraphs.filter(p => p.textContent.trim().length >= 100 && (p.textContent.match(prosePunct) || []).length > 0).length;
  const heading = [...el.querySelectorAll('h1,h2,h3,h4,h5,h6')].some(h => RELATED.test(h.textContent || '') || CTA.test(h.textContent || ''));
  const repeatedLinks = links.length >= 3 && new Set(links.map(a => a.textContent.trim())).size <= Math.max(2, Math.ceil(links.length * .75));
  const sponsored = el.matches('[rel~="sponsored"], [role="complementary"] [rel~="sponsored"]') || !!el.querySelector('[rel~="sponsored"]');
  return { text, chars, links: links.length, linkText, linkDensity: chars ? linkText / chars : 0, punctuation, naturalLong, paragraphs: paragraphs.length, heading, repeatedLinks, sponsored };
}

function inspect(el) {
  const s = stats(el); const reasons = []; let score = 0;
  if (s.sponsored) { score += 8; reasons.push('rel_sponsored'); }
  if (s.heading) { score += 2; reasons.push('related_or_cta_heading'); }
  if (s.links >= 3) { score += 2; reasons.push('multiple_links'); }
  if (s.linkDensity >= .62) { score += 3; reasons.push('high_link_density'); }
  else if (s.linkDensity >= .35 && s.heading) { score += 2; reasons.push('heading_link_density'); }
  if (s.repeatedLinks) { score += 2; reasons.push('repeated_link_items'); }
  if (s.naturalLong === 0 && s.punctuation <= 1) { score += 2; reasons.push('little_natural_prose'); }
  if (s.chars >= 100 && s.naturalLong > 0) { score -= 6; reasons.push('long_natural_prose_protection'); }
  if (s.paragraphs >= 2 && s.naturalLong > 0) { score -= 3; reasons.push('multiple_prose_paragraphs_protection'); }
  const removable = score >= 7 && s.chars > 0 && (s.sponsored || (s.heading && s.links >= 2 && s.linkDensity >= .35 && s.naturalLong === 0));
  return { ...s, score, reasons, removable };
}

export function clean(root) {
  const removed = [];
  const candidates = [...root.querySelectorAll('*')].filter(el => blockTags.has(el.tagName));
  // 子ブロックを先に評価し、親の記事全体を sponsored/CTA の巻き添えで消さない。
  candidates.sort((a,b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
  for (const el of candidates) {
    if (!el.isConnected || el === root || el.closest('[data-cleaner-removed]')) continue;
    const x = inspect(el);
    if (x.removable) {
      removed.push({ tag: el.tagName.toLowerCase(), text_preview: x.text.slice(0, 160), chars: x.chars, links: x.links, link_density: Number(x.linkDensity.toFixed(3)), score: x.score, reasons: x.reasons });
      el.setAttribute('data-cleaner-removed','true'); el.remove();
    }
  }
  return removed;
}

export { inspect };
