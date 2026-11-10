/* Страница прогресса: по каждому учащемуся — планшет на 24 лунки и таблица результатов тестов. */
(function () {
  'use strict';
  var C = window.AI_CONFIG || {};
  var sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey);
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function say(t) { var o = $('out'); o.textContent = ''; o.appendChild(el('p', 'lead', t)); }
  function fmtDate(s) { try { return new Date(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }); } catch (e) { return ''; } }

  $('themeBtn').addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    var nx = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', nx);
    try { localStorage.setItem('aicourse-theme', nx); } catch (e) {}
  });
  var user = null;
  $('authBtn').addEventListener('click', async function () {
    if (user) { await sb.auth.signOut(); location.reload(); }
    else sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
  });

  async function main() {
    var course = await (await fetch('course.json', { cache: 'no-cache' })).json();
    var titles = {}; course.modules.forEach(function (m) { m.lessons.forEach(function (l) { titles[l.n] = l.title; }); });
    var s = await sb.auth.getSession();
    if (/^#(access_token|error)?/.test(location.hash) && location.hash !== '') { try { history.replaceState(null, '', location.pathname); } catch (e) {} }
    user = s.data && s.data.session && s.data.session.user;
    var b = $('authBtn'); b.hidden = false; b.textContent = user ? 'Выйти' : 'Войти';
    if (!user) return say('Войдите через Google, чтобы увидеть прогресс.');
    var f = await sb.rpc('ai_is_adult');
    if (f.data !== true) return say('Эта страница только для взрослых членов семьи. Вы вошли как ' + user.email + '.');
    var r = await sb.from('ai_progress').select('user_id,email,name,lesson,done,quiz_right,quiz_total,best_right,attempts,updated_at').order('lesson');
    if (r.error) return say('Не удалось загрузить данные: ' + r.error.message);
    var by = {};
    r.data.forEach(function (x) { (by[x.user_id] = by[x.user_id] || { name: x.name || x.email.split('@')[0], email: x.email, rows: {} }).rows[x.lesson] = x; });
    var ids = Object.keys(by);
    var out = $('out'); out.textContent = '';
    if (!ids.length) return say('Пока никто не прошёл ни одного урока.');
    ids.sort(function (a, b) { return by[a].name.localeCompare(by[b].name, 'ru'); });
    ids.forEach(function (id) {
      var P = by[id], done = 0, sumR = 0, sumT = 0;
      for (var n in P.rows) if (P.rows[n].done) { done++; if (P.rows[n].quiz_total) { sumR += P.rows[n].quiz_right; sumT += P.rows[n].quiz_total; } }
      var card = el('div', 'learner');
      var hd = el('div', 'stack'); hd.style.gap = '4px';
      hd.appendChild(el('h2', null, P.name));
      hd.appendChild(el('span', 'progress-note', 'пройдено ' + done + ' из 24' + (sumT ? ' · тесты: ' + sumR + ' из ' + sumT + ' верных ответов' : '')));
      card.appendChild(hd);
      var plate = el('div', 'plate'), g = el('div', 'plate-grid');
      g.appendChild(el('span', 'lab', '')); for (var c = 1; c <= 6; c++) g.appendChild(el('span', 'lab', String(c)));
      for (var rr = 0; rr < 4; rr++) {
        g.appendChild(el('span', 'lab', 'ABCD'[rr]));
        for (c = 1; c <= 6; c++) { var k = rr * 6 + c, R = P.rows[k]; var w = el('span', 'well' + (R && R.done ? ' done' : ''), String(k)); w.title = 'Урок ' + k + ': ' + (titles[k] || ''); g.appendChild(w); }
      }
      plate.appendChild(g); card.appendChild(plate);
      var rows = Object.keys(P.rows).map(Number).sort(function (a, b) { return a - b; }).filter(function (n) { return P.rows[n].done; });
      if (rows.length) {
        var wrap = el('div', 'scroll'), t = el('table', 'scores'), tr = el('tr');
        ['Урок', 'Тест', 'Лучший', 'Попыток', 'Когда'].forEach(function (h) { tr.appendChild(el('th', null, h)); }); t.appendChild(tr);
        rows.forEach(function (n) {
          var R = P.rows[n], q = R.quiz_total ? R.quiz_right + ' из ' + R.quiz_total : '—';
          tr = el('tr'); tr.appendChild(el('td', null, n + '. ' + (titles[n] || '')));
          tr.appendChild(el('td', 'num', q)); tr.appendChild(el('td', 'num', R.quiz_total ? String(R.best_right) : '—'));
          tr.appendChild(el('td', 'num', String(R.attempts || 0))); tr.appendChild(el('td', 'num', fmtDate(R.updated_at)));
          t.appendChild(tr);
        });
        wrap.appendChild(t); card.appendChild(wrap);
      }
      out.appendChild(card);
    });
  }
  main().catch(function (e) { say('Ошибка: ' + e.message); });
})();
