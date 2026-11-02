/* 공통 유틸: API 호출, 토스트, 모달, 페이지 콘텐츠/주석 렌더링 (에디터·뷰어 공용) */
(function (global) {
  'use strict';
  var U = {};

  U.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  function pad(n) { return String(n).padStart(2, '0'); }
  U.fmtDate = function (ts, withTime, timeZone) {
    if (!ts) return '-';
    var d = new Date(ts);
    if (timeZone) {
      try {
        var parts = {};
        new Intl.DateTimeFormat('en-GB', { timeZone: timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
          .formatToParts(d).forEach(function (p) { parts[p.type] = p.value; });
        var t = parts.year + '.' + parts.month + '.' + parts.day;
        return withTime === false ? t : t + ' ' + parts.hour + ':' + parts.minute;
      } catch (e) { /* 시간대 미지원 브라우저 → 로컬 시간 */ }
    }
    var s = d.getFullYear() + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate());
    return withTime === false ? s : s + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  U.fmtRelative = function (ts) {
    if (!ts) return '-';
    var diff = (Date.now() - ts) / 1000;
    if (diff < 60) return '방금 전';
    if (diff < 3600) return Math.floor(diff / 60) + '분 전';
    if (diff < 86400) return Math.floor(diff / 3600) + '시간 전';
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + '일 전';
    return U.fmtDate(ts, false);
  };
  U.fmtBytes = function (b) {
    if (!b) return '0B';
    if (b < 1024) return b + 'B';
    if (b < 1048576) return (b / 1024).toFixed(1) + 'KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + 'MB';
    return (b / 1073741824).toFixed(2) + 'GB';
  };
  U.el = function (html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };

  /**
   * fetch 래퍼. 네트워크 오류/시간초과/서버 오류를 모두 사람이 읽을 수 있는 한국어 메시지로 변환.
   * err.network=true 이면 서버에 도달하지 못한 것 (데이터는 서버에 변경되지 않음)
   */
  U.api = function (method, url, body, opts) {
    opts = opts || {};
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, opts.timeout || 30000) : null;
    var isRaw = body instanceof Blob || body instanceof ArrayBuffer;
    var init = { method: method, credentials: 'same-origin', signal: ctrl ? ctrl.signal : undefined, headers: {} };
    if (body !== undefined) {
      init.body = isRaw ? body : JSON.stringify(body);
      init.headers['Content-Type'] = isRaw ? (opts.contentType || 'application/octet-stream') : 'application/json';
    }
    return fetch(url, init).then(function (res) {
      clearTimeout(timer);
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var msg = (data && data.error) || ('서버 오류가 발생했습니다 (HTTP ' + res.status + ').');
          if (res.status === 413 && !(data && data.error)) msg = '파일이 너무 커서 서버가 거부했습니다.';
          if ((res.status === 502 || res.status === 503 || res.status === 504) && !(data && data.error)) msg = '서버가 일시적으로 응답하지 않습니다 (HTTP ' + res.status + '). 잠시 후 다시 시도하세요.';
          var err = new Error(msg);
          err.status = res.status; err.code = data && data.code; err.data = data || {};
          if (res.status === 401 && err.code === 'AUTH_REQUIRED') { location.href = '/'; }
          throw err;
        }
        return data;
      });
    }, function (e) {
      clearTimeout(timer);
      var err = new Error(e && e.name === 'AbortError'
        ? '서버 응답 시간이 초과되었습니다. 네트워크 상태를 확인한 뒤 다시 시도하세요.'
        : '서버에 연결할 수 없습니다 (Failed to fetch). 인터넷 연결 또는 서버 상태를 확인하세요.');
      err.network = true;
      throw err;
    });
  };

  // ── 토스트 ──
  var toastWrap;
  U.toast = function (msg, type, opts) {
    opts = opts || {};
    if (!toastWrap) { toastWrap = document.createElement('div'); toastWrap.className = 'toasts'; document.body.appendChild(toastWrap); }
    var icons = { success: '✓', error: '⚠', warning: '!', info: 'ℹ' };
    var t = document.createElement('div');
    t.className = 'toast ' + (type || 'info');
    t.setAttribute('role', type === 'error' ? 'alert' : 'status');
    t.innerHTML = '<span class="t-icon">' + (icons[type] || icons.info) + '</span><div class="t-msg"></div>';
    t.querySelector('.t-msg').textContent = msg;
    if (opts.action) {
      var b = document.createElement('button');
      b.textContent = opts.action.label;
      b.onclick = function () { opts.action.onClick(); close(); };
      t.appendChild(b);
    }
    toastWrap.appendChild(t);
    var timer = null;
    function close() { clearTimeout(timer); if (t.parentNode) t.parentNode.removeChild(t); }
    if (opts.duration !== 0) timer = setTimeout(close, opts.duration || (type === 'error' ? 7000 : 3500));
    return {
      close: close,
      update: function (m, progress) {
        t.querySelector('.t-msg').innerHTML = U.esc(m) + (progress != null ? '<div class="progress"><div style="width:' + Math.round(progress * 100) + '%"></div></div>' : '');
      },
    };
  };

  // ── 모달 ──
  /**
   * U.modal({ title, icon, tone, html | node, buttons: [{label, value, kind}], wide, onOpen })
   * → Promise<value>  (닫기/ESC 는 dismissValue, 기본 null)
   */
  U.modal = function (o) {
    return new Promise(function (resolve) {
      var back = document.createElement('div');
      back.className = 'modal-backdrop';
      var tone = o.tone || 'info';
      var defaultIcons = { info: 'ℹ️', danger: '⚠️', warning: '⚠️', success: '✅' };
      back.innerHTML =
        '<div class="modal' + (o.wide ? ' wide' : '') + '" role="dialog" aria-modal="true">' +
        '<div class="modal-head"><div class="modal-icon ' + tone + '">' + (o.icon || defaultIcons[tone]) + '</div><h3></h3></div>' +
        '<div class="modal-body"></div><div class="modal-foot"></div></div>';
      back.querySelector('h3').textContent = o.title || '';
      var body = back.querySelector('.modal-body');
      if (o.node) body.appendChild(o.node); else body.innerHTML = o.html || '';
      var foot = back.querySelector('.modal-foot');
      var buttons = o.buttons || [{ label: '확인', value: true, kind: 'primary' }];
      var done = false;
      function close(v) {
        if (done) return; done = true;
        document.removeEventListener('keydown', onKey, true);
        if (back.parentNode) back.parentNode.removeChild(back);
        resolve(v);
      }
      buttons.forEach(function (b) {
        var btn = document.createElement('button');
        btn.className = 'btn ' + (b.kind === 'primary' ? 'btn-primary' : b.kind === 'danger' ? 'btn-danger-solid' : b.kind === 'success' ? 'btn-success' : '');
        btn.textContent = b.label;
        btn.onclick = function () {
          if (b.onClick) { var r = b.onClick(close); if (r === false) return; }
          close(typeof b.value === 'function' ? b.value() : b.value);
        };
        foot.appendChild(btn);
      });
      if (!buttons.length) foot.style.display = 'none';
      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(o.dismissValue !== undefined ? o.dismissValue : null); }
      }
      document.addEventListener('keydown', onKey, true);
      back.addEventListener('mousedown', function (e) { if (e.target === back && !o.persistent) close(o.dismissValue !== undefined ? o.dismissValue : null); });
      document.body.appendChild(back);
      var primary = foot.querySelector('.btn-primary, .btn-danger-solid, .btn-success');
      if (o.onOpen) o.onOpen(back.querySelector('.modal'), close);
      else if (primary) primary.focus();
    });
  };
  U.alert = function (title, html, tone) {
    return U.modal({ title: title, html: html, tone: tone || 'info', buttons: [{ label: '확인', value: true, kind: 'primary' }] });
  };
  U.confirm = function (title, html, okLabel, tone) {
    return U.modal({
      title: title, html: html, tone: tone || 'warning',
      buttons: [{ label: '취소', value: false }, { label: okLabel || '확인', value: true, kind: tone === 'danger' ? 'danger' : 'primary' }],
      dismissValue: false,
    });
  };
  U.prompt = function (title, label, value, okLabel) {
    var node = U.el('<div><label style="display:block;font-size:13px;margin-bottom:6px;color:var(--text-2)">' + U.esc(label || '') + '</label><input class="input" style="width:100%" maxlength="200"></div>');
    var input = node.querySelector('input');
    input.value = value || '';
    return U.modal({
      title: title, node: node, icon: '✏️',
      buttons: [{ label: '취소', value: null }, { label: okLabel || '확인', kind: 'primary', value: function () { return input.value.trim() || null; } }],
      onOpen: function (m, close) {
        input.focus(); input.select();
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) close(input.value.trim() || null); });
      },
    });
  };
  /** 오류를 사용자에게 모달로 알린다. err.data.problems 가 있으면 목록으로 보여준다. */
  U.showError = function (title, err, extraHtml) {
    var html = '<p>' + U.esc(err && err.message ? err.message : String(err)) + '</p>';
    if (err && err.data && err.data.problems) html += '<ul>' + err.data.problems.map(function (p) { return '<li>' + U.esc(p) + '</li>'; }).join('') + '</ul>';
    if (extraHtml) html += extraHtml;
    return U.alert(title, html, 'danger');
  };

  U.copyText = function (text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallback(); });
    }
    return Promise.resolve(fallback());
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      return ok;
    }
  };

  U.storage = {
    get: function (k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  U.fileUrl = function (file) { return '/files/' + file; };
  /** 목록·썸네일용 작은 이미지 (서버가 만들 수 없으면 원본으로 자동 전환) */
  U.thumbUrl = function (file) { return '/thumbs/' + file; };

  // ── 페이지 콘텐츠 렌더링 ──
  var textCache = {};
  function fetchText(file) {
    if (textCache[file]) return Promise.resolve(textCache[file]);
    return fetch(U.fileUrl(file)).then(function (r) {
      if (!r.ok) throw new Error('파일을 불러오지 못했습니다 (HTTP ' + r.status + ')');
      return r.text();
    }).then(function (t) { textCache[file] = t; return t; });
  }

  /**
   * stage 안에 페이지 콘텐츠(이미지 / HTML / 코드)를 그린다.
   * cb.onReady(el) – 크기가 확정되면 호출, cb.onError(msg)
   */
  U.renderContent = function (holder, page, cb) {
    holder.innerHTML = '';
    var token = {};
    holder._token = token;
    function alive() { return holder._token === token; }
    function fail(msg) {
      if (!alive()) return;
      holder.innerHTML = '<div class="pg-error">⚠️<br><b>' + U.esc(msg) + '</b><br><span style="color:var(--text-3);font-size:13px">' + U.esc(page.name || '') + '</span></div>';
      cb.onError && cb.onError(msg);
    }
    if (page.type === 'image') {
      var img = new Image();
      img.className = 'pg-img';
      img.decoding = 'async';
      img.alt = page.name || '';
      img.draggable = false;
      img.onload = function () { if (alive()) cb.onReady && cb.onReady(img); };
      img.onerror = function () { fail('이미지를 표시할 수 없습니다. 파일이 손상되었거나 서버에서 찾을 수 없습니다.'); };
      img.src = U.fileUrl(page.file);
      holder.appendChild(img);
      return;
    }
    fetchText(page.file).then(function (text) {
      if (!alive()) return;
      if (page.type === 'html') {
        var fr = document.createElement('iframe');
        fr.className = 'pg-frame';
        fr.setAttribute('sandbox', 'allow-same-origin');
        fr.setAttribute('scrolling', 'no');
        fr.title = page.name || 'HTML';
        var measure = function () {
          try {
            var d = fr.contentDocument;
            var h = Math.max(d.documentElement.scrollHeight, d.body ? d.body.scrollHeight : 0);
            fr.style.height = Math.max(200, h) + 'px';
          } catch (e) { fr.style.height = '1200px'; }
        };
        fr.onload = function () {
          if (!alive()) return;
          measure();
          cb.onReady && cb.onReady(fr);
          setTimeout(function () { if (!alive()) return; var before = fr.style.height; measure(); if (before !== fr.style.height) cb.onResize && cb.onResize(); }, 700);
        };
        fr.srcdoc = text;
        holder.appendChild(fr);
      } else {
        var pre = document.createElement('pre');
        pre.className = 'pg-code';
        pre.innerHTML = text.replace(/\r\n?/g, '\n').split('\n').map(function (l) { return '<span class="ln">' + (U.esc(l) || ' ') + '</span>'; }).join('');
        holder.appendChild(pre);
        cb.onReady && cb.onReady(pre);
      }
    }).catch(function (e) { fail(e.message || '파일을 불러오지 못했습니다.'); });
  };

  // ── 주석 렌더링 ──
  U.renderAnnotations = function (overlay, anns, state) {
    state = state || {};
    overlay.innerHTML = '';
    anns.forEach(function (a) {
      var el = document.createElement('div');
      el.dataset.id = a.id;
      el.style.setProperty('--c', a.color);
      el.style.left = (a.x * 100) + '%';
      el.style.top = (a.y * 100) + '%';
      var cls = 'an ' + (a.kind === 'pin' ? 'an-pin' : 'an-box');
      if (a.done) cls += ' done';
      if (state.selectedId === a.id) cls += ' sel';
      if (state.hoverId === a.id) cls += ' hl';
      if (a.kind === 'pin') {
        el.innerHTML = '<span>' + a.number + '</span>';
      } else {
        el.style.width = (a.width * 100) + '%';
        el.style.height = (a.height * 100) + '%';
        if (a.y * (overlay.clientHeight || 1) < 28) cls += ' badge-in';
        el.innerHTML = '<div class="an-badge">' + a.number + '</div>';
      }
      el.className = cls;
      el.title = '#' + a.number + (a.comment ? ' ' + a.comment.slice(0, 80) : '');
      overlay.appendChild(el);
    });
  };

  U.setHighlight = function (root, id, cls) {
    root.querySelectorAll('.' + cls).forEach(function (n) { n.classList.remove(cls); });
    if (id == null) return;
    root.querySelectorAll('[data-id="' + (window.CSS && CSS.escape ? CSS.escape(String(id)) : id) + '"]').forEach(function (n) { n.classList.add(cls); });
  };

  U.autosize = function (ta) { ta.style.height = 'auto'; ta.style.height = Math.max(60, ta.scrollHeight + 2) + 'px'; };

  global.U = U;
})(window);
