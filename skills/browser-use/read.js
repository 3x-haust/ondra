// browse read: the page's main content as markdown, without menus, ads, footers or
// icons. Run in the page by `browse read`; __OPTS__ is replaced with its options.
(() => {
  const o = __OPTS__;
  const SKIP_TAG = /^(SCRIPT|STYLE|LINK|NOSCRIPT|TEMPLATE|SVG|IMG|PICTURE|VIDEO|AUDIO|IFRAME|CANVAS|OBJECT|EMBED|BUTTON|INPUT|SELECT|TEXTAREA|DIALOG|NAV|ASIDE|MENU)$/;
  const SKIP_ROLE = /^(navigation|banner|contentinfo|complementary|search|dialog|alertdialog|menu|menubar|toolbar|tablist)$/;
  const NOISE = /(^|[\s_-])(share|sharing|social|related|recommend|promo|advert|ads?|sponsor|newsletter|subscribe|cookie|consent|breadcrumbs?|comments?|sidebar|popup|modal|toc|skip|paywall|byline-share)([\s_-]|$)/i;
  const BLOCK = /^(P|DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|UL|OL|LI|H[1-6]|PRE|BLOCKQUOTE|TABLE|TR|DL|DT|DD|FIGURE|FIGCAPTION|HR|BR|DETAILS|SUMMARY|ADDRESS)$/;

  const textLen = (el) => (el.textContent || "").replace(/\s+/g, " ").length;
  const pick = () => {
    if (o.sel) return document.querySelector(o.sel);
    const cands = [...document.querySelectorAll("article, main, [role=main], [itemprop=articleBody], #content, #main, .post-content, .entry-content, .article-body, .markdown-body")];
    if (!cands.length) return document.body;
    const best = Math.max(...cands.map(textLen));
    // the innermost candidate that still holds most of the text
    const ok = cands.filter((c) => textLen(c) >= best * 0.6);
    return ok.find((c) => !ok.some((d) => d !== c && c.contains(d))) || ok[0];
  };
  const root = pick();
  if (!root) return `nothing matches ${o.sel}`;

  const hidden = (el) => {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return true;
    return false;
  };
  const skip = (el) => {
    if (el === root) return false;
    if (SKIP_TAG.test(el.tagName.toUpperCase())) return true;
    const role = el.getAttribute("role");
    if (role && SKIP_ROLE.test(role)) return true;
    const tag = el.tagName;
    // page-level header/footer; an article's own header (its title) stays
    if ((tag === "HEADER" && !el.querySelector("h1,h2")) || tag === "FOOTER") return true;
    const id = `${el.id} ${typeof el.className === "string" ? el.className : ""}`;
    if (id.trim() && NOISE.test(id) && textLen(el) < 600) return true;
    return hidden(el);
  };

  const out = [];
  const inline = (s) => out.push(s);
  const block = (s = "") => out.push(`\n${s}`);
  const href = (a) => {
    const h = a.getAttribute("href") || "";
    if (!h || h.startsWith("#") || h.startsWith("javascript:")) return "";
    try { return new URL(h, location.href).href; } catch { return ""; }
  };
  let listDepth = 0;

  const table = (t) => {
    const rows = [...t.querySelectorAll("tr")].slice(0, 60);
    rows.forEach((tr, i) => {
      const cells = [...tr.children].map((c) => c.innerText.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|"));
      block(`| ${cells.join(" | ")} |`);
      if (i === 0) block(`|${cells.map(() => " --- ").join("|")}|`);
    });
    if (t.querySelectorAll("tr").length > 60) block(`(… ${t.querySelectorAll("tr").length - 60} more rows)`);
    block();
  };

  const walk = (n) => {
    if (n.nodeType === 3) {
      const t = n.nodeValue.replace(/\s+/g, " ");
      if (t.trim() || (t && out.length && !/\s$/.test(out[out.length - 1]))) inline(t);
      return;
    }
    if (n.nodeType === 11) { for (const c of n.childNodes) walk(c); return; }
    if (n.nodeType !== 1 || skip(n)) return;
    const tag = n.tagName.toUpperCase();
    // web components: their shadow tree, with the page's own content where its slots are
    if (tag === "SLOT") { for (const c of n.assignedNodes({ flatten: true })) walk(c); return; }
    if (n.shadowRoot && !/^(PRE|TABLE)$/.test(tag)) { walk(n.shadowRoot); return; }
    const h = tag.match(/^H([1-6])$/);
    if (h) {
      const t = n.innerText.replace(/\s+/g, " ").trim();
      if (t) { block(); block(`${"#".repeat(+h[1])} ${t}`); block(); }
      return;
    }
    if (tag === "PRE") {
      const code = n.innerText.replace(/\n+$/, "");
      block("```"); block(code.length > 4000 ? code.slice(0, 4000) + "\n…" : code); block("```"); block();
      return;
    }
    if (tag === "TABLE") return table(n);
    if (tag === "CODE") return inline("`" + n.textContent.trim() + "`");
    if (tag === "A" && o.links) {
      const t = n.innerText.replace(/\s+/g, " ").trim();
      const u = href(n);
      return inline(t && u ? `[${t}](${u})` : t);
    }
    if (tag === "BR") return block();
    if (tag === "HR") return block("---");
    if (tag === "LI") {
      block(`${"  ".repeat(Math.max(0, listDepth - 1))}- `);
      for (const c of n.childNodes) walk(c);
      return;
    }
    if (tag === "UL" || tag === "OL") {
      listDepth++;
      for (const c of n.childNodes) walk(c);
      listDepth--;
      block();
      return;
    }
    if (tag === "BLOCKQUOTE") {
      block("> " + n.innerText.replace(/\s+/g, " ").trim());
      block();
      return;
    }
    if (tag === "DT") { block(); for (const c of n.childNodes) walk(c); inline(":"); return; }
    const isBlock = BLOCK.test(tag);
    if (isBlock && listDepth === 0) block();
    for (const c of n.childNodes) walk(c);
    if (isBlock && listDepth === 0) block();
  };
  walk(root);

  let md = out.join("").split("\n").map((l) => l.replace(/[ \t]+$/g, "").replace(/^ (?=\S)/, "")).join("\n");
  md = md.replace(/\n(-\s*\n)+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  const heads = [...md.matchAll(/^(#{1,6}) (.+)$/gm)].map((m) => ({ level: m[1].length, text: m[2], at: m.index }));
  const title = `${document.title} — ${location.href}`;
  if (o.outline) return `${title}\n${heads.map((x) => `${"  ".repeat(x.level - 1)}- ${x.text}`).join("\n") || "(no headings)"}\n(${md.length} chars; browse read --section "<heading>")`;
  if (o.section) {
    const want = o.section.toLowerCase();
    const i = heads.findIndex((x) => x.text.toLowerCase().includes(want));
    if (i < 0) return `${title}\nno heading matches "${o.section}". Headings: ${heads.map((x) => x.text).slice(0, 40).join(" | ")}`;
    const end = heads.slice(i + 1).find((x) => x.level <= heads[i].level);
    md = md.slice(heads[i].at, end ? end.at : undefined).trim();
  }
  if (md.length > o.max) {
    const cut = md.lastIndexOf("\n", o.max);
    const rest = heads.filter((x) => x.at > cut && x.level <= 3).map((x) => x.text).slice(0, 30);
    md = md.slice(0, cut > o.max / 2 ? cut : o.max) + `\n\n[… ${md.length - o.max} more chars.` + (rest.length ? ` Later sections: ${rest.join(" | ")}. browse read --section "<heading>"` : " browse read --max <n>") + "]";
  }
  return `${title}\n\n${md}`;
})()
