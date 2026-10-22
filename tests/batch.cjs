// Обход нескольких классов в фоновой вкладке + закрытая вкладка + зависший обход.
// Запуск: node tests/batch.cjs   (HIDDEN=1 — ветка фоновой вкладки)
const path = require('path');
const os = require('os');
const fs = require('fs');
// Playwright и Chromium — как в облачной среде Claude Code; переопределяются через env.
const PW = process.env.PLAYWRIGHT_PATH || '/opt/node-tools/node_modules/playwright';
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
// HIDDEN=1 — копия расширения, где document.hidden всегда true: так проверяется
// ветка «фоновая вкладка» (стенд без экрана вкладки скрытыми не делает).
function extensionDir() {
  const root = path.resolve(__dirname, '..');
  if (process.env.HIDDEN !== '1') return root;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msa-hidden-'));
  fs.cpSync(path.join(root, 'manifest.json'), path.join(dir, 'manifest.json'));
  fs.cpSync(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true });
  const f = path.join(dir, 'src', 'skills-autofill.js');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/document\.hidden/g, 'true'));
  return dir;
}
const profileDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'msa-prof-'));
const { chromium } = require(PW);
const { journalPage } = require('./meshmock.cjs');
const J = {
  "111": { label: "5-Е-3", students: ["Алимов Леон", "Бакиров Родион", "Баталов Прохор"], stale: "hidden", failOnce: ["Бакиров Родион"] },
  "222": { label: "6-А", students: ["Гулаев Руслан", "Дранчук Ксения", "Егоров Марк"], blink: true, failSave: ["Дранчук Ксения"] },
  "333": { label: "7-Б", students: ["Зацепа Мария", "Иванов Пётр"], stale: "shell", rerender: 2000 }
};
const myPage = `<!doctype html><meta charset=utf-8><body>${[5,6,7].map(p=>`<section data-test-component="journalListSection-${p}"><h6>${p} параллель</h6><div class=c></div></section>`).join('')}
<script>const J=${JSON.stringify(J)};document.querySelectorAll('section').forEach(sec=>{const par=sec.dataset.testComponent.split('-')[1];
const fill=()=>{sec.querySelector('.c').innerHTML=Object.entries(J).filter(([id,j])=>j.label.startsWith(par)).map(([id,j])=>'<div data-test-component="journalCardRoute"><div><span>'+j.label+' класс</span></div><a href="/teacher/study-process/journal/my/'+id+'">Физическая культура</a></div>').join('')};
if(par==='5')fill();else sec.querySelector('h6').onclick=fill;});</script>`;
(async () => {
  const ext = extensionDir();
  const c = await chromium.launchPersistentContext(profileDir(), { executablePath: CHROME, headless: true, viewport: { width: 1400, height: 900 }, args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  await c.route('https://school.mos.ru/**', (r) => { const u = new URL(r.request().url()); const m = u.pathname.match(/grade\/(\d+)/);
    if (m) return r.fulfill({ contentType: 'text/html; charset=utf-8', body: journalPage(J[m[1]] || J["111"]) });
    if (u.pathname === '/teacher/study-process/journal/my') return r.fulfill({ contentType: 'text/html; charset=utf-8', body: myPage });
    return r.fulfill({ contentType: 'text/html; charset=utf-8', body: '<body>home</body>' }); });
  const p = await c.newPage();
  const fixWorker = async (w) => { await w.waitForLoadState().catch(() => {}); if (!w.url().startsWith('https://school.mos.ru')) await w.goto('https://school.mos.ru/teacher/study-process/journal/grade/111?logon_source=teacher_mentor_journals'); };
  await p.goto('https://school.mos.ru/teacher/study-process/journal/grade/111');
  await p.waitForSelector('#mesh-skills-panel');
  await p.evaluate(() => { localStorage.setItem('saved', '{}'); localStorage.removeItem('failedOnce'); });
  await p.click('[data-action=classes]'); await p.click('.msa-picker [data-action=load]');
  await p.waitForSelector('.msa-par-toggle', { timeout: 20000 });
  await p.goto('https://school.mos.ru/teacher/study-process/journal/grade/111'); await p.waitForSelector('#mesh-skills-panel');
  await p.click('[data-action=classes]'); await p.waitForSelector('.msa-par-toggle');
  await p.click('[data-speed=turbo]');
  // 0) параллели свёрнуты; раскрыть 6-ю, снять/поставить класс, свернуть
  const pick = () => p.evaluate(() => ({
    visibleClasses: [...document.querySelectorAll('.msa-picker-class')].filter((e) => e.offsetParent).length,
    counts: [...document.querySelectorAll('.msa-par-count')].map((e) => e.textContent),
    start: document.querySelector('[data-action=start]').textContent }));
  console.log('0) по умолчанию:', JSON.stringify(await pick()));
  await p.click('.msa-picker-group:nth-of-type(2) .msa-par-toggle');
  console.log('   раскрыта 6-я:', JSON.stringify(await pick()));
  await p.click('.msa-picker-class input[data-id="222"]');
  console.log('   сняли 6-А:', JSON.stringify(await pick()), '| 6-я «частично»/пусто:', await p.$eval('.msa-picker-parallel input[data-parallel="6"]', (e) => e.checked + '/' + e.indeterminate));
  await p.click('.msa-picker-class input[data-id="222"]');
  await p.click('.msa-picker-group:nth-of-type(2) .msa-par-toggle');
  console.log('   вернули и свернули:', JSON.stringify(await pick()));
  // 1) полный обход в фоне
  const t0 = Date.now();
  await p.click('[data-action=start]');
  const w = await c.waitForEvent('page'); await fixWorker(w);
  await w.waitForSelector('#mesh-skills-panel', { timeout: 20000 });
  console.log('фоновая вкладка скрыта (document.hidden):', await w.evaluate(() => document.hidden), '| основная:', await p.evaluate(() => document.hidden));
  // во время выставления повторять ошибки нельзя
  if (await p.$eval('.msa-results', (e) => e.hidden)) await p.click('.msa-results-toggle');
  await p.waitForFunction(() => document.querySelector('.msa-card-errors'), null, { timeout: 600000 });
  console.log('   во время работы: кнопок повтора', await p.$$eval('[data-action=retry], [data-action=retry-all]', (l) => l.length), '| подсказка:', await p.evaluate(() => [...document.querySelectorAll('.msa-results .msa-note')].map((e) => e.textContent).join('')));
  await p.waitForFunction(() => /Готово: пройдено/.test(document.querySelector('.msa-status')?.textContent || ''), null, { timeout: 900000 });
  await p.waitForTimeout(800);
  console.log('   после окончания: кнопок повтора', await p.$$eval('[data-action=retry], [data-action=retry-all]', (l) => l.length));
  console.log('1) обход 3 классов:', ((Date.now() - t0) / 1000).toFixed(0), 'с; вкладка закрыта:', w.isClosed());
  console.log('   итоги:', JSON.stringify(await p.$$eval('.msa-results .msa-card', (l) => l.map((x) => x.querySelector('.msa-card-title b').textContent + ': ' + [...x.querySelectorAll('.msa-chip')].map((ch) => ch.textContent).join('/') + ([...x.querySelectorAll('.msa-card-errors li')].map((li) => ' ⚠ ' + li.textContent).join(''))))));
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('saved') || '{}'));
  console.log('   сохранены:', Object.keys(saved).sort().join(', '));
  // 1б) «Повторить все ошибки»: Бакиров (падал один раз) должен сохраниться,
  // Дранчук (падает всегда) — снова ошибка; остальных не трогаем.
  await p.waitForTimeout(1500);
  const savesBefore = Object.keys(await p.evaluate(() => JSON.parse(localStorage.getItem('saved') || '{}'))).length;
  if (await p.$eval('.msa-results', (e) => e.hidden)) await p.click('.msa-results-toggle');
  await p.waitForSelector('[data-action=retry-all]');
  console.log('1б) кнопка:', (await p.textContent('[data-action=retry-all]')).replace(/\s+/g, ' ').trim());
  await p.click('[data-action=retry-all]');
  const wr = await c.waitForEvent('page'); await fixWorker(wr);
  await p.waitForFunction(() => /Готово: пройдено/.test(document.querySelector('.msa-status')?.textContent || ''), null, { timeout: 600000 });
  await p.waitForTimeout(1500);
  const after = await p.evaluate(() => JSON.parse(localStorage.getItem('saved') || '{}'));
  console.log('    лента повтора:', JSON.stringify(await p.$$eval('.msa-log li', (l) => l.map((x) => x.querySelector('.msa-log-name').textContent + ' — ' + x.querySelector('.msa-log-msg').textContent.slice(0, 40)))));
  console.log('    сохранено было', savesBefore, '→ стало', Object.keys(after).length, '| Бакиров сохранён:', !!after['Бакиров Родион'], '| Дранчук:', !!after['Дранчук Ксения']);
  console.log('    итоги:', JSON.stringify(await p.$$eval('.msa-results .msa-card', (l) => l.map((x) => x.querySelector('.msa-card-title b').textContent + ': ' + [...x.querySelectorAll('.msa-chip')].map((ch) => ch.textContent).join('/')))));
  // 2) закрыть фоновую вкладку руками посреди обхода
  await p.evaluate(() => localStorage.setItem('saved', '{}'));
  await p.click('[data-action=classes]'); await p.click('[data-action=start]');
  const w2 = await c.waitForEvent('page'); await fixWorker(w2);
  await p.waitForFunction(() => document.querySelectorAll('.msa-log li').length >= 1, null, { timeout: 120000 });
  await w2.close();
  await p.waitForFunction(() => !document.getElementById('mesh-skills-panel').classList.contains('msa-busy'), null, { timeout: 30000 });
  console.log('2) закрыли вкладку руками:', await p.textContent('.msa-status'));
  // 3) «зависший» обход (как после перезапуска браузера): running, а вкладки нет
  await p.evaluate(() => new Promise((res) => chrome.storage?.local ? res() : res()));
  const sw = c.serviceWorkers()[0];
  await sw.evaluate(() => chrome.storage.local.set({ meshSkillsBatch: { status: 'running', mode: 'background', queue: [{ id: '111' }], index: 0, startedAt: Date.now() - 600000, tabId: 999999 }, meshSkillsProgress: { text: 'старое', at: Date.now() - 600000, log: [] } }));
  await p.waitForTimeout(500);
  console.log('3) зависший обход — панель занята:', await p.$eval('#mesh-skills-panel', (e) => e.classList.contains('msa-busy')));
  await p.waitForFunction(() => !document.getElementById('mesh-skills-panel').classList.contains('msa-busy'), null, { timeout: 45000 });
  console.log('   через ≤30 с снято:', await p.textContent('.msa-status'));
  await c.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
