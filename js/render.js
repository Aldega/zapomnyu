// Отрисовка карточек по шаблонам колоды: поля, условия, cloze, type-in, звук, медиа
const Render = (() => {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function stripHtml(html) {
    // DOMParser не загружает картинки, в отличие от innerHTML
    const d = new DOMParser().parseFromString(String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<div>/gi, ' '), 'text/html');
    return (d.body.textContent || '').replace(/\u00a0/g, ' ').trim();
  }
  const isEmpty = v => !v || !/\S/.test(String(v).replace(/<(?!img|audio|video)[^>]*>/gi, '').replace(/&nbsp;/g, ' '));

  // --- разбор шаблона в дерево ---
  function parse(tpl) {
    const re = /\{\{([\s\S]*?)\}\}/g;
    const root = { children: [] };
    const stack = [root];
    let last = 0, m;
    while ((m = re.exec(tpl))) {
      if (m.index > last) stack[stack.length - 1].children.push({ t: 'text', v: tpl.slice(last, m.index) });
      last = re.lastIndex;
      const tag = m[1].trim();
      if (tag.startsWith('#') || tag.startsWith('^')) {
        const node = { t: tag[0] === '#' ? 'if' : 'unless', key: tag.slice(1).trim(), children: [] };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
      } else if (tag.startsWith('/')) {
        const key = tag.slice(1).trim();
        // закрываем ближайшую подходящую секцию
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].key === key) { stack.length = i; break; }
        }
      } else if (tag.startsWith('!')) {
        // комментарий
      } else {
        stack[stack.length - 1].children.push({ t: 'field', v: tag });
      }
    }
    if (last < tpl.length) stack[stack.length - 1].children.push({ t: 'text', v: tpl.slice(last) });
    return root;
  }

  // --- cloze ---
  const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
  function clozeNumbers(text) {
    const s = new Set(); let m;
    const re = new RegExp(CLOZE_RE.source, 'g');
    while ((m = re.exec(text))) s.add(parseInt(m[1], 10));
    return [...s].sort((a, b) => a - b);
  }
  function renderCloze(text, n, side) {
    // несколько проходов — для вложенных cloze
    let out = String(text), prev;
    let guard = 0;
    do {
      prev = out;
      out = out.replace(new RegExp(CLOZE_RE.source, 'g'), (all, num, body, hint) => {
        if (/\{\{c\d+::/.test(body)) return all; // сначала внутренние
        if (parseInt(num, 10) === n) {
          if (side === 'q') return `<span class="cloze" data-cloze="${esc(body)}">[${hint ? esc(hint) : '...'}]</span>`;
          return `<span class="cloze">${body}</span>`;
        }
        return `<span class="cloze-inactive">${body}</span>`;
      });
    } while (out !== prev && ++guard < 10);
    return out;
  }
  function clozeOnly(text, n) {
    const res = []; let m;
    const re = new RegExp(CLOZE_RE.source, 'g');
    while ((m = re.exec(text))) if (parseInt(m[1], 10) === n) res.push(m[2]);
    return res.join(', ');
  }

  // --- фуригана ---
  const FURI_RE = / ?([^ >]+?)\[(.+?)\]/g;
  const furigana = t => String(t).replace(FURI_RE, (a, base, read) => read.startsWith('sound:') ? a : `<ruby><rb>${base}</rb><rt>${read}</rt></ruby>`);
  const kana = t => String(t).replace(FURI_RE, (a, base, read) => read.startsWith('sound:') ? a : read);
  const kanji = t => String(t).replace(FURI_RE, (a, base, read) => read.startsWith('sound:') ? a : base);

  // ctx: { fields: {name: value}, side: 'q'|'a', ord, kind, typed, frontHtml, tags, deck, cardName }
  function applyFilters(filters, name, ctx) {
    let value;
    const special = { FrontSide: ctx.frontHtml || '', Tags: ctx.tags || '', Deck: ctx.deck || '', Subdeck: (ctx.deck || '').split('::').pop(), Card: ctx.cardName || '', Type: ctx.typeName || '', CardFlag: '' };
    if (name in ctx.fields) value = ctx.fields[name];
    else if (name in special) value = special[name];
    else value = '';
    if (name === 'FrontSide' && !filters.length) return value;
    const fl = filters.map(f => f.trim());
    if (fl.includes('type')) {
      const expected = fl.includes('cloze') ? stripHtml(clozeOnly(value, ctx.ord + 1)) : stripHtml(value);
      return typeField(expected, ctx);
    }

    for (let i = filters.length - 1; i >= 0; i--) {
      const f = filters[i].trim();
      if (f === 'text') value = esc(stripHtml(value));
      else if (f === 'cloze') value = renderCloze(value, ctx.ord + 1, ctx.side);
      else if (f === 'cloze-only') value = clozeOnly(value, ctx.ord + 1);
      else if (f === 'furigana') value = furigana(value);
      else if (f === 'kana') value = kana(value);
      else if (f === 'kanji') value = kanji(value);
      else if (f === 'hint') {
        if (isEmpty(value)) return '';
        value = `<a class="hint" href="#">Подсказка: ${esc(name)}</a><div class="hint-body" hidden>${value}</div>`;
      } else if (f.startsWith('tts')) {
        // озвучка движком системы не поддерживается — показываем текст
      }
    }
    return value;
  }

  function typeField(expected, ctx) {
    if (ctx.side === 'q') return ctx.inFront ? '' : '<input id="typeans" class="typeans" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Введите ответ">';
    return compareTyped(ctx.typed || '', expected);
  }

  function compareTyped(typed, expected) {
    typed = typed.trim(); expected = expected.trim();
    if (!typed) return `<div class="typecmp"><span class="typemiss">${esc(expected)}</span></div>`;
    if (typed === expected) return `<div class="typecmp"><span class="typegood">${esc(typed)}</span></div>`;
    // посимвольное сравнение по LCS
    const a = [...typed], b = [...expected];
    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0, top = '', bottom = '';
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { top += `<span class="typegood">${esc(a[i])}</span>`; bottom += `<span class="typegood">${esc(b[j])}</span>`; i++; j++; }
      else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) { bottom += `<span class="typemiss">${esc(b[j])}</span>`; j++; }
      else { top += `<span class="typebad">${esc(a[i])}</span>`; i++; }
    }
    return `<div class="typecmp">${top}<br><span class="typearrow">↓</span><br>${bottom}</div>`;
  }

  function walk(node, ctx) {
    let out = '';
    for (const ch of node.children) {
      if (ch.t === 'text') out += ch.v;
      else if (ch.t === 'field') {
        const parts = ch.v.split(':');
        const name = parts.pop().trim();
        out += applyFilters(parts, name, ctx);
      } else {
        let v = ctx.fields[ch.key];
        if (v === undefined && ch.key === 'Tags') v = ctx.tags;
        const empty = isEmpty(v);
        if ((ch.t === 'if' && !empty) || (ch.t === 'unless' && empty)) out += walk(ch, ctx);
      }
    }
    return out;
  }

  function sounds(html, front) {
    return html.replace(/\[sound:([^\]]+)\]/g, (a, name) => `<button class="snd" data-sound="${esc(name)}"${front ? ' data-front="1"' : ''} aria-label="Воспроизвести">▶</button>`);
  }

  const cache = new Map();
  function renderTemplate(tpl, ctx) { if (!cache.has(tpl)) cache.set(tpl, parse(tpl)); return walk(cache.get(tpl), ctx); }

  // Возвращает { q, a } для карточки
  function renderCard({ note, nt, card, deckName, typed }) {
    const fields = {};
    nt.fields.forEach((f, i) => { fields[f] = note.flds[i] ?? ''; });
    const cloze = nt.kind === 1;
    const tmpl = cloze ? nt.tmpls[0] : (nt.tmpls[card.ord] || nt.tmpls[0]);
    const base = { fields, ord: card.ord, tags: (note.tags || []).join(' '), deck: deckName, cardName: tmpl.name, typeName: nt.name };
    const qRaw = renderTemplate(tmpl.qfmt, { ...base, side: 'q' });
    const frontForBack = renderTemplate(tmpl.qfmt, { ...base, side: 'q', inFront: true });
    const aRaw = renderTemplate(tmpl.afmt, { ...base, side: 'a', typed, frontHtml: sounds(frontForBack, true) });
    return { q: sounds(qRaw, false), a: sounds(aRaw, false), empty: !stripHtml(qRaw) && !/<img|\[sound:/i.test(qRaw) };
  }

  // --- медиа ---
  const urls = new Map();
  async function mediaUrl(name) {
    if (!name) return null;
    if (urls.has(name)) return urls.get(name);
    let rec = await DB.get('media', name);
    if (!rec) { try { const d = decodeURIComponent(name); if (d !== name) rec = await DB.get('media', d); } catch (_) {} }
    const u = rec ? URL.createObjectURL(rec.blob) : null;
    urls.set(name, u);
    return u;
  }
  const isLocal = s => s && !/^(https?:|data:|blob:|\/\/)/i.test(s);

  async function resolveMedia(root) {
    const jobs = [];
    root.querySelectorAll('img[src], audio[src], video[src], source[src]').forEach(el => {
      const src = el.getAttribute('src');
      if (isLocal(src)) jobs.push(mediaUrl(src).then(u => { if (u) el.setAttribute('src', u); }));
    });
    await Promise.all(jobs);
  }

  async function resolveCss(css) {
    const names = new Set(); let m;
    const re = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
    while ((m = re.exec(css))) if (isLocal(m[1])) names.add(m[1]);
    for (const n of names) {
      const u = await mediaUrl(n);
      if (u) css = css.split(n).join(u);
    }
    return css;
  }

  return { renderCard, resolveMedia, resolveCss, mediaUrl, clozeNumbers, stripHtml, esc, compareTyped };
})();
