// Планировщик интервальных повторений (алгоритм в духе SM-2)
const Sched = (() => {
  const MIN = 60 * 1000;
  const DAY_MS = 24 * 60 * MIN;
  const NEW = 0, LEARN = 1, REVIEW = 2, RELEARN = 3;

  const defaults = {
    learnSteps: [1, 10],      // минуты
    relearnSteps: [10],       // минуты
    graduatingIvl: 1,         // дни
    easyIvl: 4,               // дни
    startEase: 2500,
    easyBonus: 1.3,
    hardFactor: 1.2,
    maxIvl: 36500,
    newPerDay: 20,
    revPerDay: 200,
    dayStartHour: 4,
    learnAheadMin: 20,
  };

  let conf = { ...defaults };
  function setConf(c) { conf = { ...defaults, ...(c || {}) }; }
  function getConf() { return conf; }

  // Номер «учебного дня» — новый день начинается в 4 утра по местному времени
  function today(now = Date.now()) {
    const off = new Date(now).getTimezoneOffset() * MIN;
    return Math.floor((now - off - conf.dayStartHour * 60 * MIN) / DAY_MS);
  }

  function fuzz(ivl, rand = Math.random) {
    if (ivl < 3) return ivl;
    const r = ivl < 7 ? 1 : ivl < 30 ? Math.max(2, Math.round(ivl * 0.15)) : Math.max(4, Math.round(ivl * 0.05));
    return ivl + Math.round((rand() * 2 - 1) * r);
  }

  function clampIvl(i) { return Math.min(conf.maxIvl, Math.max(1, Math.round(i))); }

  function newCardState() {
    return { type: NEW, due: 0, ivl: 0, ease: conf.startEase, reps: 0, lapses: 0, step: 0, suspended: false };
  }

  // Возвращает новое состояние карточки после ответа (1 — Снова, 2 — Трудно, 3 — Хорошо, 4 — Легко)
  function answer(card, ease, now = Date.now(), useFuzz = true) {
    const c = { ...card };
    const t = today(now);
    c.reps = (c.reps || 0) + 1;
    const rand = useFuzz ? Math.random : () => 0.5;

    const graduate = (ivl) => {
      c.type = REVIEW; c.step = 0;
      c.ivl = clampIvl(useFuzz ? fuzz(ivl, rand) : ivl);
      c.due = t + c.ivl;
    };

    if (c.type === NEW || c.type === LEARN || c.type === RELEARN) {
      const relearn = c.type === RELEARN;
      const steps = (relearn ? conf.relearnSteps : conf.learnSteps).filter(x => x > 0);
      if (c.type === NEW) { c.type = LEARN; c.step = 0; c.ease = c.ease || conf.startEase; }
      const idx = Math.min(c.step || 0, Math.max(0, steps.length - 1));
      const setDelay = (m) => { c.due = now + m * MIN; };

      if (!steps.length) {
        if (ease === 1 && !relearn) { setDelay(1); return c; }
        graduate(relearn ? c.ivl : (ease === 4 ? conf.easyIvl : conf.graduatingIvl));
        return c;
      }
      if (ease === 1) { c.step = 0; setDelay(steps[0]); }
      else if (ease === 2) {
        const d = idx === 0 ? (steps.length > 1 ? (steps[0] + steps[1]) / 2 : steps[0] * 1.5) : steps[idx];
        setDelay(d);
      } else if (ease === 3) {
        if (idx + 1 < steps.length) { c.step = idx + 1; setDelay(steps[idx + 1]); }
        else graduate(relearn ? Math.max(1, c.ivl) : conf.graduatingIvl);
      } else {
        graduate(relearn ? Math.max(1, c.ivl) + 1 : conf.easyIvl);
      }
      return c;
    }

    // Повторение выученной карточки
    const overdue = Math.max(0, t - c.due);
    const factor = (c.ease || conf.startEase) / 1000;
    if (ease === 1) {
      c.lapses = (c.lapses || 0) + 1;
      c.ease = Math.max(1300, c.ease - 200);
      c.ivl = 1;
      const steps = conf.relearnSteps.filter(x => x > 0);
      if (steps.length) { c.type = RELEARN; c.step = 0; c.due = now + steps[0] * MIN; }
      else { c.due = t + 1; }
      return c;
    }
    const hardIvl = Math.max(c.ivl + 1, c.ivl * conf.hardFactor);
    const goodIvl = Math.max(hardIvl + 1, (c.ivl + overdue / 2) * factor);
    const easyIvl = Math.max(goodIvl + 1, (c.ivl + overdue) * factor * conf.easyBonus);
    let ivl;
    if (ease === 2) { ivl = hardIvl; c.ease = Math.max(1300, c.ease - 150); }
    else if (ease === 3) { ivl = goodIvl; }
    else { ivl = easyIvl; c.ease = c.ease + 150; }
    c.ivl = clampIvl(useFuzz ? fuzz(Math.round(ivl), rand) : ivl);
    c.due = t + c.ivl;
    return c;
  }

  // Подпись интервала над кнопкой
  function preview(card, ease, now = Date.now()) {
    const n = answer(card, ease, now, false);
    if (n.type === REVIEW) return fmtDays(n.due - today(now));
    return fmtMs(n.due - now);
  }

  function fmtMs(ms) {
    const m = Math.round(ms / MIN);
    if (m < 1) return '<1 мин';
    if (m < 60) return m + ' мин';
    const h = m / 60;
    if (h < 24) return (Math.round(h * 10) / 10).toString().replace('.', ',') + ' ч';
    return fmtDays(Math.round(h / 24));
  }
  function fmtDays(d) {
    if (d < 1) return '<1 д';
    if (d < 30) return d + ' д';
    if (d < 365) return (Math.round(d / 30 * 10) / 10).toString().replace('.', ',') + ' мес';
    return (Math.round(d / 365 * 10) / 10).toString().replace('.', ',') + ' г';
  }

  function isDue(card, now = Date.now()) {
    if (card.suspended) return false;
    if (card.type === LEARN || card.type === RELEARN) return card.due <= now + conf.learnAheadMin * MIN;
    if (card.type === REVIEW) return card.due <= today(now);
    return false;
  }

  return { NEW, LEARN, REVIEW, RELEARN, defaults, setConf, getConf, today, answer, preview, newCardState, isDue, fmtDays };
})();
