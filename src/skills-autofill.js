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
  // Варианты ответа одинаковы во всех пунктах формы (скриншот пользователя).
  // Какой ставить — выбирается в панели, хранится в meshSkillsAnswer.
  const ANSWER_OPTIONS = ["Почти никогда", "Редко", "Часто", "Почти всегда", "Затрудняюсь ответить"];
  const ANSWER_KEY = "meshSkillsAnswer";
  let targetOption = "Почти всегда";
  // По этому варианту считаем число пунктов в форме (он есть в каждом пункте).
  const ANY_OPTION = "Почти никогда";
  const TXT_POPUP_TITLE = "Информация об учащемся";
  const TXT_OPEN_FORM = "Оценить учебные умения";
  // Если ученика уже оценивали, вместо «Оценить…» в попапе кнопка «Повторно оценить…».
  const TXT_REOPEN_FORM = "Повторно оценить учебные умения";
  const TXT_DETAILS = "Подробнее";
  const TXT_FORM_TITLE = "Оценка учебных умений";
  const TXT_SAVE = "Сохранить";
  const TXT_CANCEL = "Отмена";
  // Диалог МЭШ после «Отмены», если в форме уже есть отметки (скриншот пользователя).
  const TXT_DISCARD_TITLE = "Выход без сохранения";
  const TXT_DISCARD_CONFIRM = "Выйти без сохранения";

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

  // Видим = есть размеры И не спрятан через visibility. МЭШ (MUI) после
  // закрытия формы может не убирать её из DOM, а прятать visibility:hidden —
  // у такой формы размеры остаются, и раньше её принимали за открытую.
  function isVisible(el) {
    if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
    return getComputedStyle(el).visibility !== "hidden";
  }

  // В скрытой (фоновой) вкладке Chrome замедляет setTimeout до раза в секунду,
  // а через 5 минут — до раза в минуту. Поэтому там «спим» через service
  // worker расширения: его таймеры не замедляются, а ответ приходит событием.
  function sleep(ms) {
    if (document.hidden && globalThis.chrome?.runtime?.id) {
      return new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ source: "mesh-skills", type: "sleep", ms }, () => {
            void chrome.runtime.lastError;
            resolve();
          });
        } catch (error) {
          setTimeout(resolve, ms);
        }
      });
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function rand(min, max) {
    return Math.round(min + Math.random() * (max - min));
  }

  // ---------- скорость ----------
  // Все «человеческие» паузы (движение указателя, между пунктами, между
  // учениками) умножаются на множитель режима. Ожидания загрузки страницы
  // (waitFor/waitStable) от режима не зависят — они про надёжность.
  const SPEED_KEY = "meshSkillsSpeed";
  const SPEEDS = {
    normal: { factor: 1, label: "Спокойно" },
    fast: { factor: 0.45, label: "Быстро" },
    turbo: { factor: 0.22, label: "Турбо" }
  };
  let speed = "fast";

  function pace(ms, min = 0) {
    return Math.max(min, Math.round(ms * (SPEEDS[speed] || SPEEDS.fast).factor));
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
    const ms = pace(Math.min(420, Math.max(110, dist * 0.45)) + rand(0, 60), 40);
    el.style.transitionDuration = `${ms}ms`;
    el.style.transform = `translate(${x}px, ${y}px)`;
    cursorPos = { x, y };
    await sleep(ms);
  }

  async function humanClick(el) {
    if (!el || !el.isConnected) return;
    // Фоновая вкладка: смотреть некому — без анимации указателя и плавной прокрутки,
    // но с той же последовательностью событий и человеческими паузами.
    if (document.hidden) {
      if (!inView(el)) el.scrollIntoView({ block: "center", inline: "nearest" });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width * (0.3 + Math.random() * 0.4);
      const y = r.top + r.height * (0.35 + Math.random() * 0.3);
      fire(el, "pointerover", x, y);
      fire(el, "mouseover", x, y);
      fire(el, "pointermove", x, y);
      fire(el, "mousemove", x, y);
      await sleep(pace(rand(40, 110), 15));
      fire(el, "pointerdown", x, y);
      fire(el, "mousedown", x, y);
      await sleep(pace(rand(45, 95), 20));
      fire(el, "pointerup", x, y);
      fire(el, "mouseup", x, y);
      el.click();
      return;
    }
    if (!inView(el)) {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      await sleep(pace(rand(320, 480), 160));
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
    await sleep(pace(rand(40, 110), 15));
    fire(el, "pointerdown", x, y);
    fire(el, "mousedown", x, y);
    await sleep(pace(rand(45, 95), 20));
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

  // Все видимые формы «Оценка учебных умений»: от каждого заголовка вверх до
  // контейнера с кнопкой «Сохранить» или с вариантами ответа.
  function formCandidates() {
    const found = [];
    for (const title of textEls(TXT_FORM_TITLE)) {
      let el = title.parentElement;
      while (el && el !== document.body) {
        if (buttonsWithText(TXT_SAVE, el).length || textEls(ANY_OPTION, el).length) {
          if (!found.includes(el)) found.push(el);
          break;
        }
        el = el.parentElement;
      }
    }
    return found;
  }

  // Открытая форма = форма С ВАРИАНТАМИ ОТВЕТА. Старая оболочка от прошлого
  // ученика (без вопросов) формой не считается — иначе после «Сохранить»
  // казалось бы, что форма не закрылась. Из нескольких — последняя
  // добавленная (новая выезжающая панель добавляется в конец body).
  function findForm() {
    const withOptions = formCandidates().filter((f) => textEls(ANY_OPTION, f).length);
    return withOptions[withOptions.length - 1] || null;
  }

  // Форма на экране (даже без вопросов) — её «оболочка». Спрятанные и
  // уехавшие за экран старые формы сюда не попадают.
  function onScreen(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth && r.bottom > 0 && r.top < window.innerHeight;
  }

  function formShell() {
    const list = formCandidates().filter(onScreen);
    return list[list.length - 1] || null;
  }

  const LOADING_SELECTOR = '[role="progressbar"], .MuiCircularProgress-root, .MuiSkeleton-root, .MuiLinearProgress-root, [aria-busy="true"]';

  function isLoading(form) {
    return !!form && [...form.querySelectorAll(LOADING_SELECTOR)].some(isVisible);
  }

  // Готовая форма: вопросы на месте и нет индикатора загрузки.
  function readyForm() {
    const f = findForm();
    return f && !isLoading(f) ? f : null;
  }

  // Живой баг v0.9.4: форма открывается, вопросы видны, потом МЭШ на несколько
  // секунд меняет их на загрузку (тянет оценки ученика «по всем предметам»).
  // Ждали 4 с → «форма пропала» → вторая попытка (уже из кэша — быстро).
  // Теперь: пока оболочка формы на экране — она грузится, ждём до
  // FORM_LOAD_MAX_MS; если оболочки нет — после FORM_GRACE_MS считаем, что
  // формы нет (мигание при перерисовке короче).
  const FORM_GRACE_MS = 4000;
  const FORM_LOAD_MAX_MS = 30000;

  async function waitForForm(graceMs = FORM_GRACE_MS) {
    const start = Date.now();
    const res = await waitFor(() => {
      const f = readyForm();
      if (f) return f;
      if (!formShell() && Date.now() - start > graceMs) return "gone";
      return null;
    }, FORM_LOAD_MAX_MS);
    return res && res !== "gone" ? res : null;
  }

  // «Отмена» при отметках в форме вызывает диалог «Выход без сохранения» —
  // мы бросаем форму намеренно, поэтому подтверждаем выход.
  async function confirmDiscardIfAsked(timeoutMs = 2000) {
    // Ждём либо диалог, либо закрытия формы (тогда диалога не будет).
    const outcome = await waitFor(() => {
      if (textEls(TXT_DISCARD_TITLE).length) return buttonsWithText(TXT_DISCARD_CONFIRM)[0] || null;
      return findForm() || formShell() ? null : "closed";
    }, timeoutMs);
    const btn = outcome && outcome !== "closed" ? outcome : null;
    if (btn) {
      await humanClick(btn);
      await waitFor(() => !textEls(TXT_DISCARD_TITLE).length, 3000);
    }
    return !!btn;
  }

  async function cancelForm(form) {
    const cancel = form && buttonsWithText(TXT_CANCEL, form)[0];
    if (!cancel) return;
    await humanClick(cancel);
    await confirmDiscardIfAsked();
    await waitFor(() => !findForm() && !formShell(), 4000);
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
    for (const el of textEls(targetOption, form)) {
      if (stopRequested) break;
      if (!el.isConnected) continue;
      const opt = optionState(el);
      if (opt.checked) continue;
      await humanClick(opt.target);
      clicks += 1;
      // Обычный темп — 0,2–0,5 с между пунктами, изредка «вчитывается» подольше.
      await sleep(pace(Math.random() < 0.12 ? rand(450, 900) : rand(200, 480), 40));
    }
    return clicks;
  }

  function scrollableIn(form) {
    const probe = textEls(targetOption, form)[0];
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
    textEls(targetOption, form).forEach((el) => {
      if (optionState(el).checked) checked += 1;
    });
    return { questions, checked };
  }

  // Проходим форму сверху вниз: на случай, если пункты дорисовываются при прокрутке.
  async function fillForm(form) {
    const scroller = scrollableIn(form);
    if (scroller && scroller.scrollTop > 0) {
      scroller.scrollTo({ top: 0, behavior: "smooth" });
      await sleep(pace(350, 150));
    }
    for (let guard = 0; guard < 60; guard += 1) {
      if (stopRequested) return formStats(form);
      await fillVisible(form);
      await sleep(pace(rand(100, 180), 40));
      if (!scroller) break;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      if (atBottom) {
        if ((await fillVisible(form)) === 0) break;
        continue;
      }
      scroller.scrollBy({ top: Math.max(200, scroller.clientHeight * 0.8), behavior: "smooth" });
      await sleep(pace(rand(300, 420), 180));
    }
    return formStats(form);
  }

  // Ждём, пока страница перестанет перерисовываться: форма МЭШ может открыться
  // пустой, а потом пересобраться, когда догрузятся данные ученика, — и тогда
  // отметки, поставленные до этого, пропадают.
  // Опрос через sleep(), а не setTimeout-цепочки — чтобы и в фоновой вкладке
  // не замедлялось (см. sleep).
  async function waitStable(quietMs = 700, maxMs = 6000) {
    const start = Date.now();
    let last = Date.now();
    const observer = new MutationObserver((mutations) => {
      if (!mutations.every((m) => isOwn(m.target))) last = Date.now();
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    try {
      while (Date.now() - last < quietMs && Date.now() - start < maxMs) {
        await sleep(100);
      }
    } finally {
      observer.disconnect();
    }
  }

  function isComplete(stats) {
    return stats.questions > 0 && stats.checked >= stats.questions;
  }

  // Заполнить и убедиться, что отметки ДЕРЖАТСЯ после того, как страница успокоилась.
  async function fillUntilStable() {
    let stats = { questions: 0, checked: 0 };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const form = readyForm() || (await waitForForm());
      if (!form || stopRequested) return stats;
      await fillForm(form);
      await waitStable(500, 6000);
      const fresh = readyForm() || (await waitForForm());
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
        await sleep(pace(rand(350, 800), 80));
        await humanClick(enabled);
        // Закрыта = нет формы с вопросами и не видно идущего сохранения.
        const closed = await waitFor(() => {
          if (findForm()) return false;
          const shell = formShell();
          return !shell || !isLoading(shell);
        }, SAVE_CLOSE_TIMEOUT_MS);
        if (closed) await waitFor(() => !findForm() && !(formShell() && isLoading(formShell())), 1500);
        return closed && !findForm() ? "saved" : "not-closed";
      }
      const form = readyForm() || (await waitForForm());
      if (!form) return "not-closed";
      const stats = formStats(form);
      // «Уже было» — только если форма открылась УЖЕ заполненной (до наших кликов)
      // и сейчас всё отмечено, а «Сохранить» неактивна из-за отсутствия изменений.
      if (isComplete(stats)) {
        await cancelForm(form);
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

  // Снимок страницы в момент сбоя — чтобы по сообщению в результатах понять,
  // что на самом деле произошло (форма скрыта? убрана? открыт ли попап?).
  function describePage() {
    const titles = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (norm(node.nodeValue) === TXT_FORM_TITLE && !isOwn(node)) titles.push(node.parentElement);
    }
    const titleInfo = titles.length
      ? titles.map((t) => {
          const cs = getComputedStyle(t);
          const r = t.getBoundingClientRect();
          return `${isVisible(t) ? "видим" : "без размеров"}${cs.visibility === "hidden" ? ", visibility:hidden" : ""}${Number(cs.opacity) === 0 ? ", прозрачный" : ""}${r.right < 0 || r.left > window.innerWidth ? ", за экраном" : ""}`;
        }).join("; ")
      : "нет в DOM";
    return [
      `заголовок формы: ${titleInfo}`,
      `«Сохранить»: ${buttonsWithText(TXT_SAVE).length}`,
      `форм видно: ${formCandidates().length}`,
      `загрузка в форме: ${formShell() && isLoading(formShell()) ? "да" : "нет"}`,
      `попап: ${findPopup() ? "открыт" : "нет"}`,
      `диалог «Выход без сохранения»: ${textEls(TXT_DISCARD_TITLE).length ? "да" : "нет"}`,
      `вкладка: ${document.hidden ? "фоновая" : "видимая"}`
    ].join(", ");
  }

  const OPEN_ATTEMPTS = 3;

  // Попап → кнопка «Оценить…» → форма. Если форма открылась и тут же пропала —
  // закрываем всё и пробуем ещё раз (до OPEN_ATTEMPTS).
  async function openFormFor(student, recheck) {
    let lastDiag = "";
    let firstDiag = "";
    for (let attempt = 1; attempt <= OPEN_ATTEMPTS; attempt += 1) {
      if (stopRequested) return { result: { status: "stopped" } };
      if (attempt > 1) {
        // Форма «вернулась», пока мы собирались переоткрывать, — берём её.
        const back = readyForm() || (formShell() ? await waitForForm(1500) : null);
        if (back) return { form: back, attempt: attempt - 1, firstDiag };
        await cleanupAfterError();
        await sleep(pace(900, 400));
        setStatus(`${student.name}: форма пропала, открываю ещё раз (попытка ${attempt} из ${OPEN_ATTEMPTS})…`);
      }
      await closePopup();
      const popup = await openPopupFor(student);
      if (!popup) return { result: { status: "error", message: "не открылся попап «Информация об учащемся»" } };
      await sleep(pace(STEP_DELAY_MS, 60));

      const openBtn = buttonsWithText(TXT_OPEN_FORM, popup)[0];
      if (!openBtn) {
        // Уже оценён — в попапе «Повторно оценить…». Не трогаем, сразу к следующему.
        if (buttonsWithText(TXT_REOPEN_FORM, popup)[0]) {
          await closePopup();
          return { result: { status: "already", message: "уже оценён (есть «Повторно оценить»)" } };
        }
        await closePopup();
        return { result: { status: "error", message: "нет кнопки «Оценить учебные умения»" } };
      }
      await humanClick(openBtn);

      const opened = await waitFor(() => {
        const f = findForm();
        return f && textEls(targetOption, f).length ? f : null;
      }, FORM_TIMEOUT_MS);
      if (!opened) {
        lastDiag = describePage();
        firstDiag = firstDiag || lastDiag;
        log(student.name, `форма не открылась (попытка ${attempt})`, lastDiag);
        continue;
      }
      // При перепроверке ждём дольше — нужно точно увидеть сохранённые ответы.
      await (recheck ? waitStable(1500, 10000) : waitStable(600, 8000));
      // Форма может уйти в загрузку данных ученика — дожидаемся готовой.
      let form = await waitForForm();
      if (form) {
        await waitStable(500, 6000);
        form = readyForm() || (await waitForForm());
      }
      if (form) return { form, attempt, firstDiag };
      lastDiag = describePage();
      firstDiag = firstDiag || lastDiag;
      log(student.name, `форма закрылась сама (попытка ${attempt})`, lastDiag);
    }
    return { result: { status: "error", message: `форма открывается и сразу закрывается (${OPEN_ATTEMPTS} попытки) — ${lastDiag}` } };
  }

  async function processStudent(student, { save, recheck = false }) {
    if (findForm() || formShell()) return { status: "error", message: "уже открыта другая форма — закройте её" };

    const openedForm = await openFormFor(student, recheck);
    if (openedForm.result) return openedForm.result;
    // Сверка: в шапке формы должна быть фамилия того, по кому кликнули
    // (ждём немного — форма может сначала показать прежнего ученика).
    const surname = student.name.split(" ")[0];
    const form = (await waitFor(() => {
      const f = readyForm();
      return f && (!surname || norm(f.textContent).includes(surname)) ? f : null;
    }, FORM_GRACE_MS)) || readyForm() || openedForm.form;
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
      await sleep(pace(STEP_DELAY_MS, 60));
      await closePopup();
      const retryNote = openedForm.attempt > 1 ? `, форма открылась с ${openedForm.attempt}-й попытки; 1-я: ${openedForm.firstDiag}` : "";
      return { status: result, message: result === "saved" ? `сохранено (${stats.questions} пунктов${retryNote})` : "уже было заполнено" };
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
  // Список классов учителя (кэш со страницы «Мои классы») и последний выбор галочек.
  const CLASSES_KEY = "meshSkillsClasses";
  const SELECTION_KEY = "meshSkillsSelection";
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
    // Диалог мог остаться от прошлой попытки.
    await confirmDiscardIfAsked(300);
    // Форма может быть посреди загрузки (без вопросов) — закрываем и такую.
    const form = findForm() || formShell();
    if (form) await cancelForm(form);
    await closePopup();
    return !findForm() && !formShell() && !findPopup();
  }

  // ---------- сценарии ----------

  const MAX_ERRORS_IN_ROW = 3;

  // Пройти всех учеников текущего журнала. Ошибка по ученику не останавливает
  // обход: форма закрывается «Отменой», ученик попадает в результаты с ошибкой
  // (дозаполнить вручную). Журнал бросаем, только если не удалось закрыть
  // форму или ошибки идут подряд — значит, что-то сломалось системно.
  // only — список ФИО: пройти только этих учеников (повтор ошибок).
  async function runJournal({ limit = Infinity, save = true, journal = null, prefix = "", only = null } = {}) {
    const done = new Set();
    const onlySet = Array.isArray(only) && only.length ? new Set(only) : null;
    const wanted = (s) => !done.has(s.name) && (!onlySet || onlySet.has(s.name));
    const counters = { saved: 0, already: 0, error: 0 };
    let errorsInRow = 0;
    let aborted = "";
    let processed = 0;
    while (processed < limit && !stopRequested) {
      if (onlySet && [...onlySet].every((n) => done.has(n))) break;
      let next = studentRows().find(wanted);
      if (!next) {
        // Таблица может дорисовывать строки при прокрутке — пробуем докрутить вниз.
        const all = studentRows();
        all[all.length - 1]?.nameEl.scrollIntoView({ block: "end" });
        await sleep(600);
        next = studentRows().find(wanted);
        if (!next) break;
      }
      done.add(next.name);
      processed += 1;
      setStatus(`${prefix}${processed}. ${next.name}…`);
      setProgress((processed - 1) / Math.max(processed, Math.min(limit, onlySet ? onlySet.size : studentRows().length)));

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
      await sleep(pace(rand(250, 500), 60));
    }
    setProgress(null);
    const missing = onlySet ? [...onlySet].filter((n) => !done.has(n)) : [];
    return { counters, aborted, processed, missing };
  }

  async function runAll({ limit = Infinity, save = true, only = null } = {}) {
    if (running) return;
    running = true;
    stopRequested = false;
    clearLog();
    setBusy(true);
    try {
      const id = currentJournalId();
      const journal = id ? { id, title: currentJournalTitle() } : null;
      const { counters, aborted, missing } = await runJournal({ limit, save, journal, only });
      if (aborted) await markJournalNote(journal, aborted);
      const lost = missing?.length ? ` Не найдены в журнале: ${missing.join(", ")}.` : "";
      const tail = (stopRequested ? "Остановлено." : aborted ? `Прервано: ${aborted}.` : only ? "Повтор ошибок готов." : "Готово.") + lost;
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

  // Обход идёт в отдельной ФОНОВОЙ вкладке (её открывает service worker),
  // а панель в текущей вкладке только показывает ход работы.
  async function startAllClasses(selected, { retry = false } = {}) {
    if (!selected.length) {
      setStatus("Не выбрано ни одного класса.", "error");
      return;
    }
    const canBackground = !!globalThis.chrome?.runtime?.id && useBackgroundTab;
    await setStorage(PROGRESS_KEY, { text: "Открываю фоновую вкладку…", tone: "", fraction: null, log: [], at: Date.now() });
    await setStorage(BATCH_KEY, { status: "running", mode: canBackground ? "background" : "same-tab", retry, queue: selected, index: 0, startedAt: Date.now(), visits: 0 });
    if (!canBackground) {
      setStatus(`Старт: классов — ${selected.length}. Перехожу в первый журнал…`);
      await sleep(pace(rand(500, 900), 150));
      location.href = journalUrl(selected[0].id);
      return;
    }
    setBusy(true);
    clearLog();
    setStatus(retry
      ? `Повтор ошибок (${selected.reduce((n, q) => n + (q.only?.length || 0), 0)} уч.) идёт в фоновой вкладке — можно работать дальше.`
      : `Обход ${selected.length} класс(ов) идёт в фоновой вкладке — можно работать дальше.`);
    chrome.runtime.sendMessage({ source: "mesh-skills", type: "start-worker", url: location.origin + journalUrl(selected[0].id) }, (res) => {
      void chrome.runtime.lastError;
      if (res?.ok) return;
      setStatus("Не удалось открыть фоновую вкладку. Снимите галочку «В фоновой вкладке» и запустите снова.", "error");
      getStorage(BATCH_KEY).then((b) => {
        if (b?.status !== "running") return;
        b.status = "stopped";
        b.stopReason = "фоновая вкладка не открылась";
        b.finishedAt = Date.now();
        setStorage(BATCH_KEY, b);
      });
    });
  }

  // ---------- рабочая вкладка и наблюдатели ----------

  const PROGRESS_KEY = "meshSkillsProgress";
  // Где идёт обход классов: в фоновой вкладке (по умолчанию) или в этой.
  const BG_KEY = "meshSkillsBackground";
  let useBackgroundTab = true;
  getStorage(BG_KEY).then((v) => {
    if (typeof v === "boolean") useBackgroundTab = v;
    const cb = panel()?.querySelector("[data-bg-toggle]");
    if (cb) cb.checked = useBackgroundTab;
  });
  let isWorker = false;
  const progressState = { text: "", tone: "", fraction: null, log: [] };
  let progressTimer = null;

  // Рабочая вкладка пересылает свой статус/ленту в storage — их показывают
  // панели во всех остальных вкладках МЭШ.
  // Через sleep(), а не setTimeout: в скрытой вкладке таймер мог бы
  // сработать только через минуту, и панели показывали бы старое.
  function broadcastProgress() {
    if (!isWorker || progressTimer) return;
    progressTimer = true;
    sleep(250).then(() => {
      progressTimer = null;
      setStorage(PROGRESS_KEY, { ...progressState, log: progressState.log.slice(-60), at: Date.now() });
    });
  }

  // Рабочая вкладка раз в 20 с отмечается «жива» (даже если ученик долго
  // грузится); наблюдатели по этой отметке узнают, что вкладка пропала.
  const HEARTBEAT_MS = 20000;
  const STALE_MS = 180000;

  async function heartbeatLoop() {
    while (isWorker) {
      await sleep(HEARTBEAT_MS);
      if (!isWorker) break;
      setStorage(PROGRESS_KEY, { ...progressState, log: progressState.log.slice(-60), at: Date.now() });
    }
  }

  // Наблюдатель: обход «идёт», а от рабочей вкладки давно ни звука (браузер
  // перезапускали, вкладку выгрузили) — снимаем зависшее состояние.
  async function checkStaleBatch() {
    if (isWorker) return;
    const batch = await getStorage(BATCH_KEY);
    if (batch?.status !== "running" || batch.mode !== "background") return;
    const progress = await getStorage(PROGRESS_KEY);
    const last = Math.max(progress?.at || 0, batch.startedAt || 0);
    if (Date.now() - last < STALE_MS) return;
    batch.status = "stopped";
    batch.stopReason = "фоновая вкладка не отвечает больше 3 минут (закрыта или выгружена браузером) — запустите снова, сделанное сохранено";
    batch.finishedAt = Date.now();
    await setStorage(BATCH_KEY, batch);
  }
  setInterval(checkStaleBatch, 30000);

  function myTabId() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ source: "mesh-skills", type: "whoami" }, (res) => {
          void chrome.runtime.lastError;
          resolve(res?.tabId ?? null);
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  function closeWorkerTab() {
    try {
      chrome.runtime.sendMessage({ source: "mesh-skills", type: "close-tab" }, () => void chrome.runtime.lastError);
    } catch (error) {}
  }

  function applyProgress(progress) {
    if (isWorker || !progress) return;
    const root = panel();
    if (!root) return;
    const status = root.querySelector(".msa-status");
    if (status) {
      status.textContent = progress.text || "";
      status.dataset.tone = progress.tone || "";
    }
    setProgressBar(progress.fraction);
    const list = root.querySelector(".msa-log");
    if (list) {
      list.textContent = "";
      (progress.log || []).forEach((item) => list.append(logItem(item.name, item.status, item.message)));
      list.scrollTop = list.scrollHeight;
    }
  }

  async function applyBatchState(batch) {
    if (isWorker) return;
    const isRunning = batch?.status === "running" && batch?.mode === "background";
    if (!running) setBusy(isRunning);
    if (!isRunning && (batch?.status === "done" || batch?.status === "stopped") && batch.finishedAt !== watchedFinish) {
      watchedFinish = batch.finishedAt;
      if (batch.status === "stopped") {
        setStatus(`Обход остановлен${batch.stopReason ? `: ${batch.stopReason}` : ""}. Результаты сохранены.`, "error");
      }
      showResultsSection(true);
      renderResults();
    }
  }
  let watchedFinish = null;

  globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[PROGRESS_KEY]) applyProgress(changes[PROGRESS_KEY].newValue);
    if (changes[BATCH_KEY]) {
      const batch = changes[BATCH_KEY].newValue;
      if (isWorker && batch?.status !== "running") stopRequested = true;
      applyBatchState(batch);
    }
    if (changes[RESULTS_KEY]) renderResults();
  });

  // Список классов берётся только со страницы «Мои классы» — туда переходим,
  // собираем, кладём в кэш и сразу открываем выбор.
  async function loadClassesFromMyPage() {
    if (isMyClassesPage()) {
      await refreshClassesCache();
      await renderPicker(true);
      return;
    }
    await setStorage(BATCH_KEY, { status: "picking" });
    location.href = MY_CLASSES_PATH;
  }

  async function refreshClassesCache() {
    const box = panel()?.querySelector(".msa-picker");
    if (box) {
      box.hidden = false;
      box.textContent = "";
      box.append(el("div", { class: "msa-picker-title" }, "Ищу классы…"));
    }
    const list = await prepareMyClasses();
    if (list.length) await setStorage(CLASSES_KEY, { list, at: Date.now() });
    return list;
  }

  async function finishBatch(batch, message) {
    batch.status = "done";
    batch.finishedAt = Date.now();
    setStatus(message, "ok");
    setProgressBar(null);
    if (isWorker) {
      await setStorage(PROGRESS_KEY, { ...progressState, log: progressState.log.slice(-60), at: Date.now() });
      await setStorage(BATCH_KEY, batch);
      await sleep(600);
      closeWorkerTab();
      return;
    }
    await setStorage(BATCH_KEY, batch);
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
      await refreshClassesCache();
      await renderPicker(true);
      return;
    }
    if (batch.status !== "running") return;

    if (batch.mode === "background") {
      // Эту ли вкладку открыли для обхода? tabId пишется сразу после её
      // создания — может не успеть, поэтому подождём.
      const me = await myTabId();
      let fresh = batch;
      for (let i = 0; i < 20 && me && fresh?.status === "running" && fresh.tabId === undefined; i += 1) {
        await sleep(150);
        fresh = await getStorage(BATCH_KEY);
      }
      if (!me || fresh?.tabId !== me) {
        // Обычная вкладка: только показываем ход обхода.
        ensurePanel();
        applyBatchState(fresh);
        applyProgress(await getStorage(PROGRESS_KEY));
        return;
      }
      isWorker = true;
      heartbeatLoop();
    }

    const item = batch.queue[batch.index];
    if (!item) return finishBatch(batch, "Все классы пройдены.");
    forcedVisible = true;
    ensurePanel();
    const prefix = `${batch.retry ? "Повтор ошибок · " : ""}Класс ${batch.index + 1} из ${batch.queue.length} (${item.classLabel || item.text}) · `;

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
        const res = await runJournal({ save: true, journal, prefix, only: item.only || null });
        aborted = res.aborted;
      }
      await markJournalNote(journal, aborted);

      const fresh = await getStorage(BATCH_KEY);
      if (stopRequested || fresh?.status !== "running") {
        setStatus("Остановлено. Результаты сохранены — см. «Результаты».", "error");
        if (isWorker) {
          await setStorage(PROGRESS_KEY, { ...progressState, log: progressState.log.slice(-60), at: Date.now() });
          if (fresh && fresh.status === "running") {
            fresh.status = "stopped";
            fresh.finishedAt = Date.now();
            await setStorage(BATCH_KEY, fresh);
          }
          closeWorkerTab();
          return;
        }
        if (fresh) {
          fresh.status = "stopped";
          fresh.finishedAt = Date.now();
          await setStorage(BATCH_KEY, fresh);
        }
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
      await sleep(pace(rand(900, 1600), 250));
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
      batch.finishedAt = Date.now();
      batch.stopReason = "остановлено кнопкой «Стоп»";
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
    setStatus(`Отмечено «${targetOption}»: ${stats.checked} из ${stats.questions}. Проверьте и нажмите «Сохранить».`, stats.checked >= stats.questions ? "ok" : "error");
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

  // Иконки — статичный inline SVG (stroke = currentColor), без эмодзи:
  // эмодзи по-разному рисуются на разных ОС. В разметку попадают только эти
  // константы, никаких данных со страницы.
  const ICONS = {
    logo: '<path d="M9 11.5l2 2 4-4.5"/><path d="M12 3l2.1 1.6 2.6-.3 1 2.4 2.4 1-.3 2.6L21 12l-1.6 2.1.3 2.6-2.4 1-1 2.4-2.6-.3L12 21l-2.1-1.6-2.6.3-1-2.4-2.4-1 .3-2.6L3 12l1.6-2.1-.3-2.6 2.4-1 1-2.4 2.6.3z"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    minus: '<path d="M6 12h12"/>',
    classes: '<path d="M3 7l9-4 9 4-9 4z"/><path d="M7 9.5V15c0 1.5 2.2 3 5 3s5-1.5 5-3V9.5"/>',
    play: '<path d="M8 5.5v13l10.5-6.5z"/>',
    eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    wand: '<path d="M4 20l11-11"/><path d="M14 4v3M12.5 5.5h3M19 9v2.5M17.8 10.2h2.5"/><path d="M15 9l1.5-1.5"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".8"/><circle cx="4.5" cy="12" r=".8"/><circle cx="4.5" cy="18" r=".8"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.5L20 16"/><path d="M20 20v-4h-4"/>',
    download: '<path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19.5h14"/>',
    trash: '<path d="M5 7h14"/><path d="M10 7V5h4v2"/><path d="M7 7l1 12.5h8L17 7"/>',
    external: '<path d="M14 5h5v5"/><path d="M19 5l-8 8"/><path d="M18 14v5H5V6h5"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5"/><path d="M12 17.3v.2"/>'
  };

  function icon(name, cls = "") {
    const span = el("span", { class: `msa-icon ${cls}`.trim(), "aria-hidden": "true" });
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    return span;
  }

  // Кнопка: иконка + подпись (+ необязательная подсказка второй строкой).
  function button({ action, label, hint, iconName, variant = "secondary", onClick, title }) {
    const attrs = { class: `msa-btn msa-btn--${variant}`, type: "button" };
    if (action) attrs["data-action"] = action;
    if (title) attrs.title = title;
    const b = el("button", attrs);
    if (iconName) b.append(icon(iconName));
    const text = el("span", { class: "msa-btn-text" });
    text.append(el("span", { class: "msa-btn-label" }, label));
    if (hint) text.append(el("span", { class: "msa-btn-hint" }, hint));
    b.append(text);
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  function setProgress(fraction) {
    progressState.fraction = typeof fraction === "number" ? fraction : null;
    broadcastProgress();
    setProgressBar(fraction);
  }

  function setProgressBar(fraction) {
    const bar = panel()?.querySelector(".msa-progress");
    if (!bar) return;
    const on = typeof fraction === "number";
    bar.hidden = !on;
    if (on) bar.firstElementChild.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  }

  function setStatus(message, tone) {
    progressState.text = message;
    progressState.tone = tone || "";
    broadcastProgress();
    const node = panel()?.querySelector(".msa-status");
    if (!node) return;
    node.textContent = message;
    node.dataset.tone = tone || "";
  }

  function clearLog() {
    progressState.log = [];
    broadcastProgress();
    const list = panel()?.querySelector(".msa-log");
    if (list) list.textContent = "";
  }

  function logItem(name, status, message) {
    const item = el("li", { "data-status": status });
    item.append(el("span", { class: "msa-dot" }), el("span", { class: "msa-log-name" }, name), el("span", { class: "msa-log-msg" }, message || status));
    return item;
  }

  function addLog(name, status, message) {
    progressState.log.push({ name, status, message: message || "" });
    broadcastProgress();
    const list = panel()?.querySelector(".msa-log");
    if (!list) return;
    list.append(logItem(name, status, message));
    list.scrollTop = list.scrollHeight;
  }

  function setBusy(busy) {
    const root = panel();
    if (!root) return;
    root.classList.toggle("msa-busy", !!busy);
    if (!busy) setProgressBar(null);
    root.querySelectorAll("[data-action]").forEach((b) => {
      if (b.dataset.action === "stop") b.disabled = !busy;
      else b.disabled = busy || b.dataset.empty === "1";
    });
  }

  // ---------- выбор классов ----------
  // Раскрывающийся блок под кнопкой «Все мои классы»: галочка «Все классы»,
  // галочка на каждую параллель (вся параллель разом) и на каждый класс.

  function parallelOf(cls) {
    const m = String(cls.classLabel || "").match(/^(\d+)/);
    return m ? m[1] : "?";
  }

  function togglePicker() {
    const box = panel()?.querySelector(".msa-picker");
    if (!box) return;
    if (!box.hidden) {
      box.hidden = true;
      syncClassesButton();
      return;
    }
    renderPicker(true);
  }

  function syncClassesButton() {
    const btn = panel()?.querySelector('[data-action="classes"]');
    const box = panel()?.querySelector(".msa-picker");
    if (btn) btn.setAttribute("aria-expanded", String(!!box && !box.hidden));
  }

  async function renderPicker(open) {
    const box = panel()?.querySelector(".msa-picker");
    if (!box) return;
    if (open) box.hidden = false;
    syncClassesButton();
    box.textContent = "";

    const cache = await getStorage(CLASSES_KEY);
    const classes = Array.isArray(cache?.list) ? cache.list : [];
    if (!classes.length) {
      box.append(el("div", { class: "msa-note" }, "Список классов ещё не загружен — он берётся со страницы «Мои классы»."));
      const load = button({ action: "load", label: "Загрузить список классов", iconName: "refresh", onClick: loadClassesFromMyPage });
      box.append(load);
      setBusy(running);
      return;
    }

    const savedSel = await getStorage(SELECTION_KEY);
    const selected = new Set(Array.isArray(savedSel) ? savedSel.map(String) : classes.map((c) => String(c.id)));

    const head = el("div", { class: "msa-picker-head" });
    head.append(el("span", { class: "msa-picker-title" }, `Классов: ${classes.length} · список от ${new Date(cache.at).toLocaleDateString("ru-RU")}`));
    const reload = el("button", { class: "msa-link", "data-action": "load", type: "button", title: "Перейти в «Мои классы» и собрать список заново" });
    reload.append(icon("refresh"), el("span", {}, "обновить"));
    reload.addEventListener("click", loadClassesFromMyPage);
    head.append(reload);
    box.append(head);

    const list = el("div", { class: "msa-picker-list" });
    const allLabel = el("label", { class: "msa-picker-item msa-picker-all" });
    const allCb = el("input", { type: "checkbox" });
    allLabel.append(allCb, document.createTextNode(" Все классы"));
    list.append(allLabel);

    const groups = new Map();
    classes.forEach((cls) => {
      const key = parallelOf(cls);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(cls);
    });
    const parallelBoxes = [];
    const classBoxes = [];
    [...groups.keys()].sort((a, b) => Number(a) - Number(b)).forEach((key) => {
      const group = el("div", { class: "msa-picker-group" });
      const pLabel = el("label", { class: "msa-picker-item msa-picker-parallel" });
      const pCb = el("input", { type: "checkbox", "data-parallel": key });
      pLabel.append(pCb, document.createTextNode(key === "?" ? " Без параллели" : ` ${key} параллель`));
      group.append(pLabel);
      parallelBoxes.push(pCb);
      groups.get(key).forEach((cls) => {
        const label = el("label", { class: "msa-picker-item msa-picker-class" });
        const cb = el("input", { type: "checkbox", "data-id": String(cls.id), "data-parallel": key });
        cb.checked = selected.has(String(cls.id));
        label.append(cb, document.createTextNode(` ${cls.classLabel} — ${cls.text}`));
        group.append(label);
        classBoxes.push(cb);
      });
      list.append(group);
    });
    box.append(list);

    const start = el("button", { class: "msa-btn msa-btn--primary msa-btn--block", "data-action": "start", type: "button" });
    box.append(start);

    const chosen = () => classBoxes.filter((cb) => cb.checked).map((cb) => classes.find((c) => String(c.id) === cb.dataset.id));
    const setGroupState = (cb, members) => {
      const on = members.filter((m) => m.checked).length;
      cb.checked = on > 0 && on === members.length;
      cb.indeterminate = on > 0 && on < members.length;
    };
    const sync = () => {
      parallelBoxes.forEach((pCb) => setGroupState(pCb, classBoxes.filter((cb) => cb.dataset.parallel === pCb.dataset.parallel)));
      setGroupState(allCb, classBoxes);
      const n = chosen().length;
      start.textContent = n ? `Начать — выбрано классов: ${n}` : "Выберите классы";
      start.dataset.empty = n ? "" : "1";
      start.disabled = running || !n;
      setStorage(SELECTION_KEY, classBoxes.filter((cb) => cb.checked).map((cb) => cb.dataset.id));
    };
    allCb.addEventListener("change", () => {
      classBoxes.forEach((cb) => { cb.checked = allCb.checked; });
      sync();
    });
    parallelBoxes.forEach((pCb) => pCb.addEventListener("change", () => {
      classBoxes.filter((cb) => cb.dataset.parallel === pCb.dataset.parallel).forEach((cb) => { cb.checked = pCb.checked; });
      sync();
    }));
    classBoxes.forEach((cb) => cb.addEventListener("change", sync));
    start.addEventListener("click", () => {
      const list = chosen();
      if (!list.length) return;
      box.hidden = true;
      syncClassesButton();
      startAllClasses(list);
    });
    sync();
  }

  function showResultsSection(open) {
    const box = panel()?.querySelector(".msa-results");
    if (box) box.hidden = !open;
  }

  const STATUS_TEXT = { saved: "сохранено", already: "уже оценён", error: "ошибка", filled: "заполнено без сохранения" };

  // ---------- повтор ошибок ----------
  // Ученики со статусом «ошибка» в результатах. Свой журнал — прямо здесь;
  // другие журналы (или несколько) — обходом, как «Все мои классы», но в
  // каждом журнале только эти ученики.
  function errorNames(entry) {
    return Object.entries(entry?.students || {}).filter(([, st]) => st.status === "error").map(([name]) => name);
  }

  async function retryErrors(entries) {
    const list = entries.map((e) => ({ id: e.id, text: e.title, classLabel: e.classLabel || "", only: errorNames(e) })).filter((q) => q.only.length);
    if (!list.length) {
      setStatus("Учеников с ошибками нет.", "ok");
      return;
    }
    if (list.length === 1 && String(list[0].id) === String(currentJournalId())) {
      await runAll({ save: true, only: list[0].only });
      return;
    }
    await startAllClasses(list, { retry: true });
  }

  function chip(kind, value, title) {
    const c = el("span", { class: `msa-chip msa-chip--${kind}`, title });
    c.append(icon(kind === "saved" ? "check" : kind === "already" ? "refresh" : "alert"), el("span", {}, String(value)));
    return c;
  }

  async function renderResults() {
    const box = panel()?.querySelector(".msa-results");
    syncResultsButton();
    if (!box || box.hidden) return;
    const all = (await getStorage(RESULTS_KEY)) || {};
    const entries = Object.values(all).sort((a, b) => String(a.classLabel || a.title).localeCompare(String(b.classLabel || b.title), "ru", { numeric: true }));
    box.textContent = "";
    if (!entries.length) {
      box.append(el("div", { class: "msa-note" }, "Результатов пока нет — они появятся после первого прогона."));
      return;
    }
    entries.forEach((entry) => {
      const c = countStatuses(entry);
      const bad = c.error > 0 || !!entry.note;
      const details = el("details", { class: `msa-card${bad ? " msa-card--bad" : ""}` });
      if (bad) details.open = true;
      const summary = el("summary", { class: "msa-card-head", title: `${entry.classLabel || ""} ${entry.title}`.trim() });
      const titleBox = el("span", { class: "msa-card-title" });
      titleBox.append(el("b", {}, entry.classLabel || "Журнал"), el("span", {}, entry.title));
      const chips = el("span", { class: "msa-chips" });
      chips.append(chip("saved", c.saved, "Сохранено"), chip("already", c.already, "Уже был оценён"));
      if (c.error) chips.append(chip("error", c.error, "Ошибки — дозаполнить вручную"));
      summary.append(titleBox, chips);
      details.append(summary);
      if (entry.note) {
        const note = el("div", { class: "msa-card-note" });
        note.append(icon("alert"), el("span", {}, entry.note));
        details.append(note);
      }
      const errors = Object.entries(entry.students).filter(([, st]) => st.status === "error");
      if (errors.length) {
        const ul = el("ul", { class: "msa-card-errors" });
        errors.forEach(([name, st]) => {
          const li = el("li");
          li.append(el("b", {}, name), el("span", {}, st.message));
          ul.append(li);
        });
        details.append(ul);
      }
      const links = el("div", { class: "msa-card-links" });
      if (errors.length) {
        const retry = el("button", { class: "msa-link", type: "button", "data-action": "retry", title: "Ещё раз пройти только учеников с ошибкой" });
        retry.append(icon("refresh"), el("span", {}, `Повторить ошибки (${errors.length})`));
        retry.addEventListener("click", () => retryErrors([entry]));
        links.append(retry);
      }
      const open = el("a", { href: journalUrl(entry.id), class: "msa-link msa-card-open" });
      open.append(el("span", {}, "Открыть журнал"), icon("external"));
      links.append(open);
      details.append(links);
      box.append(details);
    });
    const withErrors = entries.filter((e) => errorNames(e).length);
    if (withErrors.length) {
      const total = withErrors.reduce((n, e) => n + errorNames(e).length, 0);
      const retryAll = button({ action: "retry-all", label: `Повторить все ошибки (${total})`, hint: withErrors.length > 1 ? `в ${withErrors.length} журналах, только эти ученики` : "только эти ученики", iconName: "refresh", onClick: () => retryErrors(withErrors) });
      retryAll.classList.add("msa-btn--block");
      box.append(retryAll);
    }
    const actions = el("div", { class: "msa-row" });
    actions.append(
      button({ label: "Отчёт CSV", iconName: "download", onClick: downloadResultsCsv }),
      button({
        label: "Очистить",
        iconName: "trash",
        variant: "danger",
        onClick: async () => {
          if (!confirm("Удалить сохранённые результаты по всем классам?")) return;
          await setStorage(RESULTS_KEY, {});
          renderResults();
        }
      })
    );
    box.append(actions);
  }

  function syncResultsButton() {
    const btn = panel()?.querySelector(".msa-results-toggle");
    const box = panel()?.querySelector(".msa-results");
    if (btn) btn.setAttribute("aria-expanded", String(!!box && !box.hidden));
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
    counter.textContent = n ? `Учеников в журнале: ${n}` : "Откройте журнал предмета";
    counter.dataset.tone = "";
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

    // Шапка: знак, название, подзаголовок; клик по шапке — свернуть в «таблетку».
    const head = el("div", { class: "msa-head", title: "Свернуть / развернуть" });
    head.append(icon("logo", "msa-logo"));
    const titles = el("div", { class: "msa-titles" });
    titles.append(el("div", { class: "msa-title" }, "Учебные умения"), el("div", { class: "msa-subtitle" }, `Во всех пунктах — «${targetOption}»`));
    head.append(titles);
    const collapse = el("button", { class: "msa-icon-btn msa-collapse", type: "button", "aria-label": "Свернуть" });
    collapse.append(icon("minus"));
    head.append(collapse);
    head.addEventListener("click", () => {
      // Клик после перетаскивания — не сворачивание.
      if (root.dataset.dragged === "1") {
        root.dataset.dragged = "";
        return;
      }
      root.classList.toggle("msa-collapsed");
      requestAnimationFrame(() => clampPanel(true));
    });
    makeDraggable(root, head);

    const body = el("div", { class: "msa-body" });

    // Раздел 1 — все классы.
    const classesSection = el("section", { class: "msa-section" });
    classesSection.append(el("div", { class: "msa-section-title" }, "Классы"));
    const classesBtn = button({ action: "classes", label: "Все мои классы", hint: "все, параллель или выборочно", iconName: "classes", variant: "primary", onClick: () => togglePicker() });
    classesBtn.classList.add("msa-btn--block", "msa-disclosure");
    classesBtn.setAttribute("aria-expanded", "false");
    classesBtn.append(icon("chevron", "msa-chevron"));
    const picker = el("div", { class: "msa-picker" });
    picker.hidden = true;
    const bgLabel = el("label", { class: "msa-check", title: "Выключите, если в фоне что-то идёт не так — тогда классы будут проходиться прямо в этой вкладке" });
    const bgCb = el("input", { type: "checkbox", "data-bg-toggle": "" });
    bgCb.checked = useBackgroundTab;
    bgCb.addEventListener("change", () => {
      useBackgroundTab = bgCb.checked;
      setStorage(BG_KEY, useBackgroundTab);
    });
    bgLabel.append(bgCb, el("span", {}, "В фоновой вкладке"));
    classesSection.append(classesBtn, bgLabel, picker);

    // Раздел 2 — текущий журнал.
    const journalSection = el("section", { class: "msa-section" });
    journalSection.append(el("div", { class: "msa-section-title" }, "Этот журнал"));
    const runBtn = button({ action: "all", label: "Заполнить и сохранить", hint: "все ученики журнала", iconName: "play", onClick: () => runAll({ save: true }) });
    runBtn.classList.add("msa-btn--block");
    const row = el("div", { class: "msa-row" });
    row.append(
      button({ action: "one", label: "Проверка", iconName: "eye", variant: "ghost", title: "Заполнить форму первого ученика без сохранения — посмотреть глазами", onClick: () => runAll({ limit: 1, save: false }) }),
      button({ action: "form", label: "Открытая форма", iconName: "wand", variant: "ghost", title: "Отметить «Почти всегда» в уже открытой форме; «Сохранить» нажимаете сами", onClick: () => fillOpenForm() })
    );
    journalSection.append(runBtn, row);

    // Раздел 3 — ход работы.
    const statusSection = el("section", { class: "msa-section msa-status-section" });
    const statusTop = el("div", { class: "msa-status-top" });
    statusTop.append(el("span", { class: "msa-count" }));
    const stopBtn = button({ action: "stop", label: "Стоп", iconName: "stop", variant: "danger", onClick: () => stopEverything() });
    stopBtn.classList.add("msa-btn--sm");
    statusTop.append(stopBtn);
    const progress = el("div", { class: "msa-progress" });
    progress.append(el("span"));
    progress.hidden = true;
    statusSection.append(statusTop, el("div", { class: "msa-status" }, "Готово к работе."), progress, el("ol", { class: "msa-log" }));

    // Подвал — результаты по классам.
    const resultsToggle = el("button", { class: "msa-results-toggle msa-disclosure", type: "button", "aria-expanded": "false" });
    resultsToggle.append(icon("list"), el("span", {}, "Результаты по классам"), icon("chevron", "msa-chevron"));
    const results = el("div", { class: "msa-results" });
    results.hidden = true;
    resultsToggle.addEventListener("click", () => {
      results.hidden = !results.hidden;
      renderResults();
    });

    // Переключатель скорости — над разделами.
    const speedRow = el("div", { class: "msa-speed" });
    speedRow.append(el("span", { class: "msa-speed-label" }, "Скорость"));
    const seg = el("div", { class: "msa-seg", role: "radiogroup", "aria-label": "Скорость" });
    Object.entries(SPEEDS).forEach(([key, cfg]) => {
      const b = el("button", { type: "button", role: "radio", "data-speed": key, "aria-checked": String(key === speed) }, cfg.label);
      b.addEventListener("click", () => setSpeed(key));
      seg.append(b);
    });
    speedRow.append(seg);

    // Какой ответ ставить во всех пунктах.
    const answerRow = el("label", { class: "msa-speed msa-answer" });
    answerRow.append(el("span", { class: "msa-speed-label" }, "Ответ"));
    const select = el("select", { class: "msa-select", "data-answer": "" });
    ANSWER_OPTIONS.forEach((opt) => {
      const o = el("option", { value: opt }, opt);
      if (opt === targetOption) o.selected = true;
      select.append(o);
    });
    select.addEventListener("change", () => setAnswer(select.value));
    answerRow.append(select);

    body.append(answerRow, speedRow, classesSection, journalSection, statusSection, resultsToggle, results);

    root.append(head, body);
    document.body.append(root);
    restorePanelPosition();
    // Содержимое растёт (раскрыли классы/результаты) — не даём уйти за низ окна.
    if (typeof ResizeObserver === "function") new ResizeObserver(() => clampPanel()).observe(root);
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

  function setAnswer(value) {
    if (!ANSWER_OPTIONS.includes(value)) return;
    targetOption = value;
    const root = panel();
    if (root) {
      const sub = root.querySelector(".msa-subtitle");
      if (sub) sub.textContent = `Во всех пунктах — «${value}»`;
      const select = root.querySelector("[data-answer]");
      if (select && select.value !== value) select.value = value;
    }
    setStorage(ANSWER_KEY, value);
  }

  getStorage(ANSWER_KEY).then((saved) => {
    if (ANSWER_OPTIONS.includes(saved)) setAnswer(saved);
  });

  // ---------- перетаскивание панели ----------
  // Тянем за шапку (и в развёрнутом виде, и «таблеткой»). Позиция — left/top
  // в px, хранится в meshSkillsPos; панель всегда держится в пределах окна.
  const POS_KEY = "meshSkillsPos";
  const DRAG_THRESHOLD = 4;
  const EDGE = 8;

  function placePanel(left, top) {
    const root = panel();
    if (!root) return;
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
    root.style.bottom = "auto";
    root.style.right = "auto";
  }

  // Не даём панели уехать за край — после перетаскивания, сворачивания/
  // разворачивания и изменения размера окна или содержимого.
  function clampPanel(save = false) {
    const root = panel();
    if (!root || root.hidden || !root.style.top) return;
    const r = root.getBoundingClientRect();
    const left = Math.min(Math.max(EDGE, r.left), Math.max(EDGE, window.innerWidth - r.width - EDGE));
    const top = Math.min(Math.max(EDGE, r.top), Math.max(EDGE, window.innerHeight - r.height - EDGE));
    if (Math.abs(left - r.left) > 0.5 || Math.abs(top - r.top) > 0.5) placePanel(left, top);
    if (save) setStorage(POS_KEY, { left, top });
  }

  function makeDraggable(root, handle) {
    let start = null;
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      // Иначе браузер начинает своё перетаскивание/выделение и перестаёт
      // присылать pointermove (так «таблетка» не двигалась за значок).
      e.preventDefault();
      // Захват сразу: при быстром рывке указатель успевает уйти с маленькой
      // «таблетки» до порога перетаскивания, и без захвата движения теряются.
      handle.setPointerCapture?.(e.pointerId);
      const r = root.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false };
    });
    handle.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!start.moved) {
        start.moved = true;
        root.classList.add("msa-dragging");
      }
      const r = root.getBoundingClientRect();
      const left = Math.min(Math.max(EDGE, start.left + dx), window.innerWidth - r.width - EDGE);
      const top = Math.min(Math.max(EDGE, start.top + dy), window.innerHeight - r.height - EDGE);
      placePanel(left, top);
    });
    const end = (e) => {
      if (!start) return;
      if (handle.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      if (start.moved) {
        root.dataset.dragged = "1";
        // Если click после перетаскивания не придёт — флаг не должен «съесть» следующий клик.
        setTimeout(() => { root.dataset.dragged = ""; }, 0);
        root.classList.remove("msa-dragging");
        clampPanel(true);
      }
      start = null;
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  async function restorePanelPosition() {
    const pos = await getStorage(POS_KEY);
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
      placePanel(pos.left, pos.top);
      clampPanel();
    }
  }

  window.addEventListener("resize", () => clampPanel());

  function setSpeed(key) {
    if (!SPEEDS[key]) return;
    speed = key;
    panel()?.querySelectorAll("[data-speed]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.speed === key)));
    setStorage(SPEED_KEY, key);
  }

  getStorage(SPEED_KEY).then((saved) => {
    if (SPEEDS[saved]) setSpeed(saved);
  });

  window.__MESH_SKILLS_AUTOFILL__ = { runAll, fillOpenForm, studentRows, findPopup, findForm, collectMyClasses, stop: stopEverything };

  setInterval(ensurePanel, 1500);
  ensurePanel();
  resumeBatchIfRunning();
})();
