// ==========================================================
//  МЭШ – Оценка учебных умений
//
//  Маршрут (по скриншотам из журнала учителя):
//    журнал → клик по ФИО ученика → попап «Информация об учащемся»
//    → кнопка «Оценить учебные умения» → боковая панель
//    «Оценка учебных умений» → в каждом пункте «Почти всегда»
//    → «Сохранить» → закрыть попап → следующий ученик.
//
//  Ищем элементы ПО ТЕКСТУ (заголовки, подписи вариантов, кнопки),
//  а не по CSS-классам: классы у school.mos.ru генерируются сборкой
//  и меняются. Строки учеников — тем же способом, что в проекте mesh
//  (span[title] с ФИО внутри строки, где есть markCell-/studentCellInfoComments-).
//
//  Оценка «проводится по всем вашим предметам сразу» (так написано
//  в самой форме), поэтому достаточно пройти один журнал класса.
// ==========================================================

(() => {
  if (window.__meshSkillsAutofillInstalled) return;
  window.__meshSkillsAutofillInstalled = true;

  const PANEL_ID = "mesh-skills-panel";
  const CURSOR_ID = "mesh-skills-cursor";
  const TARGET_OPTION = "Почти всегда";
  const ANY_OPTION = "Почти никогда";
  const TXT_POPUP_TITLE = "Информация об учащемся";
  const TXT_OPEN_FORM = "Оценить учебные умения";
  // Если ученика уже оценивали, вместо «Оценить…» в попапе кнопка «Повторно оценить…».
  const TXT_REOPEN_FORM = "Повторно оценить учебные умения";
  const TXT_DETAILS = "Подробнее";
  const TXT_FORM_TITLE = "Оценка учебных умений";
  const TXT_SAVE = "Сохранить";
  const TXT_CANCEL = "Отмена";

  const STEP_DELAY_MS = 350;
  const POPUP_TIMEOUT_MS = 5000;
  const FORM_TIMEOUT_MS = 12000;
  const SAVE_ENABLE_TIMEOUT_MS = 5000;
  const SAVE_CLOSE_TIMEOUT_MS = 15000;

  let running = false;
  let stopRequested = false;

  function log(...args) {
    console.log("[МЭШ умения]", ...args);
  }

  // ---------- утилиты DOM ----------

  function norm(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(el) {
    return !!el && el.isConnected && el.getClientRects().length > 0;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function rand(min, max) {
    return Math.round(min + Math.random() * (max - min));
  }

  // Наши собственные элементы (панель, курсор) — не часть страницы МЭШ.
  function isOwn(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    return !!el?.closest?.("[data-msa-own]");
  }

  // Элементы, в которых есть текстовый узел ровно с этим текстом.
  // TreeWalker по текстовым узлам — быстрее, чем textContent у каждого элемента
  // (в журнале тысячи ячеек).
  function textEls(text, root = document.body) {
    if (!root) return [];
    const result = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (norm(node.nodeValue) === text) {
        const el = node.parentElement;
        if (el && isVisible(el) && !isOwn(el)) result.push(el);
      }
      node = walker.nextNode();
    }
    return result;
  }

  function buttonsWithText(text, root = document.body) {
    const found = new Set();
    textEls(text, root).forEach((el) => {
      const btn = el.closest("button, [role='button']");
      if (btn) found.add(btn);
    });
    return [...found];
  }

  function isDisabled(btn) {
    return !btn || btn.disabled || btn.getAttribute("aria-disabled") === "true" || btn.classList.contains("Mui-disabled");
  }

  // ---------- «человеческий» клик ----------
  // Курсор-указатель плавно едет к цели, точка клика — случайная внутри
  // элемента (не ровно в центре), перед нажатием — наведение и короткая пауза.
  // Полная последовательность pointer/mouse-событий: часть React-обработчиков
  // висит на mousedown/pointerdown, а не на click.

  let cursorPos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

  function cursorEl() {
    let el = document.getElementById(CURSOR_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = CURSOR_ID;
      el.setAttribute("data-msa-own", "");
      el.hidden = true;
      document.body.append(el);
    }
    return el;
  }

  function hideCursor() {
    const el = document.getElementById(CURSOR_ID);
    if (el) el.hidden = true;
  }

  // Элемент целиком виден: и в окне, и в каждом прокручиваемом предке (панель формы).
  function inView(el) {
    const r = el.getBoundingClientRect();
    if (r.top < 70 || r.bottom > window.innerHeight - 10) return false;
    let p = el.parentElement;
    while (p && p !== document.body) {
      const style = getComputedStyle(p);
      if (/(auto|scroll|hidden)/.test(style.overflowY) && p.scrollHeight > p.clientHeight + 4) {
        const pr = p.getBoundingClientRect();
        if (r.top < pr.top || r.bottom > pr.bottom) return false;
      }
      p = p.parentElement;
    }
    return true;
  }

  function fire(el, type, x, y) {
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, type.startsWith("pointer") ? { ...opts, pointerId: 1, isPrimary: true, pointerType: "mouse" } : opts));
  }

  async function moveCursorTo(x, y) {
    const el = cursorEl();
    el.hidden = false;
    const dist = Math.hypot(x - cursorPos.x, y - cursorPos.y);
    const ms = Math.min(420, Math.max(110, dist * 0.45)) + rand(0, 60);
    el.style.transitionDuration = `${ms}ms`;
    el.style.transform = `translate(${x}px, ${y}px)`;
    cursorPos = { x, y };
    await sleep(ms);
  }

  async function humanClick(el) {
    if (!el || !el.isConnected) return;
    if (!inView(el)) {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      await sleep(rand(320, 480));
    }
    const r = el.getBoundingClientRect();
    // Случайная точка в центральной части элемента.
    const x = r.left + r.width * (0.3 + Math.random() * 0.4);
    const y = r.top + r.height * (0.35 + Math.random() * 0.3);
    await moveCursorTo(x, y);
    fire(el, "pointerover", x, y);
    fire(el, "mouseover", x, y);
    fire(el, "pointermove", x, y);
    fire(el, "mousemove", x, y);
    await sleep(rand(40, 110));
    fire(el, "pointerdown", x, y);
    fire(el, "mousedown", x, y);
    await sleep(rand(45, 95));
    fire(el, "pointerup", x, y);
    fire(el, "mouseup", x, y);
    el.click();
  }

  async function waitFor(fn, timeoutMs, intervalMs = 150) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (stopRequested) return null;
      const value = fn();
      if (value) return value;
      await sleep(intervalMs);
    }
    return fn() || null;
  }

  // Поднимаемся от элемента-заголовка до контейнера, в котором есть нужная кнопка.
  function containerWith(titleText, buttonTexts) {
    const texts = [].concat(buttonTexts);
    for (const title of textEls(titleText)) {
      let el = title.parentElement;
      while (el && el !== document.body) {
        if (texts.some((t) => buttonsWithText(t, el).length)) return el;
        el = el.parentElement;
      }
    }
    return null;
  }

  // ---------- шаги маршрута ----------

  function studentRows() {
    const seen = new Set();
    const list = [];
    document.querySelectorAll("tr").forEach((row) => {
      if (isOwn(row)) return;
      const isStudent = row.querySelector('[data-test-component^="markCell-"], [data-test-component^="studentCellInfoComments-"]');
      if (!isStudent) return;
      const nameEl = row.querySelector("span[title]");
      const name = norm(nameEl?.getAttribute("title") || nameEl?.textContent);
      if (!nameEl || !name || seen.has(name)) return;
      seen.add(name);
      list.push({ name, nameEl });
    });
    return list;
  }

  function findPopup() {
    return containerWith(TXT_POPUP_TITLE, [TXT_OPEN_FORM, TXT_REOPEN_FORM, TXT_DETAILS]);
  }

  function findForm() {
    return containerWith(TXT_FORM_TITLE, TXT_SAVE);
  }

  async function openPopupFor(student) {
    const targets = [student.nameEl, student.nameEl.closest("td, th")].filter(Boolean);
    for (const target of targets) {
      await humanClick(target);
      const popup = await waitFor(findPopup, POPUP_TIMEOUT_MS);
      if (popup) return popup;
    }
    return null;
  }

  async function closePopup() {
    const popup = findPopup();
    if (!popup) return true;
    // Крестик в шапке попапа — кнопка без текста.
    const close = [...popup.querySelectorAll("button, [role='button']")].find((b) => isVisible(b) && !norm(b.textContent));
    if (close) await humanClick(close);
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    return !!(await waitFor(() => !findPopup(), 3000));
  }

  function optionState(el) {
    const label = el.closest("label");
    const input = label?.querySelector("input[type='radio']") || el.closest("[role='radio']")?.querySelector("input[type='radio']");
    if (input) return { target: label || input, checked: input.checked, known: true };
    const roleRadio = el.closest("[role='radio']");
    if (roleRadio) return { target: roleRadio, checked: roleRadio.getAttribute("aria-checked") === "true", known: true };
    return { target: label || el, checked: false, known: false };
  }

  // Отметить «Почти всегда» в видимых пунктах — по одному, с паузами, как человек
  // быстро щёлкает мышкой. Возвращает число кликов.
  async function fillVisible(form) {
    let clicks = 0;
    for (const el of textEls(TARGET_OPTION, form)) {
      if (stopRequested) break;
      if (!el.isConnected) continue;
      const opt = optionState(el);
      if (opt.checked) continue;
      await humanClick(opt.target);
      clicks += 1;
      // Обычный темп — 0,2–0,5 с между пунктами, изредка «вчитывается» подольше.
      await sleep(Math.random() < 0.12 ? rand(450, 900) : rand(200, 480));
    }
    return clicks;
  }

  function scrollableIn(form) {
    const probe = textEls(TARGET_OPTION, form)[0];
    let el = probe?.parentElement;
    while (el && el !== form.parentElement) {
      const style = getComputedStyle(el);
      if (el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(style.overflowY)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function formStats(form) {
    const questions = textEls(ANY_OPTION, form).length;
    let checked = 0;
    textEls(TARGET_OPTION, form).forEach((el) => {
      if (optionState(el).checked) checked += 1;
    });
    return { questions, checked };
  }

  // Проходим форму сверху вниз: на случай, если пункты дорисовываются при прокрутке.
  async function fillForm(form) {
    const scroller = scrollableIn(form);
    if (scroller && scroller.scrollTop > 0) {
      scroller.scrollTo({ top: 0, behavior: "smooth" });
      await sleep(350);
    }
    for (let guard = 0; guard < 60; guard += 1) {
      if (stopRequested) return formStats(form);
      await fillVisible(form);
      await sleep(rand(100, 180));
      if (!scroller) break;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      if (atBottom) {
        if ((await fillVisible(form)) === 0) break;
        continue;
      }
      scroller.scrollBy({ top: Math.max(200, scroller.clientHeight * 0.8), behavior: "smooth" });
      await sleep(rand(300, 420));
    }
    return formStats(form);
  }

  // Ждём, пока страница перестанет перерисовываться: форма МЭШ может открыться
  // пустой, а потом пересобраться, когда догрузятся данные ученика, — и тогда
  // отметки, поставленные до этого, пропадают.
  function waitStable(quietMs = 700, maxMs = 6000) {
    return new Promise((resolve) => {
      let timer = null;
      const finish = () => {
        observer.disconnect();
        clearTimeout(timer);
        clearTimeout(hardStop);
        resolve();
      };
      const observer = new MutationObserver((mutations) => {
        if (mutations.every((m) => isOwn(m.target))) return;
        clearTimeout(timer);
        timer = setTimeout(finish, quietMs);
      });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(finish, quietMs);
      const hardStop = setTimeout(finish, maxMs);
    });
  }

  function isComplete(stats) {
    return stats.questions > 0 && stats.checked >= stats.questions;
  }

  // Заполнить и убедиться, что отметки ДЕРЖАТСЯ после того, как страница успокоилась.
  async function fillUntilStable() {
    let stats = { questions: 0, checked: 0 };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const form = findForm();
      if (!form || stopRequested) return stats;
      await fillForm(form);
      await waitStable();
      const fresh = findForm();
      stats = fresh ? formStats(fresh) : stats;
      if (isComplete(stats)) return stats;
      log("после заполнения отметки слетели, повторяю", stats);
    }
    return stats;
  }

  function currentSaveButton() {
    const form = findForm();
    const btn = form && buttonsWithText(TXT_SAVE, form)[0];
    return btn && !isDisabled(btn) ? btn : null;
  }

  async function saveForm(alreadyBefore) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (stopRequested) return "stopped";
      const enabled = await waitFor(currentSaveButton, SAVE_ENABLE_TIMEOUT_MS);
      if (enabled) {
        await sleep(rand(350, 800));
        await humanClick(enabled);
        const closed = await waitFor(() => !findForm(), SAVE_CLOSE_TIMEOUT_MS);
        return closed ? "saved" : "not-closed";
      }
      const form = findForm();
      if (!form) return "not-closed";
      const stats = formStats(form);
      // «Уже было» — только если форма открылась УЖЕ заполненной (до наших кликов)
      // и сейчас всё отмечено, а «Сохранить» неактивна из-за отсутствия изменений.
      if (isComplete(stats)) {
        const cancel = buttonsWithText(TXT_CANCEL, form)[0];
        if (cancel) await humanClick(cancel);
        await waitFor(() => !findForm(), 4000);
        // Если форма открылась уже заполненной — это правда «уже было». Иначе
        // (ответы догрузились после наших кликов) не верим и перепроверяем
        // повторным открытием формы.
        return alreadyBefore ? "already" : "recheck";
      }
      log("«Сохранить» неактивна — заполняю форму заново", stats);
      await fillUntilStable();
    }
    return "save-disabled";
  }

  // ---------- один ученик ----------

  async function processStudent(student, { save, recheck = false }) {
    if (findForm()) return { status: "error", message: "уже открыта другая форма — закройте её" };
    await closePopup();

    const popup = await openPopupFor(student);
    if (!popup) return { status: "error", message: "не открылся попап «Информация об учащемся»" };
    await sleep(STEP_DELAY_MS);

    const openBtn = buttonsWithText(TXT_OPEN_FORM, popup)[0];
    if (!openBtn) {
      // Уже оценён — в попапе «Повторно оценить…». Не трогаем, сразу к следующему.
      if (buttonsWithText(TXT_REOPEN_FORM, popup)[0]) {
        await closePopup();
        return { status: "already", message: "уже оценён (есть «Повторно оценить»)" };
      }
      await closePopup();
      return { status: "error", message: "нет кнопки «Оценить учебные умения»" };
    }
    await humanClick(openBtn);

    const opened = await waitFor(() => {
      const f = findForm();
      return f && textEls(TARGET_OPTION, f).length ? f : null;
    }, FORM_TIMEOUT_MS);
    if (!opened) return { status: "error", message: "не открылась форма «Оценка учебных умений»" };
    // При перепроверке ждём дольше — нужно точно увидеть сохранённые ответы.
    await (recheck ? waitStable(1500, 10000) : waitStable(1000, 8000));

    const form = findForm();
    if (!form) return { status: "error", message: "форма закрылась сама", fatal: true };
    // Сверка: в шапке формы должна быть фамилия того, по кому кликнули.
    const surname = student.name.split(" ")[0];
    if (surname && !norm(form.textContent).includes(surname)) {
      return { status: "error", message: `в форме другой ученик (ожидался ${student.name})`, fatal: true };
    }

    const alreadyBefore = isComplete(formStats(form));
    const stats = await fillUntilStable();
    if (stopRequested) return { status: "stopped" };
    if (!stats.questions) return { status: "error", message: "в форме не найдено ни одного пункта", fatal: true };
    if (!isComplete(stats)) {
      return { status: "error", message: `отмечено ${stats.checked} из ${stats.questions} — форма оставлена открытой`, fatal: true };
    }

    if (!save) return { status: "filled", message: `отмечено ${stats.checked} из ${stats.questions}, НЕ сохранено (проверка)` };

    const result = await saveForm(alreadyBefore);
    if (result === "stopped") return { status: "stopped" };
    if (result === "recheck") {
      await closePopup();
      if (recheck) return { status: "error", message: "не удалось подтвердить, что оценка сохранена", fatal: true };
      log(student.name, "перепроверяю повторным открытием формы");
      return processStudent(student, { save, recheck: true });
    }
    if (result === "saved" || result === "already") {
      await sleep(STEP_DELAY_MS);
      await closePopup();
      return { status: result, message: result === "saved" ? `сохранено (${stats.questions} пунктов)` : "уже было заполнено" };
    }
    return {
      status: "error",
      message: result === "save-disabled" ? "кнопка «Сохранить» неактивна — форма оставлена открытой" : "форма не закрылась после «Сохранить»",
      fatal: true
    };
  }

  // ---------- хранилище ----------
  // chrome.storage.local переживает переход между журналами (полную перезагрузку
  // страницы). Без chrome.storage (макет в тестах) — память страницы.

  const BATCH_KEY = "meshSkillsBatch";
  const RESULTS_KEY = "meshSkillsResults";
  const memoryStore = {};

  function getStorage(key) {
    const area = globalThis.chrome?.storage?.local;
    if (!area) return Promise.resolve(memoryStore[key]);
    return new Promise((resolve) => area.get(key, (data) => resolve(data?.[key])));
  }

  function setStorage(key, value) {
    const area = globalThis.chrome?.storage?.local;
    if (!area) {
      memoryStore[key] = value;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      area.set({ [key]: value }, () => {
        const err = globalThis.chrome?.runtime?.lastError;
        if (err) console.error("[МЭШ умения] ошибка записи в storage:", err.message);
        resolve(!err);
      });
    });
  }

  // ---------- журнал и классы ----------

  const MY_CLASSES_PATH = "/teacher/study-process/journal/my";
  const CLASS_CARD_SELECTOR = '[data-test-component="journalCardRoute"]';
  const PARALLEL_SECTION_SELECTOR = 'section[data-test-component^="journalListSection-"]';

  function journalUrl(id) {
    return `/teacher/study-process/journal/grade/${id}?logon_source=teacher_mentor_journals`;
  }

  function currentJournalId() {
    const match = location.pathname.match(/\/journal\/grade\/(\d+)/);
    return match ? match[1] : null;
  }

  function currentJournalTitle() {
    const heading = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].find((h) => /^Журнал\s/.test(norm(h.textContent)) && !isOwn(h));
    return heading ? norm(heading.textContent).replace(/^Журнал\s+/, "") : norm(document.title);
  }

  function isMyClassesPage() {
    return location.pathname === MY_CLASSES_PATH;
  }

  // Карточки классов на «Мои классы» — тот же проверенный способ, что в проекте mesh
  // (class-auto-loader.js: collectMyClassesPage / expandAllParallels).
  function collectMyClasses() {
    const seen = new Set();
    const list = [];
    document.querySelectorAll(CLASS_CARD_SELECTOR).forEach((card) => {
      const link = card.querySelector('a[href*="/journal/my/"]');
      const match = link?.href.match(/\/journal\/my\/(\d+)/);
      if (!match || seen.has(match[1])) return;
      seen.add(match[1]);
      const labelEl = card.querySelector(":scope > div:first-child span");
      const classLabel = norm(labelEl?.textContent).replace(/\s*класс\s*$/i, "") || "?";
      list.push({ id: match[1], text: norm(link.textContent), classLabel });
    });
    return list;
  }

  async function prepareMyClasses() {
    await waitFor(() => document.querySelectorAll(PARALLEL_SECTION_SELECTOR).length > 0, 8000);
    document.querySelectorAll(PARALLEL_SECTION_SELECTOR).forEach((section) => {
      if (section.querySelector(CLASS_CARD_SELECTOR)) return;
      section.querySelector("h6")?.click();
    });
    await waitFor(() => collectMyClasses().length > 0, 6000);
    await sleep(500);
    return collectMyClasses();
  }

  // ---------- результаты по журналам ----------

  async function recordResult(journal, name, res) {
    if (!journal?.id) return;
    const all = (await getStorage(RESULTS_KEY)) || {};
    const entry = all[journal.id] || { id: journal.id, title: journal.title, classLabel: journal.classLabel || "", students: {} };
    entry.title = journal.title || entry.title;
    entry.updatedAt = Date.now();
    entry.students[name] = { status: res.status, message: res.message || "", at: Date.now() };
    all[journal.id] = entry;
    await setStorage(RESULTS_KEY, all);
  }

  async function markJournalNote(journal, note) {
    if (!journal?.id) return;
    const all = (await getStorage(RESULTS_KEY)) || {};
    const entry = all[journal.id] || { id: journal.id, title: journal.title, classLabel: journal.classLabel || "", students: {} };
    entry.note = note || "";
    entry.updatedAt = Date.now();
    all[journal.id] = entry;
    await setStorage(RESULTS_KEY, all);
  }

  function countStatuses(entry) {
    const c = { saved: 0, already: 0, error: 0 };
    Object.values(entry?.students || {}).forEach((st) => {
      if (c[st.status] !== undefined) c[st.status] += 1;
    });
    return c;
  }

  // ---------- уборка после ошибки ----------

  async function cleanupAfterError() {
    const form = findForm();
    if (form) {
      const cancel = buttonsWithText(TXT_CANCEL, form)[0];
      if (cancel) await humanClick(cancel);
      await waitFor(() => !findForm(), 4000);
    }
    await closePopup();
    return !findForm() && !findPopup();
  }

  // ---------- сценарии ----------

  const MAX_ERRORS_IN_ROW = 3;

  // Пройти всех учеников текущего журнала. Ошибка по ученику не останавливает
  // обход: форма закрывается «Отменой», ученик попадает в результаты с ошибкой
  // (дозаполнить вручную). Журнал бросаем, только если не удалось закрыть
  // форму или ошибки идут подряд — значит, что-то сломалось системно.
  async function runJournal({ limit = Infinity, save = true, journal = null, prefix = "" } = {}) {
    const done = new Set();
    const counters = { saved: 0, already: 0, error: 0 };
    let errorsInRow = 0;
    let aborted = "";
    let processed = 0;
    while (processed < limit && !stopRequested) {
      let next = studentRows().find((s) => !done.has(s.name));
      if (!next) {
        // Таблица может дорисовывать строки при прокрутке — пробуем докрутить вниз.
        const all = studentRows();
        all[all.length - 1]?.nameEl.scrollIntoView({ block: "end" });
        await sleep(600);
        next = studentRows().find((s) => !done.has(s.name));
        if (!next) break;
      }
      done.add(next.name);
      processed += 1;
      setStatus(`${prefix}${processed}. ${next.name}…`);

      const res = await processStudent(next, { save });
      if (res.status === "stopped") break;
      if (counters[res.status] !== undefined) counters[res.status] += 1;
      addLog(next.name, res.status, res.message);
      log(next.name, res);
      if (save) await recordResult(journal, next.name, res);

      if (res.status === "error") {
        errorsInRow += 1;
        if (!save) break; // проверочный режим — оставляем всё как есть, чтобы было видно
        const clean = await cleanupAfterError();
        if (!clean) {
          aborted = `не удалось закрыть форму после ошибки на «${next.name}»`;
          break;
        }
        if (errorsInRow >= MAX_ERRORS_IN_ROW) {
          aborted = `${MAX_ERRORS_IN_ROW} ошибки подряд — журнал прерван`;
          break;
        }
      } else {
        errorsInRow = 0;
      }
      await sleep(rand(250, 500));
    }
    return { counters, aborted, processed };
  }

  async function runAll({ limit = Infinity, save = true } = {}) {
    if (running) return;
    running = true;
    stopRequested = false;
    clearLog();
    setBusy(true);
    try {
      const id = currentJournalId();
      const journal = id ? { id, title: currentJournalTitle() } : null;
      const { counters, aborted } = await runJournal({ limit, save, journal });
      if (aborted) await markJournalNote(journal, aborted);
      const tail = stopRequested ? "Остановлено." : aborted ? `Прервано: ${aborted}.` : "Готово.";
      if (!save) setStatus(`${tail} Форма заполнена, сохраните вручную или нажмите «Отмена».`);
      else setStatus(`${tail} Сохранено: ${counters.saved}, уже было: ${counters.already}, ошибок: ${counters.error}.`, counters.error || aborted ? "error" : "ok");
      renderResults();
    } finally {
      hideCursor();
      running = false;
      setBusy(false);
    }
  }

  // ---------- все классы ----------
  // Батч в chrome.storage.local: { status, queue: [{id, text, classLabel}], index,
  // startedAt, visits }. Каждый журнал открывается в ЭТОЙ вкладке (как кликом),
  // после перезагрузки страницы скрипт находит батч и продолжает.

  async function startAllClasses(selected) {
    if (!selected.length) {
      setStatus("Не выбрано ни одного класса.", "error");
      return;
    }
    await setStorage(BATCH_KEY, { status: "running", queue: selected, index: 0, startedAt: Date.now(), visits: 0 });
    setStatus(`Старт: классов — ${selected.length}. Перехожу в первый журнал…`);
    await sleep(rand(500, 900));
    location.href = journalUrl(selected[0].id);
  }

  async function goToMyClassesAndPick() {
    if (isMyClassesPage()) {
      await showClassPicker();
      return;
    }
    await setStorage(BATCH_KEY, { status: "picking" });
    location.href = MY_CLASSES_PATH;
  }

  async function finishBatch(batch, message) {
    batch.status = "done";
    batch.finishedAt = Date.now();
    await setStorage(BATCH_KEY, batch);
    setStatus(message, "ok");
    showResultsSection(true);
    renderResults();
  }

  async function resumeBatchIfRunning() {
    const batch = await getStorage(BATCH_KEY);
    if (!batch) return;
    if (batch.status === "picking") {
      if (!isMyClassesPage()) return;
      await setStorage(BATCH_KEY, { status: "idle" });
      forcedVisible = true;
      ensurePanel();
      await showClassPicker();
      return;
    }
    if (batch.status !== "running") return;

    const item = batch.queue[batch.index];
    if (!item) return finishBatch(batch, "Все классы пройдены.");
    forcedVisible = true;
    ensurePanel();
    const prefix = `Класс ${batch.index + 1} из ${batch.queue.length} (${item.classLabel || item.text}) · `;

    // Открылся не тот журнал (редирект МЭШ, ручной переход) — возвращаемся,
    // но не бесконечно: после 3 попыток класс пропускаем.
    if (currentJournalId() !== String(item.id)) {
      batch.visits = (batch.visits || 0) + 1;
      if (batch.visits > 3) {
        await markJournalNote({ id: item.id, title: item.text, classLabel: item.classLabel }, "журнал не открылся — пропущен");
        batch.index += 1;
        batch.visits = 0;
      }
      await setStorage(BATCH_KEY, batch);
      const next = batch.queue[batch.index];
      if (!next) return finishBatch(batch, "Все классы пройдены.");
      location.href = journalUrl(next.id);
      return;
    }

    running = true;
    stopRequested = false;
    clearLog();
    setBusy(true);
    try {
      setStatus(`${prefix}жду загрузки журнала…`);
      const ok = await waitFor(() => studentRows().length > 0, 25000, 300);
      await waitStable(1000, 8000);
      const journal = { id: item.id, title: currentJournalTitle() || item.text, classLabel: item.classLabel };
      let aborted = "";
      if (!ok) {
        aborted = "в журнале не найдены ученики";
      } else {
        const res = await runJournal({ save: true, journal, prefix });
        aborted = res.aborted;
      }
      await markJournalNote(journal, aborted);

      const fresh = await getStorage(BATCH_KEY);
      if (stopRequested || fresh?.status !== "running") {
        if (fresh) {
          fresh.status = "stopped";
          await setStorage(BATCH_KEY, fresh);
        }
        setStatus("Остановлено. Результаты сохранены — см. «Результаты».", "error");
        showResultsSection(true);
        renderResults();
        return;
      }
      fresh.index += 1;
      fresh.visits = 0;
      await setStorage(BATCH_KEY, fresh);
      const next = fresh.queue[fresh.index];
      if (!next) return finishBatch(fresh, `Готово: пройдено классов — ${fresh.queue.length}. Ошибки — в «Результатах».`);
      setStatus(`Класс готов${aborted ? ` (${aborted})` : ""}. Перехожу к следующему: ${next.classLabel || next.text}…`);
      await sleep(rand(900, 1600));
      location.href = journalUrl(next.id);
    } finally {
      hideCursor();
      running = false;
      setBusy(false);
    }
  }

  async function stopEverything() {
    stopRequested = true;
    const batch = await getStorage(BATCH_KEY);
    if (batch?.status === "running") {
      batch.status = "stopped";
      await setStorage(BATCH_KEY, batch);
    }
    setStatus("Останавливаю после текущего шага…");
  }

  async function fillOpenForm() {
    const form = findForm();
    if (!form) {
      setStatus("Откройте форму «Оценка учебных умений» и нажмите ещё раз.", "error");
      return;
    }
    stopRequested = false;
    const stats = await fillUntilStable();
    hideCursor();
    setStatus(`Отмечено «${TARGET_OPTION}»: ${stats.checked} из ${stats.questions}. Проверьте и нажмите «Сохранить».`, stats.checked >= stats.questions ? "ok" : "error");
  }

  // ---------- панель ----------

  function el(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function panel() {
    return document.getElementById(PANEL_ID);
  }

  function setStatus(message, tone) {
    const node = panel()?.querySelector(".msa-status");
    if (!node) return;
    node.textContent = message;
    node.dataset.tone = tone || "";
  }

  function clearLog() {
    const list = panel()?.querySelector(".msa-log");
    if (list) list.textContent = "";
  }

  function addLog(name, status, message) {
    const list = panel()?.querySelector(".msa-log");
    if (!list) return;
    const item = el("li", { "data-status": status });
    item.append(el("b", {}, name), document.createTextNode(` — ${message || status}`));
    list.append(item);
    list.scrollTop = list.scrollHeight;
  }

  function setBusy(busy) {
    const root = panel();
    if (!root) return;
    root.querySelectorAll("[data-action]").forEach((b) => {
      b.disabled = b.dataset.action === "stop" ? !busy : busy;
    });
  }

  // Выбор классов: все отмечены, можно снять лишние.
  async function showClassPicker() {
    const box = panel()?.querySelector(".msa-picker");
    if (!box) return;
    box.hidden = false;
    box.textContent = "";
    box.append(el("div", { class: "msa-picker-title" }, "Ищу классы…"));
    const classes = await prepareMyClasses();
    box.textContent = "";
    if (!classes.length) {
      box.append(el("div", { class: "msa-picker-title", "data-tone": "error" }, "Карточки классов не найдены. Разверните параллели и нажмите «Все мои классы» ещё раз."));
      return;
    }
    box.append(el("div", { class: "msa-picker-title" }, `Классов: ${classes.length}. Снимите лишние галочки:`));
    const list = el("div", { class: "msa-picker-list" });
    classes.forEach((cls, i) => {
      const label = el("label", { class: "msa-picker-item" });
      const cb = el("input", { type: "checkbox", "data-index": String(i) });
      cb.checked = true;
      label.append(cb, document.createTextNode(` ${cls.classLabel} — ${cls.text}`));
      list.append(label);
    });
    box.append(list);
    const start = el("button", { class: "msa-btn msa-btn-all" }, "Начать по выбранным классам");
    start.addEventListener("click", () => {
      const chosen = [...list.querySelectorAll("input[type=checkbox]")].filter((c) => c.checked).map((c) => classes[Number(c.dataset.index)]);
      box.hidden = true;
      startAllClasses(chosen);
    });
    box.append(start);
  }

  function showResultsSection(open) {
    const box = panel()?.querySelector(".msa-results");
    if (box) box.hidden = !open;
  }

  const STATUS_TEXT = { saved: "сохранено", already: "уже оценён", error: "ошибка", filled: "заполнено без сохранения" };

  async function renderResults() {
    const box = panel()?.querySelector(".msa-results");
    if (!box || box.hidden) return;
    const all = (await getStorage(RESULTS_KEY)) || {};
    const entries = Object.values(all).sort((a, b) => String(a.classLabel || a.title).localeCompare(String(b.classLabel || b.title), "ru", { numeric: true }));
    box.textContent = "";
    if (!entries.length) {
      box.append(el("div", { class: "msa-picker-title" }, "Результатов пока нет."));
      return;
    }
    entries.forEach((entry) => {
      const c = countStatuses(entry);
      const details = el("details", { class: "msa-res-journal" });
      if (c.error || entry.note) details.open = true;
      const summary = el("summary", { "data-tone": c.error || entry.note ? "error" : "ok" });
      summary.textContent = `${entry.classLabel ? `${entry.classLabel} · ` : ""}${entry.title} — сохранено ${c.saved}, уже ${c.already}, ошибок ${c.error}`;
      details.append(summary);
      if (entry.note) details.append(el("div", { class: "msa-res-note" }, `⚠ ${entry.note}`));
      const errors = Object.entries(entry.students).filter(([, st]) => st.status === "error");
      if (errors.length) {
        const ul = el("ul", { class: "msa-res-list" });
        errors.forEach(([name, st]) => ul.append(el("li", {}, `${name} — ${st.message}`)));
        details.append(ul);
      }
      const open = el("a", { href: journalUrl(entry.id), class: "msa-res-open" }, "Открыть журнал");
      details.append(open);
      box.append(details);
    });
    const actions = el("div", { class: "msa-res-actions" });
    const csv = el("button", { class: "msa-btn" }, "Скачать отчёт (CSV)");
    csv.addEventListener("click", downloadResultsCsv);
    const clear = el("button", { class: "msa-btn msa-btn-stop" }, "Очистить результаты");
    clear.addEventListener("click", async () => {
      if (!confirm("Удалить сохранённые результаты по всем классам?")) return;
      await setStorage(RESULTS_KEY, {});
      renderResults();
    });
    actions.append(csv, clear);
    box.append(actions);
  }

  // CSV-инъекция формул (OWASP): значения, начинающиеся с = + - @ таб, экранируем
  // ведущим апострофом — как в проекте mesh.
  function csvValue(value) {
    let str = String(value ?? "");
    if (/^[=+\-@\t\r]/.test(str)) str = "'" + str;
    return `"${str.replace(/"/g, '""')}"`;
  }

  async function downloadResultsCsv() {
    const all = (await getStorage(RESULTS_KEY)) || {};
    const rows = [["Класс", "Журнал", "Ученик", "Результат", "Подробности", "Когда"]];
    Object.values(all).forEach((entry) => {
      Object.entries(entry.students).forEach(([name, st]) => {
        rows.push([entry.classLabel || "", entry.title, name, STATUS_TEXT[st.status] || st.status, st.message, new Date(st.at).toLocaleString("ru-RU")]);
      });
      if (entry.note) rows.push([entry.classLabel || "", entry.title, "", "журнал", entry.note, new Date(entry.updatedAt).toLocaleString("ru-RU")]);
    });
    const text = "﻿" + rows.map((r) => r.map(csvValue).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = el("a", { href: url, download: `учебные-умения-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  let forcedVisible = false;

  function isJournalPage() {
    return /journal/i.test(location.pathname);
  }

  function refreshStudentCount() {
    const root = panel();
    const counter = root?.querySelector(".msa-count");
    if (!counter) return;
    const n = studentRows().length;
    if (isMyClassesPage()) {
      counter.textContent = "Страница «Мои классы».";
      counter.dataset.tone = "";
      return;
    }
    counter.textContent = n ? `Учеников в журнале: ${n}` : "Ученики не найдены — откройте журнал предмета.";
    counter.dataset.tone = n ? "" : "error";
  }

  function ensurePanel() {
    const shouldShow = forcedVisible || running || isJournalPage() || studentRows().length > 0;
    let root = panel();
    if (!shouldShow) {
      if (root) root.hidden = true;
      return;
    }
    if (root) {
      root.hidden = false;
      refreshStudentCount();
      return;
    }

    root = el("div", { id: PANEL_ID, "data-msa-own": "" });
    const head = el("div", { class: "msa-head" });
    head.append(el("span", {}, "Учебные умения"));
    const collapse = el("button", { class: "msa-collapse", title: "Свернуть" }, "–");
    collapse.addEventListener("click", () => root.classList.toggle("msa-collapsed"));
    head.append(collapse);

    const body = el("div", { class: "msa-body" });
    body.append(el("p", { class: "msa-hint" }, `Во всех пунктах ставится «${TARGET_OPTION}».`));
    const buttons = [
      ["classes", "Все мои классы — по очереди", () => goToMyClassesAndPick()],
      ["all", "Этот журнал — заполнить и сохранить", () => runAll({ save: true })],
      ["one", "Проверка на 1 ученике (без сохранения)", () => runAll({ limit: 1, save: false })],
      ["form", "Заполнить открытую форму", () => fillOpenForm()],
      ["stop", "Стоп", () => stopEverything()]
    ];
    buttons.forEach(([action, label, handler]) => {
      const b = el("button", { "data-action": action, class: `msa-btn msa-btn-${action}` }, label);
      b.addEventListener("click", handler);
      body.append(b);
    });
    const picker = el("div", { class: "msa-picker" });
    picker.hidden = true;
    body.append(picker);
    body.append(el("div", { class: "msa-count" }));
    body.append(el("div", { class: "msa-status" }, "Нажмите кнопку, чтобы начать."));
    body.append(el("ol", { class: "msa-log" }));
    const resultsToggle = el("button", { class: "msa-btn msa-btn-results" }, "Результаты по классам");
    const results = el("div", { class: "msa-results" });
    results.hidden = true;
    resultsToggle.addEventListener("click", () => {
      results.hidden = !results.hidden;
      renderResults();
    });
    body.append(resultsToggle, results);

    root.append(head, body);
    document.body.append(root);
    setBusy(running);
    refreshStudentCount();
    log("панель показана, учеников найдено:", studentRows().length);
  }

  globalThis.chrome?.runtime?.onMessage?.addListener((message) => {
    if (message?.source !== "mesh-skills" || message.type !== "show-panel") return;
    forcedVisible = true;
    ensurePanel();
    const root = panel();
    if (root) {
      root.classList.remove("msa-collapsed");
      root.hidden = false;
    }
  });

  window.__MESH_SKILLS_AUTOFILL__ = { runAll, fillOpenForm, studentRows, findPopup, findForm, collectMyClasses, stop: stopEverything };

  setInterval(ensurePanel, 1500);
  ensurePanel();
  resumeBatchIfRunning();
})();
