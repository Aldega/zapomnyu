// Интерфейс приложения
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const view = $('#view');
  const esc = Render.esc;
  const state = { screen: 'home', study: null };

  // ---------- общие помощники ----------
  function toast(msg, ms = 2500) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
  }
  function setTitle(text, back) {
    $('#title').textContent = text;
    $('#backBtn').hidden = !back;
  }
  function sheet(html, onClick) {
    const s = $('#sheet');
    s.innerHTML = `<div class="sheet-bg"></div><div class="sheet-panel">${html}</div>`;
    s.hidden = false;
    const close = () => { s.hidden = true; s.innerHTML = ''; };
    s.querySelector('.sheet-bg').onclick = close;
    s.querySelector('.sheet-panel').addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'close') return close();
      onClick && onClick(b.dataset.act, b, close);
    });
    return close;
  }
  const confirmSheet = (text, okLabel, danger = true) => new Promise(res => {
    sheet(`<p class="sheet-text">${text}</p>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${okLabel}</button>
      <button class="btn" data-act="close">Отмена</button>`, (act, b, close) => { if (act === 'ok') { close(); res(true); } });
    $('#sheet .sheet-bg').addEventListener('click', () => res(false));
    $('#sheet [data-act=close]').addEventListener('click', () => res(false));
  });

  async function loadConf() { Sched.setConf(await DB.getMeta('conf', {})); }
  async function getDaily() {
    const t = Sched.today();
    let d = await DB.getMeta('daily', null);
    if (!d || d.day !== t) d = { day: t, newDone: {}, revDone: {}, total: 0 };
    return d;
  }

  function deckTree(decks) {
    const sorted = [...decks].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const byName = new Map(sorted.map(d => [d.name, d]));
    return sorted.map(d => {
      const parts = d.name.split('::');
      const desc = sorted.filter(x => x.name === d.name || x.name.startsWith(d.name + '::')).map(x => x.id);
      return { ...d, depth: parts.length - 1, short: parts[parts.length - 1], ids: desc, hasParent: parts.length > 1 && byName.has(parts.slice(0, -1).join('::')) };
    });
  }

  function countsFor(cards, ids, daily, deckId) {
    const set = new Set(ids);
    const now = Date.now(), conf = Sched.getConf();
    let n = 0, l = 0, r = 0;
    for (const c of cards) {
      if (!set.has(c.did) || c.suspended) continue;
      if (c.type === Sched.NEW) n++;
      else if (Sched.isDue(c, now)) (c.type === Sched.REVIEW ? r++ : l++);
    }
    n = Math.max(0, Math.min(n, conf.newPerDay - (daily.newDone[deckId] || 0)));
    r = Math.max(0, Math.min(r, conf.revPerDay - (daily.revDone[deckId] || 0)));
    return { n, l, r };
  }

  // ---------- главный экран ----------
  async function showHome() {
    state.screen = 'home'; state.study = null;
    setTitle('Запомню', false);
    const [decks, cards, daily] = await Promise.all([DB.all('decks'), DB.all('cards'), getDaily()]);
    const used = new Set(cards.map(c => c.did));
    const tree = deckTree(decks).filter(d => d.ids.some(id => used.has(id)));
    let html = installHint();
    if (!tree.length) {
      html += `<section class="empty">
        <div class="empty-icon">🗂️</div>
        <h2>Колод пока нет</h2>
        <p>Импортируйте колоду в формате <b>.apkg</b> — например, скачанную с ankiweb.net/shared или экспортированную из Anki на компьютере.</p>
        <button class="btn primary big" id="importBtn">Импортировать .apkg</button>
      </section>`;
    } else {
      html += `<ul class="decks">`;
      for (const d of tree) {
        const c = countsFor(cards, d.ids, daily, d.id);
        html += `<li class="deck" data-id="${d.id}" style="--depth:${d.depth}">
          <button class="deck-main" data-study="${d.id}"><span class="deck-name">${esc(d.short)}</span>
            <span class="counts"><span class="cn ${c.n ? '' : 'zero'}">${c.n}</span><span class="cl ${c.l ? '' : 'zero'}">${c.l}</span><span class="cr ${c.r ? '' : 'zero'}">${c.r}</span></span></button>
          <button class="deck-more icon-btn" data-more="${d.id}" aria-label="Действия">⋯</button>
        </li>`;
      }
      html += `</ul>
        <p class="legend"><span class="cn">новые</span> · <span class="cl">в изучении</span> · <span class="cr">на повторение</span></p>
        <p class="today">Сегодня повторено: <b>${daily.total || 0}</b></p>
        <button class="btn primary" id="importBtn">＋ Импортировать .apkg</button>`;
    }
    view.innerHTML = html;
    const ib = $('#importBtn'); if (ib) ib.onclick = () => $('#fileInput').click();
    view.querySelectorAll('[data-study]').forEach(b => b.onclick = () => startStudy(Number(b.dataset.study)));
    view.querySelectorAll('[data-more]').forEach(b => b.onclick = () => deckMenu(tree.find(d => d.id === Number(b.dataset.more))));
    const hb = $('#hideHint'); if (hb) hb.onclick = async () => { installHint.hidden = true; await DB.setMeta('hideHint', true); showHome(); };
  }

  function installHint() {
    const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (standalone || !ios || installHint.hidden) return '';
    return `<div class="hint-banner">Чтобы установить приложение: нажмите <b>Поделиться</b> <span class="share-ico">⬆︎</span> внизу Safari и выберите <b>«На экран „Домой“»</b>. <button class="link" id="hideHint">Скрыть</button></div>`;
  }

  function deckMenu(d) {
    sheet(`<h3 class="sheet-title">${esc(d.name)}</h3>
      <button class="btn primary" data-act="study">Учить</button>
      <button class="btn" data-act="custom">Учить всё заново сегодня (без лимитов)</button>
      <button class="btn" data-act="reset">Сбросить прогресс колоды</button>
      <button class="btn danger" data-act="delete">Удалить колоду</button>
      <button class="btn" data-act="close">Закрыть</button>`, async (act, b, close) => {
      close();
      if (act === 'study') startStudy(d.id);
      if (act === 'custom') startStudy(d.id, true);
      if (act === 'reset') {
        if (!await confirmSheet(`Сбросить прогресс «${esc(d.name)}»? Все карточки снова станут новыми.`, 'Сбросить')) return;
        const set = new Set(d.ids);
        const cards = (await DB.all('cards')).filter(c => set.has(c.did)).map(c => ({ ...c, ...Sched.newCardState(), suspended: c.suspended }));
        await DB.putMany('cards', cards); toast('Прогресс сброшен'); showHome();
      }
      if (act === 'delete') {
        if (!await confirmSheet(`Удалить колоду «${esc(d.name)}» и все её карточки?`, 'Удалить')) return;
        await deleteDecks(d.ids); toast('Колода удалена'); showHome();
      }
    });
  }

  async function deleteDecks(ids) {
    const set = new Set(ids);
    const cards = await DB.all('cards');
    const gone = cards.filter(c => set.has(c.did));
    const goneNids = new Set(gone.map(c => c.nid));
    const keepNids = new Set(cards.filter(c => !set.has(c.did)).map(c => c.nid));
    await DB.tx(['cards', 'notes', 'decks'], 'readwrite', t => {
      gone.forEach(c => t.objectStore('cards').delete(c.id));
      goneNids.forEach(n => { if (!keepNids.has(n)) t.objectStore('notes').delete(n); });
      ids.forEach(id => t.objectStore('decks').delete(id));
    });
  }

  // ---------- изучение ----------
  async function startStudy(deckId, noLimits = false) {
    const [decks, all, daily, notetypes] = await Promise.all([DB.all('decks'), DB.all('cards'), getDaily(), DB.all('notetypes')]);
    const tree = deckTree(decks);
    const deck = tree.find(d => d.id === deckId);
    if (!deck) return showHome();
    const set = new Set(deck.ids);
    const cards = all.filter(c => set.has(c.did) && !c.suspended);
    state.screen = 'study';
    state.study = {
      deck, cards, daily, noLimits, undo: [], current: null, showing: 'q', lastId: null,
      nts: new Map(notetypes.map(n => [n.id, n])),
      deckNames: new Map(decks.map(d => [d.id, d.name])),
      newLeft: noLimits ? Infinity : Math.max(0, Sched.getConf().newPerDay - (daily.newDone[deckId] || 0)),
      revLeft: noLimits ? Infinity : Math.max(0, Sched.getConf().revPerDay - (daily.revDone[deckId] || 0)),
    };
    if (noLimits) cards.forEach(c => { if (c.type === Sched.REVIEW) c.due = Math.min(c.due, Sched.today()); });
    setTitle(deck.short, true);
    nextCard();
  }

  function pickNext(st) {
    const now = Date.now(), today = Sched.today();
    const avoid = c => c.id !== st.lastId;
    const learnNow = st.cards.filter(c => (c.type === Sched.LEARN || c.type === Sched.RELEARN) && c.due <= now).sort((a, b) => a.due - b.due);
    const lnow = learnNow.find(avoid) || null;
    if (lnow) return lnow;
    const reviews = st.revLeft > 0 ? st.cards.filter(c => c.type === Sched.REVIEW && c.due <= today) : [];
    const news = st.newLeft > 0 ? st.cards.filter(c => c.type === Sched.NEW).sort((a, b) => (a.pos - b.pos) || (a.id - b.id)) : [];
    const nNew = Math.min(news.length, st.newLeft), nRev = Math.min(reviews.length, st.revLeft);
    if (nNew || nRev) {
      const takeNew = nNew && (!nRev || Math.random() < nNew / (nNew + nRev));
      if (takeNew) return news.find(avoid) || news[0];
      reviews.sort((a, b) => a.due - b.due || Math.random() - 0.5);
      return reviews.find(avoid) || reviews[0];
    }
    if (learnNow.length) return learnNow[0];
    const ahead = st.cards.filter(c => (c.type === Sched.LEARN || c.type === Sched.RELEARN) && Sched.isDue(c, now)).sort((a, b) => a.due - b.due);
    return ahead.find(avoid) || ahead[0] || null;
  }

  function studyCounts(st) {
    const now = Date.now(), today = Sched.today();
    let n = 0, l = 0, r = 0;
    for (const c of st.cards) {
      if (c.type === Sched.NEW) n++;
      else if (c.type === Sched.REVIEW) { if (c.due <= today) r++; }
      else if (Sched.isDue(c, now)) l++;
    }
    return { n: Math.min(n, st.newLeft), l, r: Math.min(r, st.revLeft) };
  }

  async function nextCard() {
    const st = state.study;
    const card = pickNext(st);
    st.current = card; st.showing = 'q'; st.typed = '';
    if (!card) return studyDone();
    await showSide();
  }

  function studyDone() {
    const st = state.study;
    const later = st.cards.filter(c => c.type === Sched.LEARN || c.type === Sched.RELEARN).sort((a, b) => a.due - b.due);
    let extra = '';
    if (later.length) {
      const mins = Math.max(1, Math.ceil((later[0].due - Date.now()) / 60000));
      extra = `<p>Ещё ${later.length} карт. в изучении — следующая через ${mins} мин.</p>`;
    }
    view.innerHTML = `<section class="empty done">
      <div class="empty-icon">🎉</div><h2>На сегодня всё!</h2>
      <p>Вы прошли все карточки, запланированные на сегодня в этой колоде.</p>${extra}
      <button class="btn primary big" id="homeBtn">К списку колод</button>
      ${st.undo.length ? '<button class="btn" id="undoBtn">Отменить последний ответ</button>' : ''}
    </section>`;
    $('#homeBtn').onclick = showHome;
    const ub = $('#undoBtn'); if (ub) ub.onclick = undo;
  }

  const baseCss = `
    :host { display:block; }
    .card { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; font-size: 20px; line-height: 1.45;
      text-align: center; color: #111; background: #fff; padding: 22px 16px; min-height: 100%; box-sizing: border-box; overflow-wrap: anywhere; }
    img { max-width: 100%; height: auto; }
    video { max-width: 100%; }
    hr#answer, hr { border: 0; border-top: 1px solid #d0d4da; margin: 16px 0; }
    .cloze { font-weight: bold; color: #2563eb; }
    .nightMode .cloze { color: #7aa7ff; }
    .snd { display:inline-flex; align-items:center; justify-content:center; width:40px; height:40px; border-radius:20px; border:0;
      background:#2563eb; color:#fff; font-size:16px; vertical-align:middle; margin:2px 4px; cursor:pointer; }
    .typeans { font: inherit; font-size: 18px; width: 100%; max-width: 420px; box-sizing: border-box; padding: 10px 12px; border: 1px solid #b8bec8; border-radius: 10px; margin-top: 12px; }
    .typecmp { font-family: ui-monospace, Menlo, monospace; font-size: 18px; margin: 8px 0; }
    .typegood { background: #c8f2cf; color: #0a4d18; } .typebad { background: #ffd0d0; color: #7a0b0b; } .typemiss { background: #e3e6ea; color: #333; }
    a.hint { color: #2563eb; }
    ruby rt { font-size: 0.55em; }
    .card.nightMode { background: #1c1f24 !important; color: #e8eaed !important; }
    .nightMode hr, .nightMode hr#answer { border-top-color: #3a3f47; }
    .nightMode .typeans { background: #2a2e35; color: #e8eaed; border-color: #444a53; }
  `;

  async function showSide() {
    const st = state.study, card = st.current;
    const note = await DB.get('notes', card.nid);
    const nt = note && st.nts.get(note.mid);
    if (!note || !nt) { st.cards = st.cards.filter(c => c !== card); return nextCard(); }
    const r = Render.renderCard({ note, nt, card, deckName: st.deckNames.get(card.did) || '', typed: st.typed });
    const cnt = studyCounts(st);
    const hl = t => `<span class="${t}">`;
    const cur = card.type === Sched.NEW ? 'cn' : card.type === Sched.REVIEW ? 'cr' : 'cl';
    const u = (k, v) => `${hl(k)}${cur === k ? `<u>${v}</u>` : v}</span>`;
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;

    view.innerHTML = `<div class="study">
      <div class="study-top"><span class="counts">${u('cn', cnt.n)}${u('cl', cnt.l)}${u('cr', cnt.r)}</span>
        <button class="link" id="undoBtn" ${st.undo.length ? '' : 'disabled'}>↶ Отменить</button></div>
      <div class="card-wrap"><div id="cardHost"></div></div>
      <div class="answer-bar" id="bar"></div>
    </div>`;
    const host = $('#cardHost');
    const root = host.attachShadow({ mode: 'open' });
    const css = await Render.resolveCss(nt.css || '');
    // шаблон не загружает картинки, пока мы не подставим локальные файлы
    const tpl = document.createElement('template');
    tpl.innerHTML = `<div class="card card${card.ord + 1}${dark ? ' nightMode night_mode' : ''}">${st.showing === 'q' ? r.q : r.a}</div>`;
    tpl.content.querySelectorAll('script').forEach(s => s.remove());
    await Render.resolveMedia(tpl.content);
    root.innerHTML = `<style>${baseCss}${css}</style>`;
    root.appendChild(tpl.content);
    root.addEventListener('click', e => {
      const s = e.target.closest('.snd');
      if (s) { e.preventDefault(); playSounds([s.dataset.sound]); return; }
      const h = e.target.closest('a.hint');
      if (h) { e.preventDefault(); const b = h.nextElementSibling; if (b) { b.hidden = false; h.remove(); } }
    });
    const typeIn = root.querySelector('#typeans');
    if (typeIn) typeIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); reveal(); } });
    $('#undoBtn').onclick = undo;

    const bar = $('#bar');
    if (st.showing === 'q') {
      bar.innerHTML = `<button class="btn primary big" id="showBtn">Показать ответ</button>`;
      $('#showBtn').onclick = reveal;
      if (!typeIn) host.onclick = (e) => { if (!e.composedPath().some(el => el.classList && (el.classList.contains('snd') || el.classList.contains('hint')))) reveal(); };
    } else {
      const labels = [['Снова', 'again'], ['Трудно', 'hard'], ['Хорошо', 'good'], ['Легко', 'easy']];
      bar.innerHTML = `<div class="ease-row">${labels.map(([l, cls], i) =>
        `<button class="ease ${cls}" data-ease="${i + 1}"><small>${Sched.preview(card, i + 1)}</small>${l}</button>`).join('')}</div>`;
      bar.querySelectorAll('[data-ease]').forEach(b => b.onclick = () => answer(Number(b.dataset.ease)));
    }
    // автоматическое воспроизведение
    const snds = [...root.querySelectorAll('.snd')].filter(b => st.showing === 'q' || !b.dataset.front).map(b => b.dataset.sound);
    if (snds.length) playSounds(snds);
    root.querySelectorAll('audio[autoplay], video[autoplay]').forEach(m => m.play().catch(() => {}));
  }

  let audio = null;
  async function playSounds(list) {
    if (audio) { audio.pause(); audio = null; }
    const token = {}; playSounds.token = token;
    for (const name of list) {
      if (playSounds.token !== token) return;
      const url = await Render.mediaUrl(name);
      if (!url) continue;
      await new Promise(res => {
        audio = new Audio(url); audio.onended = res; audio.onerror = res;
        audio.play().catch(res);
      });
    }
  }

  function reveal() {
    const st = state.study;
    if (!st || st.showing !== 'q') return;
    const host = $('#cardHost');
    const ti = host && host.shadowRoot && host.shadowRoot.querySelector('#typeans');
    st.typed = ti ? ti.value : '';
    st.showing = 'a';
    showSide();
  }

  async function answer(ease) {
    const st = state.study, card = st.current;
    if (!card || st.showing !== 'a') return;
    const before = { ...card };
    const dailyBefore = JSON.parse(JSON.stringify(st.daily));
    const leftBefore = [st.newLeft, st.revLeft];
    const next = Sched.answer(card, ease);
    Object.assign(card, next);
    const did = st.deck.id;
    if (before.type === Sched.NEW) { st.daily.newDone[did] = (st.daily.newDone[did] || 0) + 1; st.newLeft--; }
    else if (before.type === Sched.REVIEW) { st.daily.revDone[did] = (st.daily.revDone[did] || 0) + 1; st.revLeft--; }
    st.daily.total = (st.daily.total || 0) + 1;
    const { cards: _x, ...stored } = card;
    await DB.tx(['cards', 'meta', 'revlog'], 'readwrite', t => {
      t.objectStore('cards').put({ ...stored });
      t.objectStore('meta').put({ key: 'daily', value: st.daily });
      t.objectStore('revlog').put({ cid: card.id, ease, time: Date.now(), ivl: card.ivl, type: before.type });
    });
    st.undo.push({ before, dailyBefore, leftBefore });
    if (st.undo.length > 30) st.undo.shift();
    st.lastId = card.id;
    nextCard();
  }

  async function undo() {
    const st = state.study;
    if (!st || !st.undo.length) return;
    const { before, dailyBefore, leftBefore } = st.undo.pop();
    const c = st.cards.find(x => x.id === before.id);
    if (c) Object.assign(c, before);
    st.daily = dailyBefore; [st.newLeft, st.revLeft] = leftBefore;
    await DB.tx(['cards', 'meta'], 'readwrite', t => {
      t.objectStore('cards').put({ ...before });
      t.objectStore('meta').put({ key: 'daily', value: st.daily });
    });
    st.current = c || before; st.showing = 'a'; st.lastId = null;
    toast('Ответ отменён');
    showSide();
  }

  // ---------- импорт ----------
  async function doImport(file) {
    if (!file) return;
    const name = file.name || '';
    if (/\.(colpkg|apkg|zip)$/i.test(name) === false) toast('Пробую открыть файл как колоду Anki…');
    view.innerHTML = `<section class="empty"><div class="spinner"></div><h2>Импорт</h2><p id="prog">Подготовка…</p></section>`;
    setTitle('Импорт', false);
    try {
      const res = await Importer.importApkg(file, msg => { const p = $('#prog'); if (p) p.textContent = msg; });
      toast(`Готово: ${res.cards} карточек${res.added < res.cards ? ` (новых ${res.added})` : ''}, медиа: ${res.media}`, 4000);
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } catch (e) {
      console.error(e);
      view.innerHTML = `<section class="empty"><div class="empty-icon">⚠️</div><h2>Не получилось импортировать</h2><p>${esc(e.message || e)}</p><button class="btn primary" id="homeBtn">Назад</button></section>`;
      $('#homeBtn').onclick = showHome;
      return;
    }
    showHome();
  }

  // ---------- резервная копия ----------
  async function exportBackup() {
    toast('Готовлю резервную копию…', 10000);
    const zip = new JSZip();
    const data = {};
    for (const s of ['notetypes', 'decks', 'notes', 'cards', 'meta', 'revlog']) data[s] = await DB.all(s);
    zip.file('data.json', JSON.stringify({ app: 'zapomnyu', version: 1, created: Date.now(), data }));
    const media = await DB.all('media');
    const index = {};
    media.forEach((m, i) => { index[i] = m.name; zip.file('media/' + i, m.blob); });
    zip.file('media.json', JSON.stringify(index));
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const d = new Date();
    const fname = `zapomnyu-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.zip`;
    const file = new File([blob], fname, { type: 'application/zip' });
    $('#toast').hidden = true;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: fname }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = fname; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  }

  async function importBackup(file) {
    if (!file) return;
    if (!await confirmSheet('Восстановить из копии? Текущие колоды и прогресс будут заменены данными из файла.', 'Восстановить')) return;
    try {
      toast('Восстанавливаю…', 20000);
      const zip = await JSZip.loadAsync(file);
      const j = JSON.parse(await zip.file('data.json').async('string'));
      if (j.app !== 'zapomnyu') throw new Error('Это не резервная копия этого приложения');
      await DB.clearAll();
      for (const [s, rows] of Object.entries(j.data)) await DB.putMany(s, rows);
      const index = JSON.parse(await zip.file('media.json').async('string'));
      const recs = [];
      for (const [i, name] of Object.entries(index)) {
        const f = zip.file('media/' + i); if (!f) continue;
        const u8 = await f.async('uint8array');
        recs.push({ name, blob: new Blob([u8]) });
        if (recs.length >= 50) await DB.putMany('media', recs.splice(0));
      }
      await DB.putMany('media', recs);
      await loadConf();
      toast('Данные восстановлены');
    } catch (e) { toast('Ошибка: ' + (e.message || e), 5000); }
    showHome();
  }

  // ---------- настройки ----------
  function settings() {
    const c = Sched.getConf();
    const close = sheet(`<h3 class="sheet-title">Настройки</h3>
      <label class="field">Новых карточек в день<input type="number" inputmode="numeric" id="sNew" value="${c.newPerDay}" min="0"></label>
      <label class="field">Повторений в день<input type="number" inputmode="numeric" id="sRev" value="${c.revPerDay}" min="0"></label>
      <label class="field">Шаги изучения, мин<input type="text" id="sSteps" value="${c.learnSteps.join(' ')}"></label>
      <label class="field">Шаги после ошибки, мин<input type="text" id="sRel" value="${c.relearnSteps.join(' ')}"></label>
      <label class="field">Первый интервал («Хорошо»), дней<input type="number" inputmode="numeric" id="sGrad" value="${c.graduatingIvl}" min="1"></label>
      <label class="field">Интервал для «Легко», дней<input type="number" inputmode="numeric" id="sEasy" value="${c.easyIvl}" min="1"></label>
      <button class="btn primary" data-act="save">Сохранить</button>
      <button class="btn" data-act="defaults">По умолчанию</button>
      <button class="btn" data-act="close">Отмена</button>`, async (act) => {
      if (act === 'defaults') { await DB.setMeta('conf', {}); await loadConf(); close(); toast('Настройки сброшены'); return refresh(); }
      if (act !== 'save') return;
      const steps = v => v.split(/[\s,;]+/).map(Number).filter(x => x > 0);
      const num = (id, def) => { const v = parseInt($(id).value, 10); return Number.isFinite(v) && v >= 0 ? v : def; };
      const conf = {
        newPerDay: num('#sNew', c.newPerDay), revPerDay: num('#sRev', c.revPerDay),
        learnSteps: steps($('#sSteps').value), relearnSteps: steps($('#sRel').value),
        graduatingIvl: Math.max(1, num('#sGrad', c.graduatingIvl)), easyIvl: Math.max(1, num('#sEasy', c.easyIvl)),
      };
      await DB.setMeta('conf', conf); await loadConf(); close(); toast('Сохранено'); refresh();
    });
  }

  function about() {
    sheet(`<h3 class="sheet-title">О приложении</h3>
      <div class="sheet-text">
      <p><b>Запомню</b> — бесплатные карточки с интервальными повторениями. Работает без интернета, все данные хранятся только на этом устройстве.</p>
      <p><b>Как установить на iPhone:</b> откройте сайт в Safari → кнопка «Поделиться» → «На экран „Домой“».</p>
      <p><b>Где брать колоды:</b> ankiweb.net/shared (скачайте .apkg в Safari, затем «Импортировать» → «Файлы» → «Загрузки») или экспорт из Anki на компьютере.</p>
      <p><b>Важно:</b> iOS может удалить данные сайтов, которые долго не открывались. Время от времени делайте резервную копию через меню.</p>
      </div>
      <button class="btn" data-act="close">Закрыть</button>`);
  }

  function mainMenu() {
    sheet(`<button class="btn primary" data-act="import">Импортировать колоду (.apkg)</button>
      <button class="btn" data-act="settings">Настройки повторений</button>
      <button class="btn" data-act="backup">Сохранить резервную копию</button>
      <button class="btn" data-act="restore">Восстановить из копии</button>
      <button class="btn" data-act="about">О приложении</button>
      <button class="btn danger" data-act="wipe">Удалить все данные</button>
      <button class="btn" data-act="close">Закрыть</button>`, async (act, b, close) => {
      close();
      if (act === 'import') $('#fileInput').click();
      if (act === 'settings') settings();
      if (act === 'backup') exportBackup().catch(e => toast('Ошибка: ' + e.message, 5000));
      if (act === 'restore') $('#backupInput').click();
      if (act === 'about') about();
      if (act === 'wipe') {
        if (!await confirmSheet('Удалить все колоды, карточки и прогресс? Это нельзя отменить.', 'Удалить всё')) return;
        await DB.clearAll(); await loadConf(); toast('Все данные удалены'); showHome();
      }
    });
  }

  function refresh() { if (state.screen === 'home') showHome(); }

  // ---------- события ----------
  $('#menuBtn').onclick = mainMenu;
  $('#backBtn').onclick = () => { if (audio) audio.pause(); showHome(); };
  $('#fileInput').onchange = e => { const f = e.target.files[0]; e.target.value = ''; doImport(f); };
  $('#backupInput').onchange = e => { const f = e.target.files[0]; e.target.value = ''; importBackup(f); };
  document.addEventListener('keydown', e => {
    if (state.screen !== 'study' || !state.study || !$('#sheet').hidden) return;
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if ((e.key === ' ' || e.key === 'Enter') && state.study.showing === 'q') { e.preventDefault(); reveal(); }
    else if (/^[1-4]$/.test(e.key) && state.study.showing === 'a') answer(Number(e.key));
    else if ((e.key === ' ' || e.key === 'Enter') && state.study.showing === 'a') { e.preventDefault(); answer(3); }
    else if (e.key === 'z' || e.key === 'я') undo();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  (async () => {
    await loadConf();
    installHint.hidden = await DB.getMeta('hideHint', false);
    await showHome();
  })();
})();
