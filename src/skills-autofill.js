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

  // ---------- сценарии ----------

  async function runAll({ limit = Infinity, save = true } = {}) {
    if (running) return;
    running = true;
    stopRequested = false;
    clearLog();
    setBusy(true);

    const done = new Set();
    const counters = { saved: 0, already: 0, error: 0 };
    try {
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
        setStatus(`${processed}. ${next.name}…`);

        const res = await processStudent(next, { save });
        if (res.status === "stopped") break;
        if (counters[res.status] !== undefined) counters[res.status] += 1;
        addLog(next.name, res.status, res.message);
        log(next.name, res);
        if (res.fatal) {
          setStatus(`Остановлено на «${next.name}»: ${res.message}`, "error");
          return;
        }
        await sleep(STEP_DELAY_MS);
      }

      const tail = stopRequested ? "Остановлено." : "Готово.";
      if (!save) setStatus(`${tail} Форма заполнена, сохраните вручную или нажмите «Отмена».`);
      else setStatus(`${tail} Сохранено: ${counters.saved}, уже было: ${counters.already}, ошибок: ${counters.error}.`, counters.error ? "error" : "ok");
    } finally {
      hideCursor();
      running = false;
      setBusy(false);
    }
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

  let forcedVisible = false;

  function isJournalPage() {
    return /journal/i.test(location.pathname);
  }

  function refreshStudentCount() {
    const root = panel();
    const counter = root?.querySelector(".msa-count");
    if (!counter) return;
    const n = studentRows().length;
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
      ["all", "Все ученики — заполнить и сохранить", () => runAll({ save: true })],
      ["one", "Проверка на 1 ученике (без сохранения)", () => runAll({ limit: 1, save: false })],
      ["form", "Заполнить открытую форму", () => fillOpenForm()],
      ["stop", "Стоп", () => { stopRequested = true; setStatus("Останавливаю после текущего шага…"); }]
    ];
    buttons.forEach(([action, label, handler]) => {
      const b = el("button", { "data-action": action, class: `msa-btn msa-btn-${action}` }, label);
      b.addEventListener("click", handler);
      body.append(b);
    });
    body.append(el("div", { class: "msa-count" }));
    body.append(el("div", { class: "msa-status" }, "Нажмите кнопку, чтобы начать."));
    body.append(el("ol", { class: "msa-log" }));

    root.append(head, body);
    document.body.append(root);
    setBusy(false);
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

  window.__MESH_SKILLS_AUTOFILL__ = { runAll, fillOpenForm, studentRows, findPopup, findForm, stop: () => { stopRequested = true; } };

  setInterval(ensurePanel, 1500);
  ensurePanel();
})();
