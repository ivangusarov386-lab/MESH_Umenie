// Матрица сценариев «Этот журнал» с настоящим расширением.
// Запуск: node tests/single.cjs [S3]   (HIDDEN=1 — ветка фоновой вкладки)
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
const { journalPage, QUESTIONS } = require('./meshmock.cjs');
const ALL = ["Алимов Леон", "Бакиров Родион", "Баталов Прохор", "Борисов Иван", "Бредихина Маргарита", "Гулаев Руслан"];
const SCEN = [
  { name: "S1 базовый", o: {} },
  { name: "S2 старые формы прячутся (visibility)", o: { stale: "hidden" } },
  { name: "S3 старые формы — пустая оболочка", o: { stale: "shell" } },
  { name: "S4 форма мигает посреди заполнения", o: { blink: true } },
  { name: "S5 медленная догрузка (2,5 с)", o: { rerender: 2500 } },
  { name: "S6 у одного не сохраняется", o: { failSave: ["Борисов Иван"] } },
  { name: "S7 часть уже оценена", o: {}, rated: ["Бакиров Родион", "Гулаев Руслан"] },
  { name: "S8 ответ «Часто» + Турбо", o: {}, answer: "Часто", speed: "turbo" },
  { name: "S9 всё сразу", o: { stale: "hidden", blink: true, rerender: 1500, failSave: ["Баталов Прохор"] }, rated: ["Алимов Леон"], speed: "turbo" }
];
const only = process.argv[2];
(async () => {
  const ext = extensionDir();
  const c = await chromium.launchPersistentContext(profileDir(), { executablePath: CHROME, headless: true, viewport: { width: 1400, height: 900 }, args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  let current = {};
  await c.route('https://school.mos.ru/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: journalPage(current) }));
  const p = await c.newPage();
  let failures = 0;
  for (const sc of SCEN) {
    if (only && !sc.name.startsWith(only)) continue;
    current = sc.o;
    await p.goto('https://school.mos.ru/teacher/study-process/journal/grade/' + (100 + SCEN.indexOf(sc)));
    const rated = Object.fromEntries((sc.rated || []).map((n) => [n, QUESTIONS.map(() => "Почти всегда")]));
    await p.evaluate((r) => localStorage.setItem('saved', JSON.stringify(r)), rated);
    await p.reload();
    await p.waitForSelector('#mesh-skills-panel');
    await p.waitForFunction(() => /Учеников в журнале: 6/.test(document.querySelector('.msa-count')?.textContent || ''), null, { timeout: 15000 });
    await p.selectOption('[data-answer]', sc.answer || 'Почти всегда');
    await p.click(`[data-speed=${sc.speed || 'fast'}]`);
    const t0 = Date.now();
    await p.click('[data-action=all]');
    await p.waitForFunction(() => /^(Готово|Прервано|Остановлено)/.test(document.querySelector('.msa-status')?.textContent || ''), null, { timeout: 600000 });
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    const st = await p.evaluate(() => ({ saved: window.saved, events: window.events,
      dlg: [...document.querySelectorAll('.dlg')].length,
      openDrawers: [...document.querySelectorAll('.drawer')].filter((d) => !d.dataset.stale).length,
      status: document.querySelector('.msa-status').textContent,
      log: [...document.querySelectorAll('.msa-log li')].map((li) => li.querySelector('.msa-log-name').textContent + ' — ' + li.querySelector('.msa-log-msg').textContent) }));
    const target = sc.answer || 'Почти всегда';
    const problems = [];
    for (const n of ALL) {
      const fail = (sc.o.failSave || []).includes(n);
      const pre = (sc.rated || []).includes(n);
      const v = st.saved[n];
      const line = st.log.find((l) => l.startsWith(n)) || '';
      if (fail) { if (v) problems.push(`${n}: не должен был сохраниться`); if (!/ошибк|не закрылась|неактивн/i.test(line) && !line.includes('не закрылась')) problems.push(`${n}: ожидалась ошибка, а: ${line}`); continue; }
      if (pre) { if (!/уже оценён/.test(line)) problems.push(`${n}: ожидалось «уже оценён», а: ${line}`); continue; }
      if (!v || v.some((x) => x !== target)) problems.push(`${n}: сохранено ${JSON.stringify(v)}`);
      if (/попытк/.test(line)) problems.push(`${n}: повторная попытка: ${line}`);
    }
    if (st.dlg) problems.push('остался диалог');
    if (st.openDrawers) problems.push('осталась открытая форма');
    failures += problems.length ? 1 : 0;
    console.log(`${problems.length ? '✗' : '✓'} ${sc.name} — ${secs} с — ${st.status}`);
    problems.forEach((x) => console.log('    ! ' + x));
    if (problems.length || only) st.log.forEach((l) => console.log('      · ' + l.slice(0, 160)));
  }
  console.log(failures ? `ПРОВАЛЕНО сценариев: ${failures}` : 'ВСЕ СЦЕНАРИИ ПРОШЛИ');
  await c.close();
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
