/* От модели до агентов — общий движок курса.
   Карта, загрузка уроков из lessons/, тесты, записи к заданиям, вход Google и сохранение прогресса.
   Сами уроки сюда не вписываются: план — course.json, содержимое — lessons/NN.html. */
(function () {
  'use strict';
  var C = window.AI_CONFIG || {};
  var sb = (window.supabase && C.supabaseUrl) ? window.supabase.createClient(C.supabaseUrl, C.supabaseKey) : null;
  var TOTAL = 24; // уточняется по course.json при загрузке

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  // полоса прогресса: по делению на урок, промежутки между модулями
  function pbar(box, course, isDone, links) {
    box.textContent = '';
    course.modules.forEach(function (m, i) {
      var g = el('div', 'pseg-group');
      m.lessons.forEach(function (L) {
        var cls = 'pseg' + (isDone(L.n) ? ' done' : (L.file ? ' open' : '')), s;
        if (links && L.file) { s = el('a', cls); s.href = '#lesson-' + L.n; } else s = el('span', cls);
        s.title = 'Урок ' + L.n + ': ' + L.title; s.setAttribute('aria-label', s.title);
        g.appendChild(s);
      });
      g.style.flexGrow = m.lessons.length;
      box.appendChild(g);
    });
  }
  window.AI = { $: $, el: el, pbar: pbar };

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
  function renderMap() {
    AI.pbar($('pbar'), course, function (n) { return st.lessons[n] && st.lessons[n].done; }, true);
    var m = $('modules'); m.textContent = '';
    course.modules.forEach(function (md, i) {
      var d = el('div', 'module'); d.appendChild(el('span', 'eyebrow', 'Модуль ' + (i + 1))); d.appendChild(el('h2', null, md.title));
      var ol = el('ol');
      md.lessons.forEach(function (L) {
        var li = el('li', L.file ? '' : 'soon'); li.appendChild(el('span', 'n', String(L.n)));
        if (L.file) { var a = el('a', null, L.title); a.href = '#lesson-' + L.n; li.appendChild(a); } else li.appendChild(el('span', null, L.title));
        var S = st.lessons[L.n];
        li.appendChild(el('span', 'st', S && S.done ? 'пройден' : (L.file ? 'открыт' : 'готовится')));
        ol.appendChild(li);
      });
      d.appendChild(ol); m.appendChild(d);
    });
    updNote();
  }

  // ---------- урок ----------
  function navLabel(L) { return 'Урок ' + L.n + ': ' + (L.nav || L.title); }
  async function showLesson(n) {
    var L = info(n), box = $('v-lesson'), tok = ++lessonToken;
    $('v-map').hidden = true; box.hidden = false;
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
    var qd = box.querySelector('script.quiz-data');
    if (qd) renderQuiz(n, box.querySelector('.quiz'), JSON.parse(qd.textContent));
    // сноски: номер в тексте раскрывает пояснение прямо под абзацем (без переходов по #, их занимает маршрутизатор)
    var fnText = {};
    box.querySelectorAll('.footnotes li[data-fn]').forEach(function (li) { fnText[li.getAttribute('data-fn')] = li.innerHTML; });
    box.querySelectorAll('sup.fn[data-fn]').forEach(function (s) {
      s.setAttribute('role', 'button'); s.tabIndex = 0; s.setAttribute('aria-expanded', 'false'); s.title = 'Сноска';
      var pop = null;
      function toggle() {
        if (pop) { pop.remove(); pop = null; s.setAttribute('aria-expanded', 'false'); return; }
        pop = el('div', 'fn-pop'); pop.innerHTML = '<b>' + s.getAttribute('data-fn') + '.</b> ' + (fnText[s.getAttribute('data-fn')] || '');
        var host = s.closest('p, li, td, .callout');
        if (host && host.tagName === 'TD') host.appendChild(pop); else (host || s).after(pop);
        s.setAttribute('aria-expanded', 'true');
      }
      s.addEventListener('click', toggle);
      s.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    });
    box.querySelectorAll('[data-note]').forEach(function (p) { addNote(n, p, p.getAttribute('data-note')); });
    // интерактивы урока: скрипты, вставленные через innerHTML, браузер не выполняет — пересоздаём
    box.querySelectorAll('script:not([type="application/json"])').forEach(function (s) {
      var x = document.createElement('script'); x.textContent = s.textContent; s.replaceWith(x);
    });
    // переход к соседним урокам
    var all = lessons(), i = all.indexOf(L), prev = all[i - 1], next = all[i + 1];
    var nav = el('div', 'lesson-nav'), a;
    if (prev && prev.file) { a = el('a', 'btn', 'Урок ' + prev.n); a.href = '#lesson-' + prev.n; }
    else { a = el('a', 'btn', 'К карте курса'); a.href = '#map'; }
    nav.appendChild(a);
    if (next && next.file) { a = el('a', 'btn primary', navLabel(next)); a.href = '#lesson-' + next.n; }
    else { a = el('a', 'btn primary', 'К карте курса'); a.href = '#map'; }
    nav.appendChild(a);
    box.appendChild(nav);
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

  function addNote(n, panel, kind) {
    var wrap = el('label', 'note'); wrap.appendChild(el('span', 'eyebrow', kind === 'task' ? 'Ваша запись к заданию' : 'Ваша запись к шагу проекта'));
    var ta = el('textarea'); ta.rows = 4; ta.placeholder = kind === 'task' ? 'Что вы сделали и что заметили' : 'Ваш результат для проекта';
    var N = st.notes[n] || {}; ta.value = N[kind] || '';
    var stt = el('span', 'why'), t = null;
    ta.addEventListener('input', function () {
      stt.textContent = '…';
      clearTimeout(t);
      t = setTimeout(async function () {
        var cur = st.notes[n] || (st.notes[n] = {});
        cur[kind] = ta.value; cur.at = new Date().toISOString(); saveLocal();
        var ok = await pushNote(n);
        stt.textContent = !ok ? 'сохранено в этом браузере, в аккаунт не ушло' : (online() ? 'сохранено в аккаунте' : 'сохранено в этом браузере');
      }, 700);
    });
    wrap.appendChild(ta); wrap.appendChild(stt); panel.appendChild(wrap);
  }

  // ---------- маршрут ----------
  function route(keepScroll) {
    if (!course) return;
    var h = location.hash.slice(1);
    if (/^(access_token|error|refresh_token)/.test(h)) return;
    var m = /^lesson-(\d+)$/.exec(h), L = m && info(+m[1]);
    if (L && L.file) { if (keepScroll !== true || $('v-lesson').hidden) showLesson(L.n); return; }
    lessonToken++;
    $('v-lesson').hidden = true; $('v-map').hidden = false;
    document.title = 'От модели до агентов';
    renderMap();
    if (keepScroll !== true) window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', function () { route(); });

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
