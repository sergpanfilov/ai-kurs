/* От модели до агентов — общий движок курса.
   Карта, загрузка уроков из lessons/, записи к заданиям, вход Google и сохранение прогресса.
   Сами уроки сюда не вписываются: план — course.json, содержимое — lessons/NN.html.
   Оформление урока (раздел «оформление урока» ниже) движок делает сам по разметке: свёрнутый хвост, маршрут,
   «Часть k из n», сноски на месте, галочки шагов, кнопка «Скопировать», подсказка у широких таблиц.
   Договор о разметке: docs/review/f-standard.md, раздел 3; описание для авторов: docs/review/f-design.md. */
(function () {
  'use strict';
  var C = window.AI_CONFIG || {};
  var sb = (window.supabase && C.supabaseUrl) ? window.supabase.createClient(C.supabaseUrl, C.supabaseKey) : null;
  var TOTAL = 24; // уточняется по course.json при загрузке

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function plural(n, one, few, many) { var a = n % 10, b = n % 100; return (a === 1 && b !== 11) ? one : (a >= 2 && a <= 4 && (b < 12 || b > 14)) ? few : many; }
  function motionOK() { try { return !matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function safe(fn) { try { fn(); } catch (e) { if (window.console) console.warn('оформление урока: ' + e.message); } }
  // полоса прогресса: по делению на урок, промежутки между модулями; cur — номер текущего урока (обводка)
  function pbar(box, course, isDone, links, cur) {
    box.textContent = '';
    course.modules.forEach(function (m, i) {
      var g = el('div', 'pseg-group'); g.setAttribute('data-m', 'М' + (i + 1));
      m.lessons.forEach(function (L) {
        var cls = 'pseg' + (isDone(L.n) ? ' done' : (L.file ? ' open' : '')) + (cur === L.n ? ' cur' : ''), s;
        if (links && L.file) { s = el('a', cls); s.href = '#lesson-' + L.n; } else s = el('span', cls);
        s.title = 'Урок ' + L.n + ': ' + L.title; s.setAttribute('aria-label', s.title);
        g.appendChild(s);
      });
      g.style.flexGrow = m.lessons.length;
      box.appendChild(g);
    });
  }
  window.AI = { $: $, el: el, pbar: pbar, plural: plural };

  // ---------- состояние ----------
  // lessons[n] = {done, right, total, best, attempts, answers, at};  notes[n] = {task, step, at}
  var user = null, adult = false, course = null, lessonToken = 0;
  var st = fresh();
  function fresh() { return { lessons: {}, notes: {} }; }
  function key() { return 'aicourse-v2:' + (user ? user.id : 'guest'); }
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function loadLocal() {
    var s = lsGet(key());
    if (s && s.lessons) return s;
    s = fresh();
    if (!user) { // перенос из прототипа (он хранил только отметки «пройден»)
      var o = lsGet('aicourse-v1');
      if (o && o.done) for (var k in o.done) s.lessons[k] = { done: true };
    }
    return s;
  }
  function saveLocal() { lsSet(key(), st); }
  function doneCount() { var k = 0; for (var n in st.lessons) if (st.lessons[n].done) k++; return k; }
  function updNote() { $('pnote').textContent = 'пройдено ' + doneCount() + ' из ' + TOTAL; }

  // ---------- сервер ----------
  var online = function () { return !!(sb && user && adult); };
  async function pushLesson(n) {
    if (!online()) return;
    var L = st.lessons[n];
    var r = await sb.from('ai_progress').upsert({
      user_id: user.id, lesson: +n, done: !!L.done, quiz_right: L.right == null ? null : L.right,
      quiz_total: L.total == null ? null : L.total, best_right: L.best == null ? null : L.best,
      attempts: L.attempts || 0, answers: L.answers || null, updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,lesson' });
    if (r.error) showNotice('Не удалось сохранить прогресс в аккаунте: ' + r.error.message + '. В этом браузере он сохранён.');
  }
  async function pushNote(n) {
    if (!online()) return true;
    var N = st.notes[n];
    var r = await sb.from('ai_notes').upsert({ user_id: user.id, lesson: +n, task: N.task || '', step: N.step || '', updated_at: new Date().toISOString() },
      { onConflict: 'user_id,lesson' });
    return !r.error;
  }
  async function pull() {
    var p = await sb.from('ai_progress').select('lesson,done,quiz_right,quiz_total,best_right,attempts,answers,updated_at').eq('user_id', user.id);
    var q = await sb.from('ai_notes').select('lesson,task,step,updated_at').eq('user_id', user.id);
    if (p.error || q.error) { showNotice('Не удалось загрузить прогресс из аккаунта. Показан прогресс из этого браузера.'); return; }
    // что новее — то и остаётся; более новое из браузера отправляется на сервер
    var t = function (x) { return x ? Date.parse(x) : 0; }, srvL = {}, srvN = {};
    p.data.forEach(function (r) {
      srvL[r.lesson] = t(r.updated_at);
      var loc = st.lessons[r.lesson];
      if (loc && t(loc.at) > srvL[r.lesson]) return;
      st.lessons[r.lesson] = { done: r.done, right: r.quiz_right, total: r.quiz_total, best: r.best_right, attempts: r.attempts, answers: r.answers, at: r.updated_at };
    });
    q.data.forEach(function (r) {
      srvN[r.lesson] = t(r.updated_at);
      var loc = st.notes[r.lesson];
      if (loc && t(loc.at) > srvN[r.lesson]) return;
      st.notes[r.lesson] = { task: r.task, step: r.step, at: r.updated_at };
    });
    saveLocal();
    for (var n in st.lessons) if (!(n in srvL) || t(st.lessons[n].at) > srvL[n]) await pushLesson(n);
    for (var m in st.notes) if (!(m in srvN) || t(st.notes[m].at) > srvN[m]) await pushNote(m);
  }

  // ---------- вход ----------
  function showNotice(t) { var b = $('notice'); b.textContent = t; b.hidden = !t; }
  function renderAuth() {
    var a = $('authBtn'), w = $('who');
    if (!sb) { a.hidden = true; return; }
    a.hidden = false;
    if (user) {
      var nm = (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name)) || user.email;
      w.textContent = nm.split(' ')[0]; w.hidden = false; a.textContent = 'Выйти';
    } else { w.hidden = true; a.textContent = 'Войти'; }
    $('storeNote').textContent = online()
      ? 'Прогресс и ваши записи сохраняются в аккаунте и видны на всех ваших устройствах.'
      : (user ? 'Прогресс хранится в этом браузере.' : 'Прогресс хранится в этом браузере. Войдите через Google, чтобы он сохранялся в аккаунте и был виден на других устройствах.');
    $('progLink').hidden = !online();
  }
  async function login() {
    try { sessionStorage.setItem('aicourse-back', location.hash); } catch (e) {}
    await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
  }
  async function onUser(u) {
    if ((u ? u.id : null) === (user ? user.id : null)) return;
    user = u || null; adult = false; showNotice('');
    var guest = lsGet('aicourse-v2:guest');
    st = loadLocal();
    if (user) {
      var f = await sb.rpc('ai_is_adult');
      adult = f.data === true;
      if (!adult) showNotice('Вы вошли как ' + user.email + '. Сохранять прогресс в аккаунте могут только взрослые члены семьи. Курс открыт, прогресс останется в этом браузере.');
      else {
        // то, что успели пройти до входа, переносим в аккаунт
        if (guest) {
          for (var n in guest.lessons) if (guest.lessons[n].done && !(st.lessons[n] && st.lessons[n].done)) st.lessons[n] = guest.lessons[n];
          for (var m in guest.notes) if (!st.notes[m]) st.notes[m] = guest.notes[m];
        }
        await pull();
      }
      saveLocal();
    }
    renderAuth(); updNote(); route(true);
  }

  // ---------- карта ----------
  function lessons() { var a = []; course.modules.forEach(function (m, i) { m.lessons.forEach(function (l) { l.module = i + 1; a.push(l); }); }); return a; }
  function info(n) { return lessons().filter(function (l) { return l.n === n; })[0]; }
  function isDone(n) { return !!(st.lessons[n] && st.lessons[n].done); }
  function nextLesson() { return lessons().filter(function (l) { return l.file && !isDone(l.n); })[0] || null; }
  function renderMap() {
    var bar = $('pbar'); AI.pbar(bar, course, isDone, true); bar.classList.add('has-labels');
    var all = lessons(), done = doneCount(), nx = nextLesson();
    var soon = $('legSoon'); if (soon) soon.hidden = all.every(function (l) { return l.file; });
    // «с чего продолжить»
    var rs = $('resume'), go = $('resumeGo');
    if (rs && go) {
      rs.textContent = ''; go.textContent = '';
      rs.appendChild(el('span', 'resume-count', done ? 'Пройдено ' + done + ' из ' + TOTAL : 'Курс ещё не начат'));
      rs.appendChild(el('span', 'progress-note', TOTAL + ' ' + plural(TOTAL, 'урок', 'урока', 'уроков') + ' · ' + course.modules.length + ' модулей'));
      if (nx) {
        var a = el('a', 'btn primary next-big'); a.href = '#lesson-' + nx.n;
        a.appendChild(el('small', null, done ? 'Продолжить' : 'Начать'));
        a.appendChild(document.createTextNode('Урок ' + nx.n + ' — ' + nx.title + ' →'));
        go.appendChild(a);
      } else go.appendChild(el('p', null, 'Все уроки отмечены пройденными. Любой можно открыть снова.'));
    }
    var m = $('modules'); m.textContent = '';
    course.modules.forEach(function (md, i) {
      var k = md.lessons.filter(function (L) { return isDone(L.n); }).length, first = md.lessons[0].n, last = md.lessons[md.lessons.length - 1].n;
      var d = el('section', 'module' + (k === md.lessons.length ? ' is-done' : '')), hd = el('div', 'module-head');
      hd.appendChild(el('span', 'eyebrow', 'Модуль ' + (i + 1) + ' · уроки ' + first + '–' + last));
      hd.appendChild(el('span', 'module-count', k === md.lessons.length ? 'пройден ✓' : k + ' из ' + md.lessons.length));
      d.appendChild(hd); d.appendChild(el('h2', null, md.title));
      var ol = el('ol');
      md.lessons.forEach(function (L) {
        var dn = isDone(L.n), isNext = nx && nx.n === L.n;
        var li = el('li', L.file ? (dn ? 'done' : 'open') + (isNext ? ' next' : '') : 'soon');
        var row = L.file ? el('a') : el('span', 'soon-row');
        if (L.file) row.href = '#lesson-' + L.n;
        row.appendChild(el('span', 'n', String(L.n))); row.appendChild(el('span', 't', L.title));
        row.appendChild(el('span', 'st', dn ? 'пройден ✓' : (!L.file ? 'готовится' : (isNext ? (done ? 'продолжить →' : 'начать →') : ''))));
        li.appendChild(row); ol.appendChild(li);
      });
      d.appendChild(ol); m.appendChild(d);
    });
    updNote();
  }

  // ---------- урок ----------
  function navLabel(L) { return 'Урок ' + L.n + ': ' + (L.nav || L.title); }
  var curLesson = null, scrollMem = {}, navByClick = false, lessonRO = null;
  async function showLesson(n) {
    var L = info(n), box = $('v-lesson'), tok = ++lessonToken;
    var backY = (!navByClick && scrollMem[n] != null) ? scrollMem[n] : 0; navByClick = false;
    $('v-map').hidden = true; box.hidden = false; curLesson = n;
    box.textContent = ''; box.appendChild(el('p', 'loading', 'Загружаю урок…'));
    window.scrollTo(0, 0);
    var html;
    try {
      var r = await fetch('lessons/' + L.file, { cache: 'no-cache' });
      if (!r.ok) throw new Error(r.status);
      html = await r.text();
    } catch (e) { if (tok === lessonToken) box.querySelector('.loading').textContent = 'Не удалось загрузить урок. Проверьте связь и обновите страницу.'; return; }
    if (tok !== lessonToken) return;
    box.innerHTML = html;
    document.title = L.title + ' · От модели до агентов';
    if (lessonRO) lessonRO.disconnect();
    var tail = null;
    safe(function () { footnotes(box); });
    safe(function () { xrefs(n, box); });
    safe(function () { tail = buildTail(box); });
    safe(function () { markPanels(n, box); });
    safe(function () { steps(n, box); });
    safe(function () { prompts(box); });
    box.querySelectorAll('[data-note]').forEach(function (p) { addNote(n, p, p.getAttribute('data-note')); });
    // интерактивы урока: скрипты, вставленные через innerHTML, браузер не выполняет — пересоздаём
    box.querySelectorAll('script:not([type="application/json"])').forEach(function (s) {
      var x = document.createElement('script'); x.textContent = s.textContent; s.replaceWith(x);
    });
    // отметка «пройден» (тестов в курсе нет с 10.11.2026 — решение Сержа)
    box.appendChild(doneBlock(n));
    // справочная часть — после отметки, свёрнута
    if (tail) box.appendChild(tail);
    // переход к соседним урокам
    var all = lessons(), i = all.indexOf(L), prev = all[i - 1], next = all[i + 1];
    var nav = el('div', 'lesson-nav'), a;
    if (prev && prev.file) { a = el('a', 'btn', '← Урок ' + prev.n); a.href = '#lesson-' + prev.n; }
    else { a = el('a', 'btn', 'К карте курса'); a.href = '#map'; }
    nav.appendChild(a);
    if (next && next.file) { a = el('a', 'btn primary', navLabel(next)); a.href = '#lesson-' + next.n; }
    else { a = el('a', 'btn primary', 'К карте курса'); a.href = '#map'; }
    nav.appendChild(a);
    box.appendChild(nav);
    safe(function () { routeMap(box); });
    safe(function () { decorate(box, true); });
    if (backY) window.scrollTo(0, backY);
    readProgress();
  }

  // ---------- оформление урока (договор о разметке: docs/review/f-standard.md, раздел 3) ----------
  function label(p) { var e = p.querySelector('.eyebrow, .lbl'); return e ? e.textContent.replace(/\s+/g, ' ').trim() : ''; }

  // А4. Сноски: номер в тексте раскрывает пояснение прямо под абзацем (без переходов по #, их занимает маршрутизатор)
  function footnotes(box) {
    var fnText = {};
    box.querySelectorAll('.footnotes li[data-fn]').forEach(function (li) { fnText[li.getAttribute('data-fn')] = li.innerHTML; });
    box.querySelectorAll('sup.fn[data-fn]').forEach(function (s) {
      var id = s.getAttribute('data-fn'), pop = null;
      s.setAttribute('role', 'button'); s.tabIndex = 0; s.setAttribute('aria-expanded', 'false');
      s.title = 'Сноска ' + id; s.setAttribute('aria-label', 'Сноска ' + id);
      function close() { if (pop) { pop.remove(); pop = null; } s.setAttribute('aria-expanded', 'false'); }
      function toggle() {
        if (pop) { close(); return; }
        pop = el('span', 'fn-pop'); pop.setAttribute('role', 'note');
        pop.innerHTML = '<b>' + id + '.</b> ' + (fnText[id] || '');
        var x = el('button', 'fn-x', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Закрыть сноску ' + id);
        x.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); close(); s.focus({ preventScroll: true }); });
        pop.appendChild(x);
        pop.addEventListener('click', function (e) { e.stopPropagation(); });
        var host = s.closest('p, li, td, th, figcaption, .callout, summary');
        if (!host) s.after(pop);
        else if (/^(LI|TD|TH)$/.test(host.tagName)) (host.querySelector(':scope > .step-body') || host).appendChild(pop);
        else { // под абзацем; вторая сноска того же абзаца — под первой
          if (host.tagName === 'SUMMARY') host = host.parentElement.lastElementChild;
          var at = host; while (at.nextElementSibling && at.nextElementSibling.classList.contains('fn-pop')) at = at.nextElementSibling;
          at.after(pop);
        }
        s.setAttribute('aria-expanded', 'true');
      }
      s.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); toggle(); });
      s.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } else if (e.key === 'Escape') close(); });
    });
  }

  // А7. Отсылки «урок N» — ссылка с названием урока в подсказке
  function xrefs(n, box) {
    var skip = 'a, button, summary, label, script, style, svg, textarea, select, h1, .eyebrow, .lbl, .footnotes';
    var re = /([Уу]рок(?:а|у|е|ом)?)([  ])(\d{1,2})(?![\d])/g, nodes = [], w = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, null), t;
    while ((t = w.nextNode())) if (t.nodeValue.indexOf('рок') > 0 && !t.parentElement.closest(skip)) nodes.push(t);
    nodes.forEach(function (node) {
      var txt = node.nodeValue, out = [], last = 0, m; re.lastIndex = 0;
      while ((m = re.exec(txt))) {
        var k = +m[3], T = info(k), before = txt.charAt(m.index - 1), after = txt.slice(re.lastIndex, re.lastIndex + 6);
        if (!T || !T.file || k === n || /[А-Яа-яЁё]/.test(before) || /^\s*(из\s|[–—-]\s*\d|,\s*\d|и\s+\d)/.test(after)) continue;
        if (m.index > last) out.push(document.createTextNode(txt.slice(last, m.index)));
        var a = el('a', 'xref', m[0]); a.href = '#lesson-' + k; a.title = 'Урок ' + k + ': ' + T.title;
        out.push(a); last = re.lastIndex;
      }
      if (!out.length) return;
      if (last < txt.length) out.push(document.createTextNode(txt.slice(last)));
      var f = document.createDocumentFragment(); out.forEach(function (x) { f.appendChild(x); });
      node.parentNode.replaceChild(f, node);
    });
  }

  // А1. Хвост: словарик, сноски, частые вопросы, «Куда двигаться дальше» — в конец урока, свёрнуты, со счётчиком
  function buildTail(box) {
    function byLabel(re) {
      return [].filter.call(box.querySelectorAll('.panel, .callout'), function (p) { return !p.matches('details') && !p.closest('details') && re.test(label(p)); })[0] || null;
    }
    function fold(src, cls, title, cnt, strip) {
      var d = el('details', 'panel tail-item ' + cls), s = el('summary'), body = el('div', 'tail-body');
      s.appendChild(el('span', 'eyebrow', title)); if (cnt) s.appendChild(el('span', 'tail-cnt', cnt));
      d.appendChild(s);
      var lab = src.querySelector(':scope > .eyebrow, :scope > .lbl'); if (lab && strip !== false) lab.remove();
      while (src.firstChild) body.appendChild(src.firstChild);
      if (src.id) d.id = src.id;
      src.remove(); d.appendChild(body);
      return d;
    }
    var items = [], g, ol, f, dp, k;
    g = box.querySelector('.panel.glossary:not(details)') || byLabel(/^Словарик/i);
    if (g) {
      k = [].filter.call(g.querySelectorAll('tr'), function (r) { return r.querySelector('td'); }).length || g.querySelectorAll('dt').length;
      items.push(fold(g, 'glossary', 'Словарик урока', k ? k + ' ' + plural(k, 'слово', 'слова', 'слов') : ''));
    }
    ol = box.querySelector('ol.footnotes');
    if (ol && !ol.closest('details')) {
      var wrap = ol.parentElement, own = wrap !== box && [].every.call(wrap.children, function (c) { return c === ol || c.matches('.eyebrow'); });
      if (!own) { wrap = el('div'); ol.before(wrap); wrap.appendChild(ol); }
      k = ol.querySelectorAll('li').length;
      items.push(fold(wrap, 'notes', 'Сноски и источники', String(k)));
    }
    f = box.querySelector('.faq:not(details)') || byLabel(/^Частые вопросы/i);
    if (f && !f.closest('.tail-body')) {
      k = [].filter.call(f.querySelectorAll('b, strong, h3, dt'), function (b) { return /\?\s*$/.test(b.textContent); }).length;
      items.push(fold(f, 'faq', 'Частые вопросы', k ? String(k) : ''));
    }
    dp = box.querySelector('.panel.deeper:not(details)') || byLabel(/^(Куда двигаться дальше|Разобраться глубже)/i);
    if (dp) {
      k = dp.querySelectorAll('ul.links > li').length || dp.querySelectorAll('a[href^="http"]').length;
      items.push(fold(dp, 'deeper', label(dp) || 'Куда двигаться дальше', (k ? k + ' ' + plural(k, 'материал', 'материала', 'материалов') + ' · ' : '') + 'по желанию'));
    }
    if (!items.length) return null;
    var tail = el('section', 'tail'); tail.setAttribute('aria-label', 'Справочная часть урока');
    tail.appendChild(el('p', 'tail-h', 'Справочная часть · раскрывается по нажатию'));
    items.forEach(function (d) { tail.appendChild(d); });
    return tail;
  }

  // Опорные блоки получают класс по шапочке; у задания и шага — шапка с временем и счётчиком дел
  function stepTime(p) {
    var t = p.getAttribute('data-time'); if (t) return t.trim();
    // прежняя разметка: первая строка шага «Время: ≈ 15 минут.» (жирным или мелкой строкой)
    var m = null;
    [].some.call(p.querySelectorAll(':scope > p > b:first-child, :scope > p.why'), function (e) { m = /^\s*Время:\s*([^.]+)/i.exec(e.textContent); return !!m; });
    return m ? m[1].trim() : '';
  }
  function markPanels(n, box) {
    box.querySelectorAll('.panel').forEach(function (p) {
      if (p.closest('.tail')) return;
      var t = label(p), eb = p.querySelector(':scope > .eyebrow');
      if (/^Попробуйте сами/i.test(t)) p.classList.add('is-try');
      else if (/^Главное/i.test(t)) p.classList.add('is-key');
      else if (/^(Биотехнология|Свои проекты)/i.test(t)) p.classList.add('is-example');
      var isStep = /^Сквозной проект/i.test(t), isTask = p.classList.contains('task');
      if (isStep) p.classList.add('is-step');
      if ((isStep || isTask) && eb) {
        var hd = el('div', 'panel-head'); eb.before(hd); hd.appendChild(eb);
        if (p.hasAttribute('data-time')) { var tm = el('span', 'panel-time', p.getAttribute('data-time')); tm.title = 'Время на шаг проекта — отдельно от времени урока'; hd.appendChild(tm); }
        if (p.querySelector('ol.steps')) hd.appendChild(el('span', 'panel-meta steps-count'));
      }
    });
  }

  // ol.steps — список дел с галочками; отметки помнит этот браузер
  function stepsKey() { return key() + ':steps'; }
  function steps(n, box) {
    var mem = lsGet(stepsKey()) || {}, mine = mem[n] || {}, idx = 0;
    box.querySelectorAll('ol.steps').forEach(function (ol) {
      // нумерация сквозная в пределах панели: второй и третий список шага продолжают счёт (start в разметке — приоритетнее)
      var panel = ol.closest('.panel'), kind = (panel && panel.getAttribute('data-note')) || 'text';
      var num = +ol.getAttribute('start') || (panel && panel._stepNext) || 1;
      ol.classList.add('is-live');
      [].forEach.call(ol.children, function (li) {
        if (li.tagName !== 'LI') return;
        var id = kind + ':' + (idx++), k = num++, body = el('div', 'step-body'), lab = el('label', 'step-check'), cb = el('input'), face = el('span', null, String(k));
        while (li.firstChild) body.appendChild(li.firstChild);
        cb.type = 'checkbox'; cb.checked = !!mine[id]; cb.setAttribute('aria-label', 'Пункт ' + k + ' сделан'); face.setAttribute('aria-hidden', 'true');
        lab.appendChild(cb); lab.appendChild(face); li.appendChild(lab); li.appendChild(body);
        if (panel) panel._stepNext = num;
        li.classList.toggle('is-done', cb.checked);
        cb.addEventListener('change', function () {
          var all = lsGet(stepsKey()) || {}, cur = all[n] || (all[n] = {});
          if (cb.checked) cur[id] = 1; else delete cur[id];
          lsSet(stepsKey(), all); li.classList.toggle('is-done', cb.checked); count(panel);
        });
      });
      count(panel);
    });
    function count(panel) {
      var c = panel && panel.querySelector('.steps-count'); if (!c) return;
      var all = panel.querySelectorAll('.step-check input'), on = panel.querySelectorAll('.step-check input:checked').length;
      c.textContent = on === all.length ? 'сделано всё ✓' : 'сделано ' + on + ' из ' + all.length;
    }
  }

  // blockquote.prompt — запрос для агента с кнопкой «Скопировать» (подпись кнопки — в стилях)
  function copyText(t) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t);
    return new Promise(function (ok, no) {
      var ta = el('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta); ta.select();
      var done = false; try { done = document.execCommand('copy'); } catch (e) {}
      ta.remove(); if (done) ok(); else no();
    });
  }
  function prompts(box) {
    box.querySelectorAll('blockquote.prompt').forEach(function (q) {
      if (q.querySelector('.copy')) return;
      var b = el('button', 'copy'); b.type = 'button'; b.setAttribute('aria-label', 'Скопировать запрос'); var t = null;
      b.addEventListener('click', function () {
        var c = q.cloneNode(true); c.querySelectorAll('.copy, .fn, .fn-pop').forEach(function (x) { x.remove(); });
        var txt = (c.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/^\s+|\s+$/g, '');
        function show(cls) { b.classList.remove('is-ok', 'is-fail'); b.classList.add(cls); clearTimeout(t); t = setTimeout(function () { b.classList.remove(cls); }, 2500); }
        copyText(txt).then(function () { show('is-ok'); }, function () {
          show('is-fail'); try { var r = document.createRange(); r.selectNodeContents(q); var s = getSelection(); s.removeAllRanges(); s.addRange(r); } catch (e) {}
        });
      });
      if (!q.hasAttribute('data-label')) q.setAttribute('data-label', 'Запрос');   // подпись рамки; своя — data-label="ТЗ для файла"
      q.classList.add('is-live'); q.appendChild(b);
    });
  }

  // А2, А3. Маршрут урока под .lead и «Часть k из n» над каждым разделом
  function routeMap(box) {
    var lead = box.querySelector('.lead'), head = box.querySelector('.eyebrow'); if (!lead || !head) return;
    function inTail(e) { return !!e.closest('.tail'); }
    function go(target) {
      return function () {
        target.scrollIntoView({ behavior: motionOK() ? 'smooth' : 'auto', block: 'start' });
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        try { target.focus({ preventScroll: true }); } catch (e) {}
      };
    }
    var h2s = [].filter.call(box.querySelectorAll('h2'), function (h) { return !inTail(h); });
    if (h2s.length > 1) h2s.forEach(function (h, i) { h.setAttribute('data-part', 'Часть ' + (i + 1) + ' из ' + h2s.length); });
    var panels = [].filter.call(box.querySelectorAll('.panel'), function (p) { return !inTail(p); });
    var task = panels.filter(function (p) { return p.classList.contains('task'); })[0], step = panels.filter(function (p) { return p.classList.contains('is-step'); })[0];
    var nav = el('nav', 'route'); nav.setAttribute('aria-label', 'Маршрут урока');
    nav.appendChild(el('span', 'route-h', 'Маршрут урока'));
    // честное время: чтение и интерактив — из шапки, задание — из шапочки, шаг проекта — data-time
    var tl = el('div', 'route-time'), m = /(\d+)\s*минут/.exec(head.textContent), c;
    function chip(tag, name, val) { var e = el(tag); if (tag === 'button') e.type = 'button'; e.appendChild(document.createTextNode(name + ' ')); if (val) e.appendChild(el('b', null, val)); tl.appendChild(e); return e; }
    if (m) chip('span', 'Чтение и интерактив', '≈ ' + m[1] + ' мин');
    if (task) { m = /(\d+)\s*минут/.exec(label(task)); c = chip('button', 'Задание', m ? m[1] + ' мин' : ''); c.addEventListener('click', go(task)); }
    if (step) { var tm = stepTime(step); c = chip('button', 'Шаг проекта', tm ? tm + ' · отдельно' : 'отдельно'); c.addEventListener('click', go(step)); }
    if (tl.children.length) nav.appendChild(tl);
    // разделы по порядку; «Попробуйте сами» и «Главное» — без номера
    var list = el('ol', 'route-list'), k = 0;
    [].forEach.call(box.querySelectorAll('h2, .panel.is-try, .panel.is-key'), function (e) {
      if (inTail(e)) return;
      var aux = e.tagName !== 'H2', name = aux ? label(e) : e.textContent.replace(/\s+/g, ' ').trim();
      if (aux && e.classList.contains('is-try')) { var pv = e.previousElementSibling; if (pv && pv.tagName === 'H2') return; }   // у интерактива свой раздел
      var li = el('li', aux ? 'is-aux' : ''), b = el('button'); b.type = 'button';
      b.appendChild(el('span', 'route-k', aux ? (e.classList.contains('is-key') ? '✓' : '→') : String(++k)));
      b.appendChild(el('span', null, name)); b.addEventListener('click', go(e));
      li.appendChild(b); list.appendChild(li);
    });
    if (list.children.length) nav.appendChild(list);
    lead.after(nav);
  }

  // А6 и таблицы-карточки: подписи столбцов для телефона, словарик, подсказка «листается вбок»
  function decorate(root, isLesson) {
    root.querySelectorAll('table').forEach(function (t) {
      var rows = [].slice.call(t.rows); if (!rows.length) return;
      if (t.closest('.glossary') && !t.classList.contains('cards')) t.classList.add(rows[0].cells.length > 2 ? 'cards' : 'gloss');
      if (!t.classList.contains('cards')) return;
      var hr = rows.filter(function (r) { return r.cells.length && [].every.call(r.cells, function (c) { return c.tagName === 'TH'; }); })[0]; if (!hr) return;
      hr.classList.add('cards-head');
      var names = [].map.call(hr.cells, function (c) { return c.textContent.replace(/\s+/g, ' ').trim(); });
      rows.forEach(function (r) { if (r !== hr) [].forEach.call(r.cells, function (c, i) { if (names[i] && !c.hasAttribute('data-label')) c.setAttribute('data-label', names[i]); }); });
    });
    var ro = null;
    function check(sc) {
      var can = sc.scrollWidth > sc.clientWidth + 4;
      sc.classList.toggle('can-scroll', can);
      sc.classList.toggle('at-end', can && sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - 4);
      if (can) { sc.tabIndex = 0; sc.setAttribute('role', 'region'); sc.setAttribute('aria-label', 'Широкая таблица: листается вбок'); }
      else { sc.removeAttribute('tabindex'); sc.removeAttribute('role'); sc.removeAttribute('aria-label'); }
    }
    if (window.ResizeObserver) { ro = new ResizeObserver(function (es) { es.forEach(function (e) { check(e.target); }); }); if (isLesson) lessonRO = ro; }
    root.querySelectorAll('.scroll').forEach(function (sc) {
      if (!sc.querySelector(':scope > .scroll-hint')) { var h = el('span', 'scroll-hint'); h.setAttribute('aria-hidden', 'true'); sc.insertBefore(h, sc.firstChild); }
      sc.addEventListener('scroll', function () { check(sc); }, { passive: true });
      if (ro) ro.observe(sc); check(sc);
    });
  }
  // докрутить к только что показанному разбору, если он ушёл за нижний край экрана
  window.AI.reveal = function (e) {
    if (!e || !e.getBoundingClientRect) return;
    var r = e.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 16 || r.top < 0) e.scrollIntoView({ behavior: motionOK() ? 'smooth' : 'auto', block: r.height > window.innerHeight * .8 ? 'start' : 'nearest' });
  };
  window.AI.refresh = function () { var b = $('v-lesson'); if (!b.hidden) safe(function () { prompts(b); decorate(b, false); }); };

  // А3. Полоска чтения (до кнопки «пройден»; справочная часть не считается) и кнопка «наверх»
  var readBar = null, topBtn = null, ticking = false, lastY = 0;
  function readProgress() {
    ticking = false;
    if (!readBar) return;
    var box = $('v-lesson'), on = !box.hidden, end = on && box.querySelector('.done-panel');
    // кнопка «наверх» — только когда ученик сам листает вверх: при чтении вниз она не закрывает край содержимого
    var y = window.scrollY, up = y < lastY - 2, down = y > lastY + 2; lastY = y;
    if (!end || y < window.innerHeight * 1.5) topBtn.hidden = true;
    else if (up) topBtn.hidden = false;
    else if (down) topBtn.hidden = true;
    readBar.hidden = !end;
    if (!end) return;
    var max = end.getBoundingClientRect().bottom + window.scrollY - window.innerHeight;
    var pct = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 1;
    readBar.firstChild.style.width = (pct * 100).toFixed(1) + '%';
    readBar.setAttribute('aria-valuenow', Math.round(pct * 100));
  }
  function initChrome() {
    readBar = el('div'); readBar.id = 'readbar'; readBar.hidden = true; readBar.appendChild(el('i'));
    readBar.setAttribute('role', 'progressbar'); readBar.setAttribute('aria-label', 'Прочитано в уроке'); readBar.setAttribute('aria-valuemin', '0'); readBar.setAttribute('aria-valuemax', '100');
    topBtn = el('button', null, '↑'); topBtn.id = 'totop'; topBtn.type = 'button'; topBtn.hidden = true;
    topBtn.title = 'Наверх, к маршруту урока'; topBtn.setAttribute('aria-label', 'Наверх, к маршруту урока');
    topBtn.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: motionOK() ? 'smooth' : 'auto' }); });
    document.body.appendChild(readBar); document.body.appendChild(topBtn);
    function tick() { if (!ticking) { ticking = true; requestAnimationFrame(readProgress); } }
    window.addEventListener('scroll', tick, { passive: true }); window.addEventListener('resize', tick);
    // при печати свёрнутые блоки раскрываются
    var reopened = [];
    window.addEventListener('beforeprint', function () { reopened = [].filter.call(document.querySelectorAll('details:not([open])'), function (d) { d.open = true; return true; }); });
    window.addEventListener('afterprint', function () { reopened.forEach(function (d) { d.open = false; }); reopened = []; });
    document.addEventListener('click', function (e) { var a = e.target.closest && e.target.closest('a[href^="#"]'); if (a) navByClick = true; }, true);
  }

  // А5. Отметка «пройден»: «Пройдено N из 31» и крупная ссылка на следующий урок
  function doneBlock(n) {
    var p = el('div', 'panel done-panel'), row = el('div', 'row'), b = el('button', 'primary'), note = el('span', 'progress-note'), more = el('div', 'done-more');
    b.type = 'button';
    function draw() {
      var S = st.lessons[n], done = !!(S && S.done);
      p.classList.toggle('is-done', done); more.textContent = ''; more.hidden = !done;
      if (!done) { b.textContent = 'Отметить урок пройденным'; b.className = 'primary'; note.textContent = 'Прочитали, сделали задание и шаг проекта — отметьте.'; return; }
      b.textContent = 'Снять отметку'; b.className = 'small'; note.textContent = 'Урок пройден' + (S.at ? ' ' + fmtDate(S.at) : '') + '.';
      var k = doneCount(), all = lessons(), nx = all[all.indexOf(info(n)) + 1], bar = el('div', 'pbar');
      more.appendChild(el('p', 'done-count', k >= TOTAL ? 'Пройдены все ' + TOTAL + ' ' + plural(TOTAL, 'урок', 'урока', 'уроков') : 'Пройдено ' + k + ' из ' + TOTAL));
      pbar(bar, course, isDone, false, n); more.appendChild(bar);
      var a = el('a', 'btn primary next-big');
      if (nx && nx.file) { a.href = '#lesson-' + nx.n; a.appendChild(el('small', null, 'Дальше')); a.appendChild(document.createTextNode('Урок ' + nx.n + ' — ' + nx.title + ' →')); }
      else { a.href = '#map'; a.appendChild(el('small', null, nx ? 'Дальше' : 'Последний урок курса')); a.appendChild(document.createTextNode('К карте курса →')); }
      more.appendChild(a);
    }
    b.addEventListener('click', function () {
      var S = st.lessons[n] || {};
      st.lessons[n] = { done: !S.done, at: new Date().toISOString() };
      saveLocal(); updNote(); pushLesson(n); draw();
      p.classList.toggle('just-done', !S.done); readProgress();
    });
    row.appendChild(b); row.appendChild(note); p.appendChild(row); p.appendChild(more); draw();
    return p;
  }
  function fmtDate(s) { try { return new Date(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }); } catch (e) { return ''; } }
  function renderQuiz(n, box, qs) {
    var answered = 0, right = 0, answers = [];
    var S = st.lessons[n];
    if (S && S.done && S.total) box.appendChild(el('p', 'prev-result', 'Вы уже проходили тест' + (S.at ? ' ' + fmtDate(S.at) : '') + ': ' + S.right + ' из ' + S.total + '. Можно пройти ещё раз.'));
    var res = el('p', 'out');
    qs.forEach(function (q, qi) {
      var d = el('div', 'q'); d.appendChild(el('p', null, (qi + 1) + '. ' + q.q));
      var o = el('div', 'opts'), why = el('p', 'why'); why.hidden = true;
      q.options.forEach(function (t, oi) {
        var b = el('button', null, t); b.type = 'button';
        b.addEventListener('click', function () {
          Array.prototype.forEach.call(o.children, function (x) { x.disabled = true; });
          o.children[q.answer].classList.add('right');
          if (oi !== q.answer) b.classList.add('wrong'); else right++;
          why.textContent = (oi === q.answer ? 'Верно. ' : 'Не совсем. ') + q.why; why.hidden = false;
          answers[qi] = oi; answered++;
          if (answered === qs.length) {
            var prev = st.lessons[n] || {};
            st.lessons[n] = { done: true, right: right, total: qs.length, best: Math.max(prev.best || 0, right), attempts: (prev.attempts || 0) + 1, answers: answers, at: new Date().toISOString() };
            saveLocal(); updNote(); pushLesson(n);
            res.textContent = 'Результат: ' + right + ' из ' + qs.length + '. Урок отмечен как пройденный.';
          }
        });
        o.appendChild(b);
      });
      d.appendChild(o); d.appendChild(why); box.appendChild(d);
    });
    box.appendChild(res);
  }

  // А8. Поля записи: подпись «сохранено…» видна сразу, если запись уже есть; поле растёт по тексту
  function autogrow(ta) {
    function fit() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, Math.round(window.innerHeight * .7)) + 'px'; }
    ta.addEventListener('input', fit); requestAnimationFrame(fit);
  }
  window.AI.autogrow = autogrow;
  function addNote(n, panel, kind) {
    var wrap = el('label', 'note'); wrap.appendChild(el('span', 'eyebrow', kind === 'task' ? 'Ваша запись к заданию' : 'Ваша запись к шагу проекта'));
    var ta = el('textarea'); ta.rows = 4; ta.placeholder = kind === 'task' ? 'Что вы сделали и что заметили' : 'Ваш результат для проекта';
    var N = st.notes[n] || {}; ta.value = N[kind] || '';
    var stt = el('span', 'why'), t = null;
    function where() { return online() ? 'сохранено в аккаунте' : 'сохранено в этом браузере'; }
    if (ta.value) stt.textContent = where() + (N.at ? ' · ' + fmtDate(N.at) : '');
    ta.addEventListener('input', function () {
      stt.textContent = '…';
      clearTimeout(t);
      t = setTimeout(async function () {
        var cur = st.notes[n] || (st.notes[n] = {});
        cur[kind] = ta.value; cur.at = new Date().toISOString(); saveLocal();
        var ok = await pushNote(n);
        stt.textContent = !ok ? 'сохранено в этом браузере, в аккаунт не ушло' : where();
      }, 700);
    });
    wrap.appendChild(ta); wrap.appendChild(stt); panel.appendChild(wrap); autogrow(ta);
  }

  // ---------- маршрут ----------
  function route(keepScroll) {
    if (!course) return;
    var h = location.hash.slice(1);
    if (/^(access_token|error|refresh_token)/.test(h)) return;
    var m = /^lesson-(\d+)$/.exec(h), L = m && info(+m[1]);
    if (L && L.file) { if (keepScroll !== true || $('v-lesson').hidden) showLesson(L.n); return; }
    lessonToken++; curLesson = null; navByClick = false;
    $('v-lesson').hidden = true; $('v-map').hidden = false;
    document.title = 'От модели до агентов';
    renderMap();
    if (keepScroll !== true) window.scrollTo(0, 0);
    readProgress();
  }
  // при уходе из урока запоминаем место: кнопка «назад» браузера вернёт туда же
  window.addEventListener('hashchange', function () { if (curLesson != null) scrollMem[curLesson] = window.scrollY; route(); });

  // ---------- тема ----------
  $('themeBtn').addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    var nx = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', nx);
    try { localStorage.setItem('aicourse-theme', nx); } catch (e) {}
  });

  // ---------- старт ----------
  $('authBtn').addEventListener('click', async function () {
    if (user) { await sb.auth.signOut(); location.hash = '#map'; location.reload(); } else login();
  });
  (async function start() {
    st = loadLocal();
    safe(initChrome); safe(function () { decorate($('v-map'), false); });
    try { course = await (await fetch('course.json', { cache: 'no-cache' })).json(); TOTAL = lessons().length; }
    catch (e) { showNotice('Не удалось загрузить план курса. Обновите страницу.'); return; }
    renderAuth(); updNote();
    if (sb) {
      var back = null; try { back = sessionStorage.getItem('aicourse-back'); sessionStorage.removeItem('aicourse-back'); } catch (e) {}
      var s = await sb.auth.getSession();
      if (/^#(access_token|error)/.test(location.hash) || location.href.slice(-1) === '#') {
        try { history.replaceState(null, '', location.pathname + location.search + (back || '')); } catch (e) {}
      }
      sb.auth.onAuthStateChange(function (_e, sess) { onUser(sess && sess.user); });
      if (s.data && s.data.session) { await onUser(s.data.session.user); return; }
    }
    route();
  })();
})();
