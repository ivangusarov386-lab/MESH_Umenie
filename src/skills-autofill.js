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
  const TARGET_OPTION = "Почти всегда";
  const ANY_OPTION = "Почти никогда";
  const TXT_POPUP_TITLE = "Информация об учащемся";
  const TXT_OPEN_FORM = "Оценить учебные умения";
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
        if (el && isVisible(el) && !el.closest(`#${PANEL_ID}`)) result.push(el);
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

  // Полная последовательность событий указателя — часть React-обработчиков
  // висит на mousedown/pointerdown, а не на click.
  function realClick(el) {
    if (!el) return;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
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
  function containerWith(titleText, buttonText) {
    for (const title of textEls(titleText)) {
      let el = title.parentElement;
      while (el && el !== document.body) {
        if (buttonsWithText(buttonText, el).length) return el;
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
      if (row.closest(`#${PANEL_ID}`)) return;
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
    return containerWith(TXT_POPUP_TITLE, TXT_OPEN_FORM);
  }

  function findForm() {
    return containerWith(TXT_FORM_TITLE, TXT_SAVE);
  }

  async function openPopupFor(student) {
    const targets = [student.nameEl, student.nameEl.closest("td, th")].filter(Boolean);
    for (const target of targets) {
      realClick(target);
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
    if (close) realClick(close);
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    return !!(await waitFor(() => !findPopup(), 3000));
  }

  // Отметить «Почти всегда» во всех видимых пунктах формы. Возвращает число новых кликов.
  function fillVisible(form) {
    let clicks = 0;
    textEls(TARGET_OPTION, form).forEach((el) => {
      const label = el.closest("label");
      const input = label?.querySelector("input[type='radio']") || el.closest("[role='radio']")?.querySelector("input[type='radio']");
      if (input) {
        if (input.checked) return;
        realClick(label || input);
        clicks += 1;
        return;
      }
      const roleRadio = el.closest("[role='radio']");
      if (roleRadio) {
        if (roleRadio.getAttribute("aria-checked") === "true") return;
        realClick(roleRadio);
        clicks += 1;
        return;
      }
      realClick(label || el);
      clicks += 1;
    });
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
      const input = el.closest("label")?.querySelector("input[type='radio']");
      const roleRadio = el.closest("[role='radio']");
      if (input?.checked || roleRadio?.getAttribute("aria-checked") === "true") checked += 1;
    });
    return { questions, checked };
  }

  // Проходим форму сверху вниз: на случай, если пункты дорисовываются при прокрутке.
  async function fillForm(form) {
    const scroller = scrollableIn(form);
    if (scroller) scroller.scrollTop = 0;
    for (let guard = 0; guard < 60; guard += 1) {
      if (stopRequested) return formStats(form);
      fillVisible(form);
      await sleep(120);
      if (!scroller) break;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      if (atBottom) {
        if (fillVisible(form) === 0) break;
        continue;
      }
      scroller.scrollTop += Math.max(200, scroller.clientHeight * 0.8);
      await sleep(150);
    }
    return formStats(form);
  }

  async function saveForm(form, stats) {
    const saveBtn = buttonsWithText(TXT_SAVE, form)[0];
    const enabled = await waitFor(() => (saveBtn && !isDisabled(saveBtn) ? saveBtn : null), SAVE_ENABLE_TIMEOUT_MS);
    if (!enabled) {
      // Кнопка неактивна, а всё уже отмечено — форма была заполнена раньше, изменений нет.
      if (stats.questions && stats.checked >= stats.questions) {
        const cancel = buttonsWithText(TXT_CANCEL, form)[0];
        if (cancel) realClick(cancel);
        await waitFor(() => !findForm(), 4000);
        return "already";
      }
      return "save-disabled";
    }
    realClick(enabled);
    const closed = await waitFor(() => !findForm(), SAVE_CLOSE_TIMEOUT_MS);
    return closed ? "saved" : "not-closed";
  }

  // ---------- один ученик ----------

  async function processStudent(student, { save }) {
    if (findForm()) return { status: "error", message: "уже открыта другая форма — закройте её" };
    await closePopup();

    const popup = await openPopupFor(student);
    if (!popup) return { status: "error", message: "не открылся попап «Информация об учащемся»" };
    await sleep(STEP_DELAY_MS);

    const openBtn = buttonsWithText(TXT_OPEN_FORM, popup)[0];
    if (!openBtn) return { status: "error", message: "нет кнопки «Оценить учебные умения»" };
    realClick(openBtn);

    const form = await waitFor(() => {
      const f = findForm();
      return f && textEls(TARGET_OPTION, f).length ? f : null;
    }, FORM_TIMEOUT_MS);
    if (!form) return { status: "error", message: "не открылась форма «Оценка учебных умений»" };

    // Сверка: в шапке формы должна быть фамилия того, по кому кликнули.
    const surname = student.name.split(" ")[0];
    if (surname && !norm(form.textContent).includes(surname)) {
      return { status: "error", message: `в форме другой ученик (ожидался ${student.name})`, fatal: true };
    }
    await sleep(STEP_DELAY_MS);

    const stats = await fillForm(form);
    if (stopRequested) return { status: "stopped" };
    if (!stats.questions) return { status: "error", message: "в форме не найдено ни одного пункта" };
    if (stats.checked < stats.questions) {
      return { status: "error", message: `отмечено ${stats.checked} из ${stats.questions} — форма оставлена открытой`, fatal: true };
    }

    if (!save) return { status: "filled", message: `отмечено ${stats.checked} из ${stats.questions}, НЕ сохранено (проверка)` };

    const result = await saveForm(form, stats);
    if (result === "saved" || result === "already") {
      await sleep(STEP_DELAY_MS);
      await closePopup();
      return { status: result, message: result === "saved" ? `сохранено (${stats.questions} пунктов)` : "уже было заполнено" };
    }
    return {
      status: "error",
      message: result === "save-disabled" ? "кнопка «Сохранить» неактивна" : "форма не закрылась после «Сохранить»",
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
    const stats = await fillForm(form);
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

    root = el("div", { id: PANEL_ID });
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
