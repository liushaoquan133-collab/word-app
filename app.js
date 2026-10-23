/* 单词本 · 应用逻辑 */
(function () {
  'use strict';

  var KEY = 'danci_v1';
  var DAY = SRS.DAY;

  var db = load();
  var ui = {
    tab: 'today',
    filter: 'all',
    search: '',
    addText: '',
    addTag: '',
    preview: null,
    libLimit: 150,
    session: null,
    editingId: null
  };

  /* ---------- 存储 ---------- */
  function load() {
    try {
      var d = JSON.parse(localStorage.getItem(KEY));
      if (d && d.v === 1 && Array.isArray(d.words)) {
        d.settings = Object.assign({ newPerDay: 50, reviewPerDay: 300, autoPlay: true }, d.settings || {});
        d.days = d.days || {};
        return d;
      }
    } catch (e) { /* ignore */ }
    return { v: 1, settings: { newPerDay: 50, reviewPerDay: 300, autoPlay: true }, words: [], days: {} };
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) { toast('保存失败：存储空间可能已满'); }
  }

  /* ---------- 时间 ---------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function todayKey(ts) {
    var d = ts ? new Date(ts) : new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function dayStart(ts) {
    var d = new Date(ts || Date.now());
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function isToday(ts) { return todayKey(ts) === todayKey(); }
  function ensureDay() {
    var k = todayKey();
    if (!db.days[k]) db.days[k] = { newN: 0, revN: 0, sec: 0 };
    return db.days[k];
  }

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1800);
  }
  function speak(text) {
    if (!db.settings.autoPlay) return;
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 0.9;
      window.speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  }
  function speakNow(text) {
    if (!('speechSynthesis' in window)) { toast('这个浏览器不支持发音'); return; }
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 0.9;
      window.speechSynthesis.speak(u);
    } catch (e) { toast('发音失败'); }
  }

  /* ---------- 队列 ---------- */
  function dueCount(now) {
    now = now || Date.now();
    return db.words.filter(function (w) { return !w.suspended && w.state !== 'new' && w.due <= now; }).length;
  }
  function newCount() {
    return db.words.filter(function (w) { return !w.suspended && w.state === 'new'; }).length;
  }
  function quotaLeft() {
    var t = todayKey();
    var used = (db.days[t] && db.days[t].newN) || 0;
    return Math.max(0, (db.settings.newPerDay || 50) - used);
  }
  function buildQueue() {
    var now = Date.now();
    var reviews = db.words.filter(function (w) {
      return !w.suspended && w.state !== 'new' && w.due <= now;
    }).sort(function (a, b) { return a.due - b.due; })
      .slice(0, db.settings.reviewPerDay || 300);

    var news = db.words.filter(function (w) { return !w.suspended && w.state === 'new'; });
    news.sort(function (a, b) {
      var ta = isToday(a.created) ? 1 : 0, tb = isToday(b.created) ? 1 : 0;
      if (ta !== tb) return tb - ta;
      return a.created - b.created;
    });
    news = news.slice(0, quotaLeft());

    var queue = [], r = 0, n = 0;
    while (r < reviews.length || n < news.length) {
      for (var k = 0; k < 3 && r < reviews.length; k++) queue.push(reviews[r++]);
      if (n < news.length) queue.push(news[n++]);
    }
    return queue;
  }
  function startSession() {
    var q = buildQueue();
    if (!q.length) { toast('今天没有要学的词，先去加词'); return; }
    ui.session = { queue: q, idx: 0, revealed: false, cardStart: Date.now(), answered: 0, stats: { again: 0, hard: 0, good: 0 }, lastSpoken: null };
    ui.tab = 'today';
    render();
  }
  function endSession() { ui.session = null; render(); }

  /* ---------- 解析词单 ---------- */
  function parseLine(line) {
    line = String(line).trim();
    if (!line) return null;
    line = line.replace(/^[\s\-–—•·*]+/, '').replace(/^\d{1,3}[\.、)）]\s*/, '').replace(/^[（(]\d+[)）]\s*/, '');
    if (!line) return null;
    // 标题行（Unit 1 / Lesson 3）不是单词，跳过
    if (/^(unit|lesson|module|chapter|part|section|list|book)\s*\d+\s*$/i.test(line)) return null;

    var idx = line.search(/[\u4e00-\u9fa5]/);
    var head = idx >= 0 ? line.slice(0, idx) : line;
    var tail = idx >= 0 ? line.slice(idx) : '';

    // 单词后面紧跟的中文括号（如「abandon（书）」）属于释义，连同括号一起挪到 tail
    while (/[（(【\[]$/.test(head)) {
      tail = head.slice(-1) + tail;
      head = head.slice(0, -1);
    }

    // 音标可能给了英式+美式两个，都要，别把第二个漏进释义
    var phonetic = '';
    var phs = head.match(/\/[^\/]{1,40}\/|\[[^\]]{1,40}\]/g);
    if (phs) {
      phonetic = phs.map(function (s) { return s.slice(1, -1).trim(); }).filter(Boolean).join(' ');
      phs.forEach(function (s) { head = head.replace(s, ' '); });
    }

    if (!tail && /[,;，；]/.test(head)) {
      var parts = head.split(/[,;，；]/);
      head = parts.shift();
      tail = parts.join('，').trim();
    }

    var tokens = head.trim().split(/\s+/).filter(Boolean);
    var POS = /^(n|v|vt|vi|adj|adv|ad|prep|conj|pron|num|art|int|aux|abbr|pl|phr)\.?$/i;
    var WORD = /^[A-Za-z0-9][A-Za-z0-9.'’\-]*$/;
    var wordTokens = [];
    for (var i = 0; i < tokens.length; i++) {
      var raw = tokens[i];
      var tk = raw.replace(/[.,;:，；：]+$/, '');
      // 词组中间的省略号（as ... as、not only ... but also）当连接符保留
      if (/^(\.{2,}|…)$/.test(raw) && wordTokens.length > 0) {
        wordTokens.push('...');
        continue;
      }
      if (!WORD.test(tk) || !/[A-Za-z]/.test(tk)) break;
      if (wordTokens.length > 0 && (POS.test(tk) || tk.length === 1)) break;
      // 缩写（A.M.）保留点，普通词末尾的逗号句号去掉
      wordTokens.push(/\./.test(tk) ? raw.replace(/[,;:，；：]+$/, '') : tk);
    }
    var word = wordTokens.join(' ');
    if (!word) return null;

    var leftover = tokens.slice(wordTokens.length).join(' ').trim();
    var meaning = tail.trim();
    if (leftover) meaning = (leftover + ' ' + meaning).trim();
    meaning = meaning.replace(/^[\s,，;；:：、\-–—]+/, '').trim();

    return { w: word, meaning: meaning, phonetic: phonetic };
  }
  function parseText(text) {
    var lines = String(text || '').replace(/\r/g, '').split('\n');
    var seen = {}, existing = {};
    db.words.forEach(function (w) { existing[w.w.toLowerCase()] = true; });
    var list = [], dup = 0;
    lines.forEach(function (l) {
      var p = parseLine(l);
      if (!p) return;
      var low = p.w.toLowerCase();
      if (existing[low] || seen[low]) { dup++; p.dup = true; }
      else seen[low] = true;
      list.push(p);
    });
    return { list: list, dup: dup };
  }

  /* ---------- 渲染 ---------- */
  function render() {
    var view = document.getElementById('view');
    if (ui.session) view.innerHTML = renderStudy();
    else if (ui.tab === 'today') view.innerHTML = renderToday();
    else if (ui.tab === 'add') view.innerHTML = renderAdd();
    else if (ui.tab === 'library') view.innerHTML = renderLibrary();
    else if (ui.tab === 'stats') view.innerHTML = renderStats();
    else view.innerHTML = renderSettings();

    var tabs = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === ui.tab);
    }
    maybeAutoSpeak();
  }

  function renderToday() {
    var now = Date.now();
    var due = dueCount(now), nw = Math.min(newCount(), quotaLeft());
    var t = db.days[todayKey()] || { newN: 0, revN: 0, sec: 0 };
    var total = db.words.length;
    var streak = calcStreak();
    var todayWords = db.words.filter(function (w) { return isToday(w.created); });

    var h = '';
    h += '<div class="hero">';
    h += '<div class="lbl">' + (due + nw > 0 ? '今天要学' : '今天已完成') + '</div>';
    h += '<div class="big">' + (due + nw) + '</div>';
    h += '<div class="lbl">复习 ' + due + ' · 新词 ' + nw + ' · 连续打卡 ' + streak + ' 天</div>';
    h += '</div>';

    h += '<div class="card"><div class="stats3">';
    h += '<div><div class="n">' + (t.newN + t.revN) + '</div><div class="t">今日已学</div></div>';
    h += '<div><div class="n">' + total + '</div><div class="t">词库总量</div></div>';
    h += '<div><div class="n">' + Math.round((t.sec || 0) / 60) + '</div><div class="t">今日分钟</div></div>';
    h += '</div></div>';

    if (due + nw > 0) {
      h += '<button class="btn block" data-act="start">开始学习</button>';
    } else if (total === 0) {
      h += '<div class="empty"><span class="emoji">📖</span>词库还是空的<br>去「加词」把老师今天的词单贴进来</div>';
      h += '<button class="btn ghost block" data-act="tab" data-tab="add">去加词</button>';
    } else {
      h += '<div class="empty"><span class="emoji">✅</span>今天的任务完成了<br>想多背就去加词，或把每日新词上限调高</div>';
    }

    if (todayWords.length) {
      h += '<div class="card mt"><div class="row between mb"><h2 style="margin:0">今日词单</h2><span class="pill">' + todayWords.length + ' 个</span></div>';
      todayWords.slice(0, 6).forEach(function (w) {
        h += '<div class="witem" data-act="word" data-id="' + w.id + '">';
        h += '<span class="dot ' + SRS.levelOf(w) + '"></span>';
        h += '<div class="grow"><div class="word-s">' + esc(w.w) + '</div><div class="meaning-s">' + (esc(w.meaning) || '<i class="muted">待补释义</i>') + '</div></div>';
        h += '<span class="small muted">' + (w.state === 'new' ? '未学' : SRS.nextText(w)) + '</span>';
        h += '</div>';
      });
      if (todayWords.length > 6) h += '<div class="small muted mt">还有 ' + (todayWords.length - 6) + ' 个，去词库看全部</div>';
      h += '</div>';
    }
    return h;
  }

  function renderStudy() {
    var s = ui.session;
    if (s.idx >= s.queue.length) return renderDone();
    var w = s.queue[s.idx];
    var done = s.answered;
    var remain = s.queue.length - s.idx;
    var pct = Math.round(done / Math.max(1, done + remain) * 100);

    var h = '';
    h += '<div class="row between mb"><span class="small muted">' + (w.state === 'new' ? '新词' : '复习') + ' · ' + esc(w.tag || '') + '</span>';
    h += '<span class="small muted">' + done + ' / ' + (done + remain) + '</span></div>';
    h += '<div class="progress mb"><i style="width:' + pct + '%"></i></div>';

    h += '<div class="study-card" data-act="' + (s.revealed ? '' : 'reveal') + '">';
    h += '<div class="word">' + esc(w.w) + '</div>';
    if (w.phonetic) h += '<div class="phonetic">/' + esc(w.phonetic) + '/</div>';
    if (s.revealed) {
      if (w.meaning) {
        h += '<div class="meaning">' + esc(w.meaning) + '</div>';
      } else {
        h += '<div class="mt"><input type="text" id="meaningInput" placeholder="这个词还没有释义，点这里补上" value=""></div>';
      }
    } else {
      h += '<div class="reveal-hint">点一下看释义</div>';
    }
    h += '</div>';

    h += '<div class="row mt" style="justify-content:center;gap:18px">';
    h += '<button class="btn line small" data-act="speak" data-w="' + esc(w.w) + '">🔊 发音</button>';
    if (!s.revealed) h += '<span class="small muted">想不起来就点卡片</span>';
    h += '</div>';

    if (s.revealed) {
      // 按钮上的时间是这一档真实的间隔（新词/复习词不一样），只预览不改进度
      var nextAgain = previewNext(w, 'again');
      var nextHard = previewNext(w, 'hard');
      var nextGood = previewNext(w, 'good');
      h += '<div class="ratings">';
      h += '<button class="rate again" data-act="rate" data-r="again">忘记<small>' + nextAgain + '</small></button>';
      h += '<button class="rate hard" data-act="rate" data-r="hard">模糊<small>' + nextHard + '</small></button>';
      h += '<button class="rate good" data-act="rate" data-r="good">认识<small>' + (nextGood === '1 天后' ? '明天再见' : nextGood) + '</small></button>';
      h += '</div>';
    }
    return h;
  }

  /* 这一档点下去下次什么时候再见（拿副本跑一遍算法，不动真实进度） */
  function previewNext(w, rating) {
    try {
      var copy = JSON.parse(JSON.stringify(w));
      var now = Date.now();
      SRS.review(copy, rating, now);
      return SRS.nextText(copy, now);
    } catch (e) { return ''; }
  }

  function renderDone() {
    var s = ui.session;
    var st = s.stats;
    var total = st.again + st.hard + st.good;
    var acc = total ? Math.round((st.good + st.hard * 0.5) / total * 100) : 0;
    var t = db.days[todayKey()] || { sec: 0 };
    var h = '';
    h += '<div class="card center" style="padding:34px 18px">';
    h += '<div class="done-big">🎉</div>';
    h += '<h1 class="mt">这一轮完成了</h1>';
    h += '<p class="sub">看了 ' + total + ' 张卡，' + Math.round((t.sec || 0) / 60) + ' 分钟</p>';
    h += '<div class="stats3 mt">';
    h += '<div><div class="n">' + st.good + '</div><div class="t">认识</div></div>';
    h += '<div><div class="n">' + st.hard + '</div><div class="t">模糊</div></div>';
    h += '<div><div class="n">' + st.again + '</div><div class="t">忘记</div></div>';
    h += '</div>';
    h += '</div>';
    h += '<button class="btn block" data-act="end">回到首页</button>';
    if (dueCount() + Math.min(newCount(), quotaLeft()) > 0) {
      h += '<button class="btn ghost block mt" data-act="start">继续下一组</button>';
    }
    return h;
  }

  function renderAdd() {
    var p = ui.preview;
    var h = '';
    h += '<h1>加词</h1><p class="sub mb">把老师给的词单直接贴进来，一行一个，格式随意：<br>abandon v. 放弃 &nbsp;|&nbsp; abandon 放弃 &nbsp;|&nbsp; abandon</p>';

    h += '<div class="card">';
    h += '<textarea id="addText" placeholder="例：&#10;1. abandon v. 放弃；抛弃&#10;2. ability n. 能力&#10;3. able adj. 能够的">' + esc(ui.addText) + '</textarea>';
    h += '<div class="row mt"><input type="text" id="addTag" placeholder="标签（可不填），如：10-24 老师词单" value="' + esc(ui.addTag) + '">';
    h += '<button class="btn ghost" data-act="pickfile">选文件</button></div>';
    h += '<input type="file" id="fileInput" accept=".txt,.csv,text/plain" style="display:none">';
    h += '<div class="row mt"><button class="btn grow" data-act="parse">解析预览</button>';
    if (p) h += '<button class="btn ghost" data-act="import">加入词库</button>';
    h += '</div></div>';

    if (p) {
      var fresh = p.list.filter(function (x) { return !x.dup; });
      h += '<div class="card"><div class="row between mb"><h2 style="margin:0">解析结果</h2>';
      h += '<span class="small muted">新增 ' + fresh.length + ' · 重复 ' + p.dup + '</span></div>';
      if (!p.list.length) {
        h += '<div class="small muted">没解析出英文单词。每行开头要是英文单词。</div>';
      } else {
        h += '<div class="preview">';
        p.list.forEach(function (x) {
          h += '<div class="li' + (x.dup ? ' dup' : '') + '"><span class="w">' + esc(x.w) + '</span><span class="m">' + esc(x.meaning || '（无释义）') + '</span></div>';
        });
        h += '</div>';
      }
      h += '</div>';
    }

    h += '<div class="card"><div class="small muted">小提示：老师只给英文不给释义也行，学习时点卡片可以补。每天贴一次，第二天它们会按记忆曲线自动回到复习里。</div></div>';
    return h;
  }

  function renderLibrary() {
    var list = db.words.slice();
    var f = ui.filter;
    if (f === 'paused') list = list.filter(function (w) { return w.suspended; });
    else if (f !== 'all') list = list.filter(function (w) { return !w.suspended && SRS.levelOf(w) === f; });
    if (ui.search) {
      var q = ui.search.toLowerCase();
      list = list.filter(function (w) {
        return w.w.toLowerCase().indexOf(q) >= 0 || (w.meaning || '').toLowerCase().indexOf(q) >= 0;
      });
    }
    list.sort(function (a, b) { return b.created - a.created; });

    var counts = { all: db.words.length, new: 0, learning: 0, review: 0, mastered: 0, paused: 0 };
    db.words.forEach(function (w) { counts[SRS.levelOf(w)]++; });

    var h = '';
    h += '<h1>词库</h1><p class="sub mb">共 ' + db.words.length + ' 个词</p>';
    h += '<div class="search"><input type="text" id="searchInput" placeholder="搜单词或释义" value="' + esc(ui.search) + '"></div>';
    h += '<div class="chips">';
    [['all', '全部'], ['new', '新词'], ['learning', '学习中'], ['review', '复习中'], ['mastered', '已掌握'], ['paused', '暂停']].forEach(function (c) {
      h += '<button class="chip' + (ui.filter === c[0] ? ' active' : '') + '" data-act="filter" data-f="' + c[0] + '">' + c[1] + ' ' + counts[c[0]] + '</button>';
    });
    h += '</div>';

    if (!list.length) {
      h += '<div class="empty"><span class="emoji">🔍</span>没有符合条件的词</div>';
      return h;
    }

    h += '<div class="card"><div class="wlist">';
    list.slice(0, ui.libLimit).forEach(function (w) {
      h += '<div class="witem" data-act="word" data-id="' + w.id + '">';
      h += '<span class="dot ' + SRS.levelOf(w) + '"></span>';
      h += '<div class="grow"><div class="word-s">' + esc(w.w) + '</div><div class="meaning-s">' + (esc(w.meaning) || '<i class="muted">待补释义</i>') + '</div></div>';
      h += '<span class="small muted">' + (w.state === 'new' ? '未学' : SRS.nextText(w)) + '</span>';
      h += '</div>';
    });
    h += '</div>';
    if (list.length > ui.libLimit) {
      h += '<button class="btn line block mt" data-act="more">加载更多（还有 ' + (list.length - ui.libLimit) + ' 个）</button>';
    }
    h += '</div>';
    return h;
  }

  function renderStats() {
    var now = Date.now();
    var t = db.days[todayKey()] || { newN: 0, revN: 0, sec: 0 };
    var streak = calcStreak();
    var totalSec = 0;
    Object.keys(db.days).forEach(function (k) { totalSec += db.days[k].sec || 0; });
    var totalN = Object.keys(db.days).reduce(function (a, k) {
      var d = db.days[k]; return a + (d.newN || 0) + (d.revN || 0);
    }, 0);

    var counts = { new: 0, learning: 0, review: 0, mastered: 0, paused: 0 };
    db.words.forEach(function (w) { counts[SRS.levelOf(w)]++; });

    var h = '';
    h += '<h1>统计</h1><p class="sub mb">数据都存在这台手机上</p>';
    h += '<div class="card"><div class="stats3">';
    h += '<div><div class="n">' + streak + '</div><div class="t">连续打卡（天）</div></div>';
    h += '<div><div class="n">' + totalN + '</div><div class="t">累计学习（张）</div></div>';
    h += '<div><div class="n">' + Math.round(totalSec / 3600 * 10) / 10 + '</div><div class="t">累计小时</div></div>';
    h += '</div></div>';

    // 未来 7 天到期
    var fc = [], max = 1;
    for (var i = 0; i < 7; i++) {
      var s0 = dayStart(now) + i * DAY, s1 = s0 + DAY, c = 0;
      db.words.forEach(function (w) {
        if (w.suspended || w.state === 'new') return;
        if (w.due >= (i === 0 ? 0 : s0) && w.due < s1) c++;
      });
      fc.push(c); if (c > max) max = c;
    }
    h += '<div class="card"><h2>未来 7 天要复习</h2><div class="bars">';
    fc.forEach(function (c, i) {
      var hh = Math.max(3, Math.round(c / max * 100));
      h += '<div class="b"><div class="bar' + (c ? ' has' : '') + '" style="height:' + hh + '%"></div><div class="cap">' + (i === 0 ? '今天' : '+' + i) + '</div></div>';
    });
    h += '</div><div class="small muted mt">今天含已到期的词；新词不算在内</div></div>';

    // 掌握分布
    var total = db.words.length || 1;
    var a1 = counts.new / total * 100, a2 = a1 + counts.learning / total * 100, a3 = a2 + counts.review / total * 100;
    h += '<div class="card"><h2>掌握分布</h2><div class="row" style="gap:18px">';
    h += '<div class="donut" style="background:conic-gradient(#9aa6a2 0 ' + a1 + '%,#c98a2e ' + a1 + '% ' + a2 + '%,#12a08a ' + a2 + '% ' + a3 + '%,#1f9d64 ' + a3 + '% 100%)"><div class="hole">' + db.words.length + '<br>个词</div></div>';
    h += '<div class="legend grow">';
    h += '<div><span class="k" style="background:#9aa6a2"></span>新词 ' + counts.new + '</div>';
    h += '<div><span class="k" style="background:#c98a2e"></span>学习中 ' + counts.learning + '</div>';
    h += '<div><span class="k" style="background:#12a08a"></span>复习中 ' + counts.review + '</div>';
    h += '<div><span class="k" style="background:#1f9d64"></span>已掌握 ' + counts.mastered + '</div>';
    h += '</div></div></div>';

    // 最近 14 天
    h += '<div class="card"><h2>最近 14 天</h2><div class="heat">';
    var maxDay = 1;
    var cells = [];
    for (var j = 13; j >= 0; j--) {
      var d = new Date(dayStart(now) - j * DAY);
      var key = todayKey(d.getTime());
      var dd = db.days[key] || { newN: 0, revN: 0 };
      var v = (dd.newN || 0) + (dd.revN || 0);
      cells.push(v); if (v > maxDay) maxDay = v;
    }
    cells.forEach(function (v) {
      var alpha = v === 0 ? 0 : 0.25 + 0.75 * Math.min(1, v / maxDay);
      h += '<i style="background:' + (v === 0 ? '#e9efec' : 'rgba(18,160,138,' + alpha.toFixed(2) + ')') + '" title="' + v + '"></i>';
    });
    h += '</div><div class="small muted mt">今天：新词 ' + t.newN + ' · 复习 ' + t.revN + ' · ' + Math.round((t.sec || 0) / 60) + ' 分钟</div></div>';
    return h;
  }

  function renderSettings() {
    var s = db.settings;
    var h = '';
    h += '<h1>设置</h1><p class="sub mb">按自己的节奏来，别一开始就拉满</p>';
    h += '<div class="card">';
    h += '<div class="setting"><div><div class="lbl">每日新词上限</div><div class="hint">默认 50；拉到 100 到期复习会顶满上限</div></div><input type="number" min="0" max="300" value="' + s.newPerDay + '" data-setting="newPerDay"></div>';
    h += '<div class="setting"><div><div class="lbl">每日复习上限</div><div class="hint">默认 300 已接近真实负荷上限，别往下调</div></div><input type="number" min="0" max="1000" value="' + s.reviewPerDay + '" data-setting="reviewPerDay"></div>';
    h += '<div class="setting"><div><div class="lbl">显示单词时自动发音</div><div class="hint">用系统英文语音，不联网</div></div><input type="checkbox" ' + (s.autoPlay ? 'checked' : '') + ' data-setting="autoPlay"></div>';
    h += '</div>';

    h += '<div class="card"><h2>数据</h2>';
    h += '<button class="btn line block mb" data-act="export">导出备份（JSON）</button>';
    h += '<button class="btn line block mb" data-act="pickimport">导入备份</button>';
    h += '<input type="file" id="importInput" accept=".json,application/json" style="display:none">';
    h += '<button class="btn danger block" data-act="clear">清空所有数据</button>';
    h += '</div>';

    h += '<div class="card"><div class="small muted">单词本 v1 · 数据只存在本机浏览器里，换手机前记得导出备份。<br>复习逻辑：忘记→1 分钟；模糊→10 分钟；认识→按记忆曲线拉长（1 天起，最长一年）。<br>最高掌握状态在间隔满 60 天后出现。</div></div>';
    return h;
  }

  function calcStreak() {
    var n = 0;
    var d = new Date(dayStart(Date.now()));
    // 今天没学就从昨天开始算，避免早上打开时显示 0
    var todayData = db.days[todayKey(d.getTime())];
    if (!todayData || (todayData.newN + todayData.revN) === 0) d.setDate(d.getDate() - 1);
    for (var i = 0; i < 3650; i++) {
      var k = todayKey(d.getTime());
      var x = db.days[k];
      if (x && (x.newN + x.revN) > 0) { n++; d.setDate(d.getDate() - 1); }
      else break;
    }
    return n;
  }

  /* ---------- 交互 ---------- */
  function maybeAutoSpeak() {
    var s = ui.session;
    if (!s || s.idx >= s.queue.length) return;
    var w = s.queue[s.idx];
    if (s.revealed) return;
    if (s.lastSpoken === w.id) return;
    s.lastSpoken = w.id;
    if (db.settings.autoPlay) speak(w.w);
  }

  function rate(rating) {
    var s = ui.session;
    if (!s) return;
    var w = s.queue[s.idx];
    var before = w.state;
    var now = Date.now();

    // 计时
    var used = Math.min(120000, now - s.cardStart);
    var day = ensureDay();
    day.sec = (day.sec || 0) + Math.round(used / 1000);

    SRS.review(w, rating, now);

    if (before === 'new') { day.newN = (day.newN || 0) + 1; }
    else { day.revN = (day.revN || 0) + 1; }

    s.stats[rating] = (s.stats[rating] || 0) + 1;
    s.answered++;

    var again = (rating === 'again') || (rating === 'hard' && w.state === 'learning');
    if (again) {
      var at = Math.min(s.idx + 3, s.queue.length);
      s.queue.splice(at, 0, w);
    }

    var nextTxt = SRS.nextText(w, now);
    // 学习步进（几分钟）不硬插，交给上面 requeue 控制
    s.idx++;
    s.revealed = false;
    s.cardStart = Date.now();
    s.lastSpoken = null;

    save();
    render();
    if (w.state === 'mastered') toast('已掌握 · ' + nextTxt);
    else if (rating === 'good') toast(nextTxt + '复习');
    else if (rating === 'hard') toast(nextTxt + '复习');
    else toast('稍后再来 · ' + nextTxt);
  }

  function commitMeaning() {
    var s = ui.session;
    if (!s) return;
    var w = s.queue[s.idx];
    var input = document.getElementById('meaningInput');
    if (!input) return;
    var v = input.value.trim();
    if (v) { w.meaning = v; save(); toast('释义已补上'); }
  }

  function importWords() {
    var p = ui.preview;
    if (!p) return;
    var fresh = p.list.filter(function (x) { return !x.dup; });
    if (!fresh.length) { toast('没有新词可加'); return; }
    var tag = (document.getElementById('addTag') || {}).value || '';
    fresh.forEach(function (x) {
      var w = SRS.newWord(x.w, x.meaning, x.phonetic, tag);
      db.words.push(w);
    });
    save();
    ui.addText = '';
    ui.preview = null;
    ui.addTag = '';
    ui.tab = 'today';
    render();
    toast('已加入 ' + fresh.length + ' 个词');
  }

  function exportBackup() {
    var data = JSON.stringify(db);
    var blob = new Blob([data], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '单词本备份-' + todayKey() + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  function openWord(id) {
    var w = db.words.filter(function (x) { return x.id === id; })[0];
    if (!w) return;
    ui.editingId = w.id;
    var m = document.getElementById('modal');
    m.classList.remove('hidden');
    m.innerHTML = '<div class="modal">'
      + '<h3>' + esc(w.w) + '</h3>'
      + '<div class="field"><label>释义</label><input type="text" id="editMeaning" value="' + esc(w.meaning) + '"></div>'
      + '<div class="field"><label>音标（可不填）</label><input type="text" id="editPhonetic" value="' + esc(w.phonetic) + '"></div>'
      + '<div class="small muted mb">状态：' + SRS.levelName(SRS.levelOf(w)) + ' · 复习 ' + w.reps + ' 次 · 忘记 ' + w.lapses + ' 次</div>'
      + '<div class="row"><button class="btn grow" data-act="saveword">保存</button>'
      + '<button class="btn line" data-act="pauseword">' + (w.suspended ? '恢复' : '暂停') + '</button></div>'
      + '<div class="row mt"><button class="btn danger grow" data-act="delword">删除</button>'
      + '<button class="btn line" data-act="resetword">重置进度</button></div>'
      + '<button class="btn ghost block mt" data-act="closemodal">关闭</button>'
      + '</div>';
  }
  function closeModal() {
    document.getElementById('modal').classList.add('hidden');
    document.getElementById('modal').innerHTML = '';
    ui.editingId = null;
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    var s = ui.session;

    if (act === 'tab') { ui.tab = el.getAttribute('data-tab'); ui.session = null; render(); return; }
    if (act === 'start') { startSession(); return; }
    if (act === 'end') { endSession(); return; }
    if (act === 'reveal') { if (s) { s.revealed = true; render(); } return; }
    if (act === 'rate') { rate(el.getAttribute('data-r')); return; }
    if (act === 'speak') { speakNow(el.getAttribute('data-w')); return; }
    if (act === 'parse') {
      ui.addText = (document.getElementById('addText') || {}).value || '';
      ui.addTag = (document.getElementById('addTag') || {}).value || '';
      ui.preview = parseText(ui.addText);
      render();
      return;
    }
    if (act === 'import') { importWords(); return; }
    if (act === 'pickfile') { document.getElementById('fileInput').click(); return; }
    if (act === 'pickimport') { document.getElementById('importInput').click(); return; }
    if (act === 'export') { exportBackup(); return; }
    if (act === 'filter') { ui.filter = el.getAttribute('data-f'); ui.libLimit = 150; render(); return; }
    if (act === 'more') { ui.libLimit += 200; render(); return; }
    if (act === 'clear') {
      if (!confirm('确定清空所有单词和学习记录？这个不能撤销。')) return;
      if (!confirm('再确认一次：真的要清空？')) return;
      db = { v: 1, settings: db.settings, words: [], days: {} };
      save(); render(); toast('已清空');
      return;
    }
    if (act === 'word') { openWord(el.getAttribute('data-id')); return; }
    if (act === 'closemodal') { closeModal(); return; }
    if (act === 'saveword') {
      var w = db.words.filter(function (x) { return x.id === ui.editingId; })[0];
      if (w) {
        w.meaning = (document.getElementById('editMeaning') || {}).value || '';
        w.phonetic = (document.getElementById('editPhonetic') || {}).value || '';
        save(); closeModal(); render(); toast('已保存');
      }
      return;
    }
    if (act === 'pauseword') {
      var w2 = db.words.filter(function (x) { return x.id === ui.editingId; })[0];
      if (w2) { w2.suspended = !w2.suspended; save(); closeModal(); render(); toast(w2.suspended ? '已暂停' : '已恢复'); }
      return;
    }
    if (act === 'delword') {
      if (!confirm('删除这个词？')) return;
      db.words = db.words.filter(function (x) { return x.id !== ui.editingId; });
      save(); closeModal(); render(); toast('已删除');
      return;
    }
    if (act === 'resetword') {
      var w3 = db.words.filter(function (x) { return x.id === ui.editingId; })[0];
      if (!w3) return;
      if (!confirm('把它的复习进度重置成新词？')) return;
      w3.state = 'new'; w3.interval = 0; w3.ease = 2.5; w3.reps = 0; w3.lapses = 0; w3.due = Date.now(); w3.history = [];
      save(); closeModal(); render(); toast('已重置');
      return;
    }
    if (act === 'card-close') { closeModal(); return; }
  });

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.id === 'fileInput' && el.files && el.files[0]) {
      var f = el.files[0];
      var rd = new FileReader();
      rd.onload = function () {
        ui.addText = String(rd.result || '');
        ui.preview = parseText(ui.addText);
        render();
        toast('已读入 ' + f.name);
      };
      rd.readAsText(f, 'utf-8');
      return;
    }
    if (el.id === 'importInput' && el.files && el.files[0]) {
      var f2 = el.files[0];
      var rd2 = new FileReader();
      rd2.onload = function () {
        try {
          var incoming = JSON.parse(String(rd2.result || '{}'));
          if (!incoming || incoming.v !== 1 || !Array.isArray(incoming.words)) throw new Error('格式不对');
          if (!confirm('导入会覆盖当前所有数据（现有 ' + db.words.length + ' 个词），继续？')) return;
          db = incoming;
          db.settings = Object.assign({ newPerDay: 50, reviewPerDay: 300, autoPlay: true }, db.settings || {});
          db.days = db.days || {};
          save(); render(); toast('已导入 ' + db.words.length + ' 个词');
        } catch (err) { alert('导入失败：' + err.message); }
      };
      rd2.readAsText(f2, 'utf-8');
      return;
    }
    if (el.getAttribute && el.getAttribute('data-setting')) {
      var k = el.getAttribute('data-setting');
      if (k === 'autoPlay') db.settings[k] = !!el.checked;
      else db.settings[k] = Math.max(0, parseInt(el.value, 10) || 0);
      save(); toast('已保存');
    }
  });

  document.addEventListener('input', function (e) {
    var el = e.target;
    if (el.id === 'searchInput') {
      ui.search = el.value;
      ui.libLimit = 150;
      var pos = el.selectionStart;
      render();
      var again = document.getElementById('searchInput');
      if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (er) {} }
      return;
    }
    if (el.id === 'addText') ui.addText = el.value;
    if (el.id === 'addTag') ui.addTag = el.value;
    if (el.id === 'meaningInput') { /* 提交见 blur */ }
  });

  document.addEventListener('blur', function (e) {
    if (e.target && e.target.id === 'meaningInput') commitMeaning();
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeModal();
    if (e.key === 'Enter' && e.target && e.target.id === 'meaningInput') {
      commitMeaning();
      var s = ui.session; if (s) { s.revealed = true; render(); }
    }
  });

  /* ---------- 启动 ---------- */
  function boot() {
    var st = document.getElementById('view');
    if (st) st.innerHTML = '<div class="empty"><span class="emoji">📖</span>加载中…</div>';
    ensureDay();
    render();
    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 便于命令行测试解析逻辑
  if (typeof window !== 'undefined') {
    window.DanciParse = { parseLine: parseLine, parseText: parseText };
  }
})();
