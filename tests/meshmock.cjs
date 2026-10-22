// Макет журнала МЭШ с настраиваемыми «капризами» (см. opts).
const QUESTIONS = [
  ["Самоорганизация", "Систематически выполняет домашние задания"],
  ["Самоорганизация", "Выполняет задания в срок"],
  ["Самообразование", "Интересуется вопросами за рамками программы"],
  ["Самообразование", "Оценивает свою работу объективно"],
  ["Самообразование", "Регулирует свое поведение"],
  ["Коммуникация", "Умеет слушать собеседника"],
  ["Коммуникация", "Общается вежливо"],
  ["Коммуникация", "Работает в группе"],
  ["Мышление", "Анализирует информацию"],
  ["Мышление", "Делает выводы"]
];
function journalPage(o) {
  const opts = Object.assign({ label: "5-Е-3", students: ["Алимов Леон", "Бакиров Родион", "Баталов Прохор", "Борисов Иван", "Бредихина Маргарита", "Гулаев Руслан"], stale: "remove", rerender: 900, reload: 0, blink: false, dialog: true, spinner: true, failSave: [], failOnce: [], rowsDelay: 600, popupDelay: 250 }, o);
  return `<!doctype html><meta charset=utf-8><body style="font:14px sans-serif;margin:0">
<h4 style="margin:12px">Журнал Физическая культура ${opts.label} 26-27 г.</h4><table id=j></table>
<script>
const O=${JSON.stringify(opts)}, Q=${JSON.stringify(QUESTIONS)};
const OPTS=["Почти никогда","Редко","Часто","Почти всегда","Затрудняюсь ответить"];
const store=JSON.parse(localStorage.getItem('saved')||'{}'); window.saved=store; window.events=[];
const persist=()=>localStorage.setItem('saved',JSON.stringify(store));
setTimeout(()=>O.students.forEach((n,i)=>{const tr=document.createElement('tr');
  tr.innerHTML='<td>'+(i+1)+'</td><td><div data-test-component="studentCellInfoComments-'+i+'"><span title="'+n+'">'+n+'</span></div></td><td><div data-test-component="markCell-'+i+'_200001_x">5</div></td>';
  document.getElementById('j').append(tr); tr.querySelector('span[title]').addEventListener('click',()=>setTimeout(()=>openPopup(n),O.popupDelay));}),O.rowsDelay);
function openPopup(n){document.querySelectorAll('.pop').forEach(p=>p.remove());const d=document.createElement('div');d.className='pop';
 d.style.cssText='position:fixed;left:240px;top:200px;background:#fff;border:1px solid #ccc;padding:8px;z-index:5';
 d.innerHTML='<div><span>Информация об учащемся</span> <button class="x"><svg width=10 height=10></svg></button></div><p>Телефон</p><button>Подробнее</button><br><button class="o"><span>'+(store[n]?'Повторно оценить учебные умения':'Оценить учебные умения')+'</span></button>';
 document.body.append(d); d.querySelector('.x').onclick=()=>d.remove(); d.querySelector('.o').onclick=()=>setTimeout(()=>openForm(n),300);}
function closeDrawer(f){ if(O.stale==='hidden'){f.style.visibility='hidden';f.setAttribute('aria-hidden','true');f.dataset.stale='1';}
  else if(O.stale==='shell'){f.querySelector('.sc').innerHTML='';f.querySelector('.s').textContent='Сохранить';f.style.transform='translateX(110%)';f.dataset.stale='1';}
  else f.remove(); }
function openForm(n){
 const f=document.createElement('div');f.className='drawer';
 f.style.cssText='position:fixed;right:0;top:0;width:520px;height:100vh;background:#fff;display:flex;flex-direction:column;border-left:1px solid #ccc;z-index:6';
 f.innerHTML='<div><h3 style="margin:8px">Оценка учебных умений</h3><div style="margin:0 8px">'+n+' Иванович · 1 модуль</div></div><div class="sc" style="overflow-y:auto;flex:1"></div><div style="padding:8px"><button class="c">Отмена</button> <button class="s" disabled>Сохранить</button></div>';
 const sc=f.querySelector('.sc'), s=f.querySelector('.s'); const prev=store[n];
 const build=(withPrev)=>{sc.innerHTML='';let g='';Q.forEach(([grp,q],qi)=>{ if(grp!==g){g=grp;const h=document.createElement('div');h.textContent=grp;h.style.cssText='margin:8px;color:#777';sc.append(h);}
   const b=document.createElement('div');b.style.cssText='margin:8px;padding:6px;border:1px solid #eee';
   b.innerHTML='<b>'+q+'</b><br>'+OPTS.map(o=>'<label style="display:block;padding:3px"><span><input type="radio" name="q'+qi+'" value="'+o+'" style="opacity:0;position:absolute"></span><span>'+o+'</span></label>').join('');
   sc.append(b); if(withPrev&&prev) b.querySelector('input[value="'+prev[qi]+'"]').checked=true;});};
 const vals=()=>Q.map((_,qi)=>f.querySelector('input[name=q'+qi+']:checked')?.value||null);
 const upd=()=>{const v=vals();s.disabled=v.some(x=>!x)||JSON.stringify(v)===JSON.stringify(prev||null);};
 build(false); f.addEventListener('change',upd);
 if(O.rerender) setTimeout(()=>{build(true);upd();},O.rerender);
 // «Загрузка данных ученика»: через 0,5 с вопросы сменяются индикатором загрузки
 // на O.reload мс (как будто МЭШ тянет оценки по всем предметам), затем возвращаются.
 if(O.reload) setTimeout(()=>{ sc.innerHTML='<div role="progressbar" class="MuiCircularProgress-root" style="margin:40px">Загрузка…</div>'; s.disabled=true;
   setTimeout(()=>{ build(true); upd(); }, O.reload); }, 500);
 if(O.blink) setTimeout(()=>{ if(!f.isConnected) return; f.remove(); setTimeout(()=>document.body.append(f),500);},2500);
 s.onclick=()=>{ if(s.disabled) return; const v=vals(); window.events.push('save:'+n);
   const once=JSON.parse(localStorage.getItem('failedOnce')||'{}');
   const failNow=O.failSave.includes(n)||(O.failOnce.includes(n)&&!once[n]);
   if(O.failOnce.includes(n)&&!once[n]){once[n]=1;localStorage.setItem('failedOnce',JSON.stringify(once));}
   const finish=()=>{ if(failNow){ const e=document.createElement('div');e.textContent='Ошибка сохранения';f.append(e);s.textContent='Сохранить';return; }
     store[n]=v;persist();closeDrawer(f);};
   if(O.spinner){s.textContent='Сохранение...';s.disabled=true;setTimeout(finish,800);} else finish(); };
 f.querySelector('.c').onclick=()=>{ const any=vals().some(Boolean)&&JSON.stringify(vals())!==JSON.stringify(prev||null);
   if(!O.dialog||!any) return closeDrawer(f);
   const dlg=document.createElement('div');dlg.className='dlg';dlg.style.cssText='position:fixed;left:30%;top:40%;background:#fff;border:2px solid #000;padding:10px;z-index:9';
   dlg.innerHTML='<b>Выход без сохранения</b><p>Данные не будут сохранены</p><button class="back">Назад</button> <button class="go">Выйти без сохранения</button>';
   dlg.querySelector('.back').onclick=()=>dlg.remove(); dlg.querySelector('.go').onclick=()=>{dlg.remove();closeDrawer(f);window.events.push('discard:'+n);}; document.body.append(dlg);};
 document.body.append(f);}
</script>`;
}
module.exports = { journalPage, QUESTIONS };
