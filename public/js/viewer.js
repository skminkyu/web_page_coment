/* 외부 공유용 읽기 전용 뷰어 – 수정/저장 기능 없음 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var token = location.pathname.split('/').pop();
  var base = '/api/public/share/' + encodeURIComponent(token);
  var meta = null, cache = {}, round = null, pages = [], idx = 0, hoverId = null, selectedId = null;
  var overlay = $('vOverlay');

  function state(html) {
    $('vState').innerHTML = html;
    $('vState').classList.remove('hidden');
    $('vStage').classList.add('hidden');
  }

  U.api('GET', base).then(function (m) {
    meta = m;
    $('vTitle').textContent = m.name;
    document.title = m.name + ' – 검토 결과';
    var keys = Object.keys(m.rounds).filter(function (k) { return m.rounds[k] && m.rounds[k].pageCount > 0; }).sort(function (a, b) { return a - b; });
    if (!keys.length) { state('<div><div style="font-size:40px">📭</div>아직 등록된 검토 내용이 없습니다.</div>'); return; }
    keys.forEach(function (k) {
      var b = U.el('<button class="round-tab">' + k + '차' + (m.rounds[k].completed ? '<span class="done-mark">✓</span>' : '') + '</button>');
      b.dataset.round = k;
      b.onclick = function () { showRound(k); };
      $('vRounds').appendChild(b);
    });
    showRound(keys[keys.length - 1]);
  }).catch(function (e) {
    state('<div><div style="font-size:40px">⚠️</div><b>' + U.esc(e.message) + '</b></div>');
    $('vMain').querySelector('.sidebar').classList.add('hidden');
  });

  function showRound(k) {
    round = k;
    $('vRounds').querySelectorAll('.round-tab').forEach(function (b) { b.classList.toggle('active', b.dataset.round === k); });
    var rm = meta.rounds[k];
    $('vDone').innerHTML = rm.completed ? '<span class="pill success">✅ 확인 완료' + (rm.completedAt ? ' · ' + U.fmtDate(rm.completedAt, false) : '') + '</span>' : '<span class="pill primary">검토 중</span>';
    if (cache[k]) { pages = cache[k]; showPage(0); return; }
    state('<div><div class="spinner" style="margin:0 auto 12px"></div>불러오는 중…</div>');
    U.api('GET', base + '/rounds/' + k).then(function (r) {
      cache[k] = r.pages || [];
      if (round === k) { pages = cache[k]; showPage(0); }
    }).catch(function (e) { state('<div>⚠️ ' + U.esc(e.message) + '</div>'); });
  }

  function showPage(i) {
    idx = i; selectedId = null;
    var page = pages[i];
    $('vNav').classList.toggle('hidden', pages.length < 2);
    $('vLabel').textContent = (i + 1) + ' / ' + pages.length;
    $('vPrev').disabled = i <= 0;
    $('vNext').disabled = i >= pages.length - 1;
    renderThumbs();
    renderList();
    if (!page) { state('<div>이 차수에 등록된 내용이 없습니다.</div>'); return; }
    $('vState').classList.add('hidden');
    $('vStage').classList.remove('hidden');
    overlay.innerHTML = '';
    U.renderContent($('vContent'), page, {
      onReady: render, onResize: render,
      onError: function () { overlay.innerHTML = ''; },
    });
    $('vArea').scrollTop = 0;
  }
  $('vPrev').onclick = function () { if (idx > 0) showPage(idx - 1); };
  $('vNext').onclick = function () { if (idx < pages.length - 1) showPage(idx + 1); };
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft' && idx > 0) showPage(idx - 1);
    if (e.key === 'ArrowRight' && idx < pages.length - 1) showPage(idx + 1);
  });

  function render() {
    var page = pages[idx];
    if (page) U.renderAnnotations(overlay, page.annotations || [], { selectedId: selectedId, hoverId: hoverId });
  }

  function renderThumbs() {
    var w = $('vThumbs');
    w.classList.toggle('hidden', pages.length < 2);
    w.innerHTML = '';
    pages.forEach(function (p, i) {
      var t = document.createElement('div');
      t.className = 'thumb' + (i === idx ? ' active' : '');
      if (p.type === 'image') t.innerHTML = '<img loading="lazy" decoding="async" src="' + U.thumbUrl(p.file) + '" alt="">';
      else t.innerHTML = (p.type === 'html' ? '🌐' : '📄') + '<span class="t-kind">' + (p.type === 'html' ? 'HTML' : 'CODE') + '</span>';
      t.innerHTML += '<span class="t-num">' + (i + 1) + '</span>' + ((p.annotations || []).length ? '<span class="t-cnt">' + p.annotations.length + '</span>' : '');
      t.onclick = function () { showPage(i); };
      w.appendChild(t);
    });
  }

  function renderList() {
    var list = $('vList');
    var anns = (pages[idx] && pages[idx].annotations) || [];
    $('vCount').textContent = anns.length + '개';
    list.innerHTML = anns.length ? '' : '<div class="sb-empty">이 페이지에는 주석이 없습니다.</div>';
    anns.forEach(function (a) {
      var card = U.el('<div class="ac' + (a.done ? ' done' : '') + '"><div class="ac-top"><div class="ac-num"></div><div class="ac-label"></div>' +
        (a.done ? '<span class="pill success">해결</span>' : '') + '</div><div class="ac-text"></div></div>');
      card.dataset.id = a.id;
      card.style.setProperty('--c', a.color);
      card.querySelector('.ac-num').textContent = a.number;
      card.querySelector('.ac-label').textContent = (a.kind === 'pin' ? '📍 지점' : '▭ 영역') + ' · 위치 보기';
      var tx = card.querySelector('.ac-text');
      tx.textContent = a.comment || '(내용 없음)';
      if (!a.comment) tx.classList.add('empty');
      card.onclick = function () { select(a.id); scrollTo(a); };
      card.onmouseenter = function () { hover(a.id); };
      card.onmouseleave = function () { hover(null); };
      list.appendChild(card);
    });
  }

  function hover(id) {
    hoverId = id;
    U.setHighlight(overlay, id, 'hl');
    U.setHighlight($('vList'), id, 'hl');
  }
  function select(id) {
    selectedId = id;
    U.setHighlight(overlay, id, 'sel');
    U.setHighlight($('vList'), id, 'sel');
  }
  function scrollTo(a) {
    var area = $('vArea'), r = overlay.getBoundingClientRect(), ar = area.getBoundingClientRect();
    area.scrollTo({
      top: r.top - ar.top + area.scrollTop + (a.y + (a.height || 0) / 2) * r.height - area.clientHeight / 2,
      left: r.left - ar.left + area.scrollLeft + (a.x + (a.width || 0) / 2) * r.width - area.clientWidth / 2,
      behavior: 'smooth',
    });
  }
  overlay.addEventListener('mouseover', function (e) { var t = e.target.closest('.an'); hover(t ? t.dataset.id : null); });
  overlay.addEventListener('mouseleave', function () { hover(null); });
  overlay.addEventListener('click', function (e) {
    var t = e.target.closest('.an'); if (!t) return;
    select(t.dataset.id);
    var card = $('vList').querySelector('.ac[data-id="' + CSS.escape(t.dataset.id) + '"]');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
})();
