// Allow-list sanitizer for rendered Markdown. Notes are written by agents that read the open web, so their HTML is untrusted.
// Works with the browser's DOMPurify global and, in tests, with a DOMPurify instance bound to a jsdom window.
const TAGS = ['a', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'del', 's', 'u', 'mark', 'sub', 'sup', 'small',
  'blockquote', 'code', 'pre', 'kbd', 'ul', 'ol', 'li', 'input', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'span', 'div', 'details', 'summary'];
const ATTRS = ['href', 'title', 'src', 'alt', 'class', 'align', 'colspan', 'rowspan', 'start', 'type', 'checked', 'disabled', 'open', 'width', 'height', 'data-missing'];
// Only classes the app itself emits (wiki links, inline fields) or marked emits for code blocks; anything else could dress note content up as app UI.
const CLASS_OK = /^(?:wikilink|missing|field|fk|language-[\w+#.-]{1,30})$/;
// http(s) and mailto links, plus same-page ("#/note/…") and same-origin relative ones. No javascript:, data:, vbscript:, file:, custom schemes.
const URI_OK = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

export function createSanitizer(purify) {
  purify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName !== 'class') return;
    const kept = String(data.attrValue).split(/\s+/).filter((c) => CLASS_OK.test(c));
    if (kept.length) data.attrValue = kept.join(' '); else data.keepAttr = false;
  });
  purify.addHook('afterSanitizeAttributes', (node) => {
    const tag = node.nodeName;
    if (tag === 'INPUT') { // GFM task-list checkboxes only, never a field someone could type into
      if ((node.getAttribute('type') || '').toLowerCase() !== 'checkbox') { node.remove(); return; }
      for (const a of [...node.attributes]) if (!['type', 'checked', 'disabled'].includes(a.name)) node.removeAttribute(a.name);
      node.setAttribute('disabled', '');
    } else if (tag === 'IMG') {
      node.setAttribute('referrerpolicy', 'no-referrer');
      node.setAttribute('loading', 'lazy');
    }
  });
  const config = { ALLOWED_TAGS: TAGS, ALLOWED_ATTR: ATTRS, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, ALLOWED_URI_REGEXP: URI_OK, ALLOW_UNKNOWN_PROTOCOLS: false };
  return (html) => purify.sanitize(String(html ?? ''), config);
}
