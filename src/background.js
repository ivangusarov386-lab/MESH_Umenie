// ==========================================================
//  МЭШ – Оценка учебных умений · service worker
//
//  1. Клик по значку расширения — показать панель на вкладке МЭШ.
//  2. Обход классов идёт в отдельной ФОНОВОЙ (неактивной) вкладке:
//     открываем её, говорим content script'у, что он «рабочий», и
//     закрываем, когда он закончил.
//  3. Паузы для фоновой вкладки: Chrome замедляет таймеры скрытых вкладок
//     (setTimeout не чаще раза в секунду, а через 5 минут — раз в минуту),
//     поэтому рабочая вкладка «спит» через сообщение сюда — таймеры
//     service worker'а не замедляются.
// ==========================================================

const SOURCE = "mesh-skills";
const BATCH_KEY = "meshSkillsBatch";

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id || !String(tab.url || "").startsWith("https://school.mos.ru/")) return;
  chrome.tabs.sendMessage(tab.id, { source: SOURCE, type: "show-panel" }).catch(() => {});
});

async function startWorkerTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  const data = await chrome.storage.local.get(BATCH_KEY);
  const batch = data?.[BATCH_KEY];
  if (batch && batch.status === "running") {
    batch.tabId = tab.id;
    await chrome.storage.local.set({ [BATCH_KEY]: batch });
  }
  return tab.id;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.source !== SOURCE) return undefined;

  if (message.type === "sleep") {
    setTimeout(() => sendResponse({ ok: true }), Math.max(0, Math.min(60000, Number(message.ms) || 0)));
    return true;
  }

  if (message.type === "whoami") {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return undefined;
  }

  if (message.type === "start-worker") {
    startWorkerTab(message.url).then((tabId) => sendResponse({ ok: true, tabId })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (message.type === "close-tab") {
    const id = message.tabId ?? sender.tab?.id;
    if (id) chrome.tabs.remove(id).catch(() => {});
    sendResponse({ ok: true });
    return undefined;
  }

  return undefined;
});

// Рабочую вкладку закрыли руками посреди обхода — помечаем обход остановленным,
// иначе панели в других вкладках навсегда покажут «идёт обход».
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const data = await chrome.storage.local.get(BATCH_KEY);
  const batch = data?.[BATCH_KEY];
  if (batch && batch.status === "running" && batch.tabId === tabId) {
    batch.status = "stopped";
    batch.stopReason = "фоновая вкладка закрыта";
    batch.finishedAt = Date.now();
    await chrome.storage.local.set({ [BATCH_KEY]: batch });
  }
});
