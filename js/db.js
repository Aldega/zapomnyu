// Простая обёртка над IndexedDB
const DB = (() => {
  const NAME = 'zapomnyu';
  const VERSION = 1;
  const STORES = ['notetypes', 'decks', 'notes', 'cards', 'media', 'meta', 'revlog'];
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('notetypes', { keyPath: 'id' });
        db.createObjectStore('decks', { keyPath: 'id' });
        db.createObjectStore('notes', { keyPath: 'id' });
        const cards = db.createObjectStore('cards', { keyPath: 'id' });
        cards.createIndex('did', 'did');
        cards.createIndex('nid', 'nid');
        db.createObjectStore('media', { keyPath: 'name' });
        db.createObjectStore('meta', { keyPath: 'key' });
        const rl = db.createObjectStore('revlog', { keyPath: 'id', autoIncrement: true });
        rl.createIndex('cid', 'cid');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function reqP(req) {
    return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  }

  async function tx(stores, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let out;
      Promise.resolve(fn(t)).then(v => { out = v; }, err => { try { t.abort(); } catch (_) {} reject(err); });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Транзакция отменена'));
    });
  }

  const get = (store, key) => tx([store], 'readonly', t => reqP(t.objectStore(store).get(key)));
  const all = (store) => tx([store], 'readonly', t => reqP(t.objectStore(store).getAll()));
  const put = (store, val) => tx([store], 'readwrite', t => { t.objectStore(store).put(val); });
  const del = (store, key) => tx([store], 'readwrite', t => { t.objectStore(store).delete(key); });
  const byIndex = (store, index, key) => tx([store], 'readonly', t => reqP(t.objectStore(store).index(index).getAll(key)));
  const keys = (store) => tx([store], 'readonly', t => reqP(t.objectStore(store).getAllKeys()));

  async function putMany(store, vals) {
    const CHUNK = 2000;
    for (let i = 0; i < vals.length; i += CHUNK) {
      const part = vals.slice(i, i + CHUNK);
      await tx([store], 'readwrite', t => { const s = t.objectStore(store); for (const v of part) s.put(v); });
    }
  }

  async function getMeta(key, def) {
    const r = await get('meta', key);
    return r ? r.value : def;
  }
  const setMeta = (key, value) => put('meta', { key, value });

  async function clearAll() {
    await tx(STORES, 'readwrite', t => { for (const s of STORES) t.objectStore(s).clear(); });
  }

  return { open, tx, reqP, get, all, put, del, byIndex, keys, putMany, getMeta, setMeta, clearAll, STORES };
})();
