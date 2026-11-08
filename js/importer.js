// Импорт колод .apkg / .colpkg (старый формат anki2/anki21 и новый anki21b со сжатием zstd)
const Importer = (() => {
  let sqlPromise = null;
  const getSQL = () => sqlPromise || (sqlPromise = initSqlJs({ locateFile: f => 'vendor/' + f }));

  const isZstd = u8 => u8.length > 4 && u8[0] === 0x28 && u8[1] === 0xb5 && u8[2] === 0x2f && u8[3] === 0xfd;
  const unz = u8 => isZstd(u8) ? fzstd.decompress(u8) : u8;
  const td = new TextDecoder();

  // --- минимальный разбор protobuf ---
  function pbRead(buf) {
    const out = []; let i = 0;
    const varint = () => {
      let r = 0, mul = 1, b;
      do { b = buf[i++]; r += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
      return r;
    };
    while (i < buf.length) {
      const key = varint(); const fn = Math.floor(key / 8), wt = key & 7;
      if (wt === 0) out.push({ fn, v: varint() });
      else if (wt === 2) { const len = varint(); out.push({ fn, b: buf.subarray(i, i + len) }); i += len; }
      else if (wt === 1) i += 8;
      else if (wt === 5) i += 4;
      else break;
    }
    return out;
  }
  const pbStr = (fields, fn) => { const f = fields.find(x => x.fn === fn && x.b); return f ? td.decode(f.b) : ''; };
  const pbNum = (fields, fn) => { const f = fields.find(x => x.fn === fn && x.v !== undefined); return f ? f.v : 0; };

  const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', spx: 'audio/ogg',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };
  const mimeOf = n => MIME[(n.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

  function rows(db, sql) {
    const res = db.exec(sql);
    if (!res.length) return [];
    const { columns, values } = res[0];
    return values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
  }
  const hasTable = (db, name) => rows(db, `select name from sqlite_master where type='table' and name='${name}'`).length > 0;

  function readNotetypes(db) {
    const out = [];
    if (hasTable(db, 'notetypes')) {
      for (const nt of rows(db, 'select id, name, config from notetypes')) {
        const cfg = pbRead(nt.config || new Uint8Array());
        const fields = rows(db, `select name from fields where ntid=${nt.id} order by ord`).map(r => r.name);
        const tmpls = rows(db, `select name, config from templates where ntid=${nt.id} order by ord`).map(t => {
          const tc = pbRead(t.config || new Uint8Array());
          return { name: t.name, qfmt: pbStr(tc, 1), afmt: pbStr(tc, 2) };
        });
        out.push({ id: nt.id, name: nt.name, kind: pbNum(cfg, 1), css: pbStr(cfg, 3), fields, tmpls });
      }
    }
    if (!out.length) {
      const col = rows(db, 'select models from col')[0];
      const models = col && col.models ? JSON.parse(col.models) : {};
      for (const m of Object.values(models)) {
        out.push({
          id: Number(m.id), name: m.name, kind: m.type || 0, css: m.css || '',
          fields: (m.flds || []).sort((a, b) => a.ord - b.ord).map(f => f.name),
          tmpls: (m.tmpls || []).sort((a, b) => a.ord - b.ord).map(t => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt })),
        });
      }
    }
    return out;
  }

  function readDecks(db) {
    const out = [];
    if (hasTable(db, 'decks')) {
      for (const d of rows(db, 'select id, name from decks')) out.push({ id: d.id, name: String(d.name).split('\x1f').join('::') });
    }
    if (!out.length) {
      const col = rows(db, 'select decks from col')[0];
      const decks = col && col.decks ? JSON.parse(col.decks) : {};
      for (const d of Object.values(decks)) out.push({ id: Number(d.id), name: d.name });
    }
    return out;
  }

  async function readMediaMap(zip) {
    const f = zip.file('media');
    if (!f) return [];
    const raw = await f.async('uint8array');
    const data = unz(raw);
    const txt = td.decode(data).trim();
    if (txt.startsWith('{')) {
      try { return Object.entries(JSON.parse(txt)).map(([zipName, name]) => ({ zipName, name })); } catch (_) {}
    }
    // новый формат: protobuf MediaEntries
    const list = [];
    pbRead(data).filter(x => x.fn === 1 && x.b).forEach((e, idx) => {
      const ef = pbRead(e.b);
      const legacy = ef.find(x => x.fn === 255);
      list.push({ zipName: String(legacy ? legacy.v : idx), name: pbStr(ef, 1) });
    });
    return list;
  }

  async function importApkg(file, onProgress = () => {}) {
    onProgress('Открываю архив…');
    const zip = await JSZip.loadAsync(file);
    const colName = ['collection.anki21b', 'collection.anki21', 'collection.anki2'].find(n => zip.file(n));
    if (!colName) throw new Error('В архиве нет коллекции Anki. Это точно файл .apkg?');
    let bytes = await zip.file(colName).async('uint8array');
    if (colName.endsWith('b') || isZstd(bytes)) { onProgress('Распаковываю коллекцию…'); bytes = unz(bytes); }

    onProgress('Читаю базу карточек…');
    const SQL = await getSQL();
    const db = new SQL.Database(bytes);
    try {
      const notetypes = readNotetypes(db);
      const decks = readDecks(db);
      const crt = (rows(db, 'select crt from col')[0] || {}).crt || Math.floor(Date.now() / 1000);
      const ankiToday = Math.floor((Date.now() / 1000 - crt) / 86400);
      const ourToday = Sched.today();

      const notes = rows(db, 'select id, mid, flds, tags from notes').map(n => ({
        id: n.id, mid: n.mid, flds: String(n.flds).split('\x1f'), tags: String(n.tags || '').trim().split(/\s+/).filter(Boolean),
      }));
      if (notes.length === 1 && /update to the latest Anki|обновите Anki/i.test(notes[0].flds.join(' ')) && colName === 'collection.anki2') {
        throw new Error('Этот файл сохранён в новом формате, но коллекция внутри пустая. Экспортируйте колоду ещё раз с галочкой «Поддержка старых версий Anki».');
      }

      const usedDecks = new Set();
      const cards = rows(db, 'select id, nid, did, odid, ord, type, queue, due, ivl, factor, reps, lapses from cards').map(c => {
        const did = c.odid ? c.odid : c.did;
        usedDecks.add(did);
        const s = Sched.newCardState();
        if (c.type === 2) {
          s.type = Sched.REVIEW; s.ivl = Math.max(1, c.ivl); s.ease = c.factor || 2500;
          s.due = c.odid ? ourToday : ourToday + (c.due - ankiToday);
        } else if (c.type === 1 || c.type === 3) {
          s.type = c.type; s.ivl = Math.max(1, c.ivl || 1); s.ease = c.factor || 2500; s.due = Date.now();
        }
        s.reps = c.reps || 0; s.lapses = c.lapses || 0;
        s.suspended = c.queue === -1;
        return { id: c.id, nid: c.nid, did, ord: c.ord, pos: c.type === 0 ? c.due : 0, ...s };
      });

      onProgress(`Сохраняю ${cards.length} карточек…`);
      await DB.putMany('notetypes', notetypes);
      await DB.putMany('decks', decks.filter(d => usedDecks.has(d.id) || decks.some(x => x.name.startsWith(d.name + '::'))));
      await DB.putMany('notes', notes);
      // не затираем прогресс, если колоду импортируют повторно
      const existing = new Set(await DB.keys('cards'));
      await DB.putMany('cards', cards.filter(c => !existing.has(c.id)));

      const media = await readMediaMap(zip);
      let done = 0;
      const BATCH = 50;
      for (let i = 0; i < media.length; i += BATCH) {
        const part = media.slice(i, i + BATCH);
        const recs = [];
        for (const m of part) {
          const zf = zip.file(m.zipName);
          if (!zf || !m.name) continue;
          const data = unz(await zf.async('uint8array'));
          recs.push({ name: m.name, blob: new Blob([data], { type: mimeOf(m.name) }) });
        }
        await DB.putMany('media', recs);
        done += part.length;
        onProgress(`Медиафайлы: ${done} из ${media.length}`);
      }
      const added = cards.length - cards.filter(c => existing.has(c.id)).length;
      return { cards: cards.length, added, notes: notes.length, media: media.length, decks: [...usedDecks].length };
    } finally {
      db.close();
    }
  }

  return { importApkg, pbRead };
})();
