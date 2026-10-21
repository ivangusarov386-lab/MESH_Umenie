// Клик по значку расширения — показать панель на текущей вкладке МЭШ.
chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id || !String(tab.url || "").startsWith("https://school.mos.ru/")) return;
  chrome.tabs.sendMessage(tab.id, { source: "mesh-skills", type: "show-panel" }).catch(() => {});
});
