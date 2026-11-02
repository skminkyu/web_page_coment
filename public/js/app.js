/* 상세페이지 주석 검토 – 대시보드 & 에디터 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  var IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg'];
  var HTML_EXTS = ['html', 'htm'];
  var CODE_EXTS = ['css', 'js', 'mjs', 'ts', 'jsx', 'tsx', 'vue', 'txt', 'json', 'md', 'xml', 'scss', 'less', 'svelte'];
  var MAX_MB = 30;
  var serverStatus = null;

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function extOf(name) { var m = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/); return m ? m[1] : ''; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ══════════════════════════════════════════════════════
  //  상태 / 배너 / 백업 칩
  // ══════════════════════════════════════════════════════
  function loadStatus() {
    return U.api('GET', '/api/status').then(function (st) {
      serverStatus = st;
      MAX_MB = st.maxUploadMB || 30;
      $('maxMbLabel').textContent = MAX_MB;
      renderBanners();
      renderBackupChip();
      return st;
    }).catch(function (e) {
      renderBanners(e);
    });
  }

  function renderBanners(err) {
    var html = '';
    if (err) {
      html += '<div class="banner danger">⚠️ <div><b>서버 상태를 확인할 수 없습니다.</b> ' + U.esc(err.message) + '</div></div>';
    }
    var st = serverStatus;
    if (st && st.safeMode) {
      html += '<div class="banner danger">⛔ <div><b>안전 모드 – 저장이 차단되었습니다.</b> ' + U.esc(st.safeMode) +
        '<br>백업 관리에서 정상 백업을 복원하면 해제됩니다.</div><div class="banner-actions"><button class="btn btn-sm" data-open-backup>백업 관리</button></div></div>';
    }
    if (st && st.storageWarning) {
      html += '<div class="banner warning">⚠️ <div><b>영구 저장소 경고:</b> ' + U.esc(st.storageWarning) + '</div></div>';
    }
    if (st && st.recoveredFrom) {
      html += '<div class="banner info">🛟 <div>손상된 데이터 파일을 감지하여 <b>' + U.esc(st.recoveredFrom) + '</b> 에서 자동 복구했습니다. 최근 작업이 맞는지 확인해 주세요.</div></div>';
    }
    if (st && st.backup && st.backup.lastError) {
      html += '<div class="banner warning">⚠️ <div><b>자동 백업 실패</b> (' + U.fmtDate(st.backup.lastError.at) + '): ' + U.esc(st.backup.lastError.message) + '</div><div class="banner-actions"><button class="btn btn-sm" data-open-backup>백업 관리</button></div></div>';
    }
    $('globalBanners').innerHTML = html;
    $('editorBanners').innerHTML = html;
    document.querySelectorAll('[data-open-backup]').forEach(function (b) { b.onclick = openBackupModal; });
  }

  function renderBackupChip() {
    var chip = $('backupChip'), b = serverStatus && serverStatus.backup;
    if (!b) return;
    chip.classList.remove('warn', 'err');
    var last = b.last;
    var text = '자동 백업 매일 ' + b.time;
    if (last) text += ' · 마지막 ' + U.fmtRelative(last.createdAt);
    else text += ' · 아직 백업 없음';
    if (b.lastError) chip.classList.add('err');
    else if (!last || Date.now() - last.createdAt > 26 * 3600 * 1000) chip.classList.add('warn');
    $('backupChipText').textContent = text;
  }
  $('backupChip').addEventListener('click', openBackupModal);

  window.addEventListener('offline', function () { U.toast('인터넷 연결이 끊어졌습니다. 다시 연결될 때까지 저장할 수 없습니다 (작업 내용은 브라우저에 임시 보관됩니다).', 'warning', { duration: 8000 }); });
  window.addEventListener('online', function () { U.toast('인터넷에 다시 연결되었습니다.', 'success'); });

  // ══════════════════════════════════════════════════════
  //  라우팅
  // ══════════════════════════════════════════════════════
  var currentHash = null;
  function parseHash() {
    var m = location.hash.match(/^#\/p\/([\w-]+)\/(\d+)/);
    return m ? { view: 'editor', pid: m[1], round: m[2] } : { view: 'dash' };
  }
  function go(hash) {
    if (location.hash === hash) { route(); return; }
    location.hash = hash;
  }
  async function route() {
    var r = parseHash();
    if (Ed.active && Ed.dirty && location.hash !== currentHash) {
      var ok = await Ed.guardLeave();
      if (!ok) { history.replaceState(null, '', currentHash || '#/'); return; }
    }
    currentHash = location.hash || '#/';
    if (r.view === 'editor') Ed.open(r.pid, r.round);
    else { Ed.close(); showDashboard(); }
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', function (e) {
    if (Ed.active && Ed.dirty) { e.preventDefault(); e.returnValue = ''; return ''; }
  });

  // ══════════════════════════════════════════════════════
  //  대시보드
  // ══════════════════════════════════════════════════════
  var products = [];
  var filter = 'all';

  function showDashboard() {
    $('editorView').classList.add('hidden');
    $('dashView').classList.remove('hidden');
    document.title = '상세페이지 주석 검토';
    loadProducts();
  }

  function loadProducts() {
    var grid = $('productGrid');
    if (!products.length) grid.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    return U.api('GET', '/api/products').then(function (list) {
      products = list;
      renderProducts();
    }).catch(function (e) {
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="icon">⚠️</div><h3>목록을 불러오지 못했습니다</h3><p>' + U.esc(e.message) + '</p><button class="btn" id="retryLoad">다시 시도</button></div>';
      $('retryLoad').onclick = loadProducts;
    });
  }

  function roundKeys(p) { return Object.keys(p.rounds || {}).sort(function (a, b) { return a - b; }); }
  function isAllDone(p) {
    var withData = roundKeys(p).filter(function (k) { return p.rounds[k] && p.rounds[k].pageCount > 0; });
    return withData.length > 0 && withData.every(function (k) { return p.rounds[k].completed; });
  }

  function renderProducts() {
    var grid = $('productGrid');
    var q = $('searchInput').value.trim().toLowerCase();
    var list = products.filter(function (p) {
      if (q && p.name.toLowerCase().indexOf(q) < 0) return false;
      var done = isAllDone(p);
      if (filter === 'done') return done;
      if (filter === 'progress') return !done;
      return true;
    });
    $('productCount').textContent = products.length ? products.length + '개' : '';
    if (!products.length) {
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="icon">📦</div><h3>등록된 제품이 없습니다</h3><p>제품을 추가하고 차수별로 상세페이지를 올려 주석을 달아보세요.</p><button class="btn btn-primary" id="emptyAdd">＋ 첫 제품 추가</button></div>';
      $('emptyAdd').onclick = createProduct;
      return;
    }
    if (!list.length) {
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="icon">🔍</div><h3>조건에 맞는 제품이 없습니다</h3></div>';
      return;
    }
    grid.innerHTML = '';
    list.forEach(function (p) { grid.appendChild(productCard(p)); });
  }

  function productCard(p) {
    var done = isAllDone(p);
    var keys = roundKeys(p);
    var thumbFile = null;
    keys.forEach(function (k) { if (!thumbFile && p.rounds[k] && p.rounds[k].firstFile) thumbFile = p.rounds[k].firstFile; });
    var card = U.el(
      '<div class="product-card' + (done ? ' all-done' : '') + '">' +
        '<div class="pc-head">' +
          (thumbFile ? '<img src="' + U.fileUrl(thumbFile) + '" alt="" style="width:42px;height:52px;object-fit:cover;object-position:top;border-radius:7px;border:1px solid var(--border);flex-shrink:0">' : '<div style="width:42px;height:52px;border-radius:7px;background:var(--surface-3);display:grid;place-items:center;flex-shrink:0;font-size:18px">🗂</div>') +
          '<div class="pc-title"><div class="pc-name"></div><div class="pc-meta"></div></div>' +
          '<div class="pc-actions">' +
            '<button class="btn btn-sm btn-ghost btn-icon" data-act="rename" title="이름 변경">✏️</button>' +
            '<button class="btn btn-sm btn-ghost btn-icon" data-act="delete" title="휴지통으로 이동">🗑</button>' +
          '</div>' +
        '</div>' +
        '<div class="pc-rounds"></div>' +
        '<div class="pc-foot"><span class="grow">' + (done ? '<span class="pill success">✓ 전체 완료</span>' : '') + '</span>' +
          '<button class="btn btn-sm" data-act="share">🔗 공유 링크</button>' +
          '<button class="btn btn-sm btn-primary" data-act="open">열기</button>' +
        '</div>' +
      '</div>');
    card.querySelector('.pc-name').textContent = p.name;
    card.querySelector('.pc-name').title = p.name;
    card.querySelector('.pc-meta').textContent = '최근 수정 ' + U.fmtRelative(p.updatedAt || p.createdAt);
    var roundsEl = card.querySelector('.pc-rounds');
    keys.forEach(function (k) {
      var rd = p.rounds[k];
      var info;
      if (rd && rd.completed) info = '<span class="pill success">✓ 완료</span><span class="hint">' + rd.pageCount + '장 · 주석 ' + rd.annotCount + '</span>';
      else if (rd && rd.pageCount > 0) info = '<span class="pill primary">작성 중</span><span class="hint">' + rd.pageCount + '장 · 주석 ' + rd.annotCount + (rd.openCount ? ' (미해결 ' + rd.openCount + ')' : '') + '</span>';
      else info = '<span class="pill">미작성</span>';
      var row = U.el('<div class="pc-round"><div class="pc-round-label">' + k + '차</div><div class="pc-round-info">' + info + '</div><div class="pc-round-btns"></div></div>');
      var btns = row.querySelector('.pc-round-btns');
      var edit = U.el('<button class="btn btn-sm">편집</button>');
      edit.onclick = function () { go('#/p/' + p.id + '/' + k); };
      btns.appendChild(edit);
      var comp = U.el('<button class="btn btn-sm ' + (rd && rd.completed ? 'is-active' : '') + '">' + (rd && rd.completed ? '완료 취소' : '완료 처리') + '</button>');
      comp.disabled = !(rd && rd.pageCount > 0) && !(rd && rd.completed);
      comp.title = comp.disabled ? '내용이 있는 차수만 완료 처리할 수 있습니다' : '';
      comp.onclick = function () { toggleComplete(p, k, !(rd && rd.completed)); };
      btns.appendChild(comp);
      roundsEl.appendChild(row);
    });
    card.querySelector('[data-act="open"]').onclick = function () {
      var target = keys.filter(function (k) { return p.rounds[k] && p.rounds[k].pageCount > 0; }).pop() || keys[0] || '1';
      go('#/p/' + p.id + '/' + target);
    };
    card.querySelector('[data-act="share"]').onclick = function () { openShareModal(p.id, p.shareToken, p.name); };
    card.querySelector('[data-act="rename"]').onclick = function () { renameProduct(p.id, p.name).then(loadProducts); };
    card.querySelector('[data-act="delete"]').onclick = function () { deleteProduct(p); };
    return card;
  }

  function toggleComplete(p, round, val) {
    return U.api('PATCH', '/api/products/' + p.id + '/rounds/' + round + '/complete', { completed: val })
      .then(function () {
        U.toast(round + '차 ' + (val ? '완료 처리했습니다.' : '완료를 취소했습니다.'), 'success');
        loadProducts();
      })
      .catch(function (e) { U.showError('완료 상태를 바꾸지 못했습니다', e); });
  }

  async function createProduct() {
    var name = await U.prompt('제품 추가', '제품명', '', '추가');
    if (!name) return;
    try {
      var p = await U.api('POST', '/api/products', { name: name });
      U.toast('"' + p.name + '" 제품을 추가했습니다.', 'success');
      go('#/p/' + p.id + '/1');
    } catch (e) { U.showError('제품을 추가하지 못했습니다', e); }
  }

  async function renameProduct(id, oldName) {
    var name = await U.prompt('제품명 변경', '새 제품명', oldName, '변경');
    if (!name || name === oldName) return null;
    try {
      await U.api('PATCH', '/api/products/' + id, { name: name });
      U.toast('제품명을 변경했습니다.', 'success');
      return name;
    } catch (e) { U.showError('제품명을 바꾸지 못했습니다', e); return null; }
  }

  async function deleteProduct(p) {
    var ok = await U.confirm('제품을 휴지통으로 옮길까요?', '<p><b>' + U.esc(p.name) + '</b> 제품을 휴지통으로 옮깁니다.</p><p class="hint">휴지통에서 언제든 복원할 수 있고, 공유 링크는 복원 전까지 열리지 않습니다.</p>', '휴지통으로 이동', 'danger');
    if (!ok) return;
    try {
      await U.api('DELETE', '/api/products/' + p.id);
      U.toast('휴지통으로 옮겼습니다.', 'success', {
        action: { label: '되돌리기', onClick: function () { U.api('POST', '/api/products/' + p.id + '/restore').then(loadProducts); } },
      });
      loadProducts();
    } catch (e) { U.showError('삭제하지 못했습니다', e); }
  }

  async function openTrash() {
    var node = U.el('<div><div class="hint" style="margin-bottom:10px">휴지통의 제품은 복원하거나 영구 삭제할 수 있습니다. 영구 삭제해도 백업에는 남아 있습니다.</div><div id="trashBody">불러오는 중…</div></div>');
    var render = function () {
      U.api('GET', '/api/products?deleted=1').then(function (list) {
        var body = node.querySelector('#trashBody');
        if (!list.length) { body.innerHTML = '<div class="sb-empty">휴지통이 비어 있습니다.</div>'; return; }
        body.innerHTML = '<table class="table"><thead><tr><th>제품명</th><th>삭제일</th><th></th></tr></thead><tbody></tbody></table>';
        var tb = body.querySelector('tbody');
        list.forEach(function (p) {
          var tr = U.el('<tr><td></td><td>' + U.fmtDate(p.deletedAt) + '</td><td class="actions"><button class="btn btn-sm" data-a="restore">복원</button><button class="btn btn-sm btn-danger" data-a="purge">영구 삭제</button></td></tr>');
          tr.firstChild.textContent = p.name;
          tr.querySelector('[data-a="restore"]').onclick = function () {
            U.api('POST', '/api/products/' + p.id + '/restore').then(function () { U.toast('복원했습니다.', 'success'); render(); loadProducts(); }, function (e) { U.showError('복원 실패', e); });
          };
          tr.querySelector('[data-a="purge"]').onclick = async function () {
            if (!await U.confirm('영구 삭제', '<p><b>' + U.esc(p.name) + '</b> 을(를) 영구 삭제합니다. 되돌릴 수 없습니다 (이전 백업에는 남아 있음).</p>', '영구 삭제', 'danger')) return;
            U.api('DELETE', '/api/products/' + p.id + '?permanent=1').then(render, function (e) { U.showError('삭제 실패', e); });
          };
          tb.appendChild(tr);
        });
      }).catch(function (e) { node.querySelector('#trashBody').textContent = '불러오기 실패: ' + e.message; });
    };
    render();
    await U.modal({ title: '휴지통', icon: '🗑', node: node, wide: true, buttons: [{ label: '닫기', value: true }] });
  }

  $('newProductBtn').onclick = createProduct;
  $('refreshBtn').onclick = function () { loadProducts(); loadStatus(); };
  $('trashBtn').onclick = openTrash;
  $('searchInput').addEventListener('input', renderProducts);
  $('filterSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    filter = b.dataset.filter;
    this.querySelectorAll('button').forEach(function (x) { x.classList.toggle('active', x === b); });
    renderProducts();
  });

  // ── 공유 모달 ──
  async function openShareModal(pid, token, name) {
    var node = U.el(
      '<div>' +
        '<p>아래 링크를 받은 사람은 <b>읽기 전용</b>으로 모든 차수의 이미지와 주석을 볼 수 있습니다. 수정·삭제는 할 수 없습니다.</p>' +
        '<div class="share-box"><input class="input" readonly id="shareUrl"><button class="btn btn-primary" id="shareCopy">복사</button><a class="btn" id="shareOpen" target="_blank" rel="noopener">열기</a></div>' +
        '<div class="section-title">링크 재발급</div>' +
        '<p class="hint">링크가 외부에 잘못 전달되었다면 재발급하세요. 기존 링크는 즉시 사용할 수 없게 됩니다.</p>' +
        '<button class="btn btn-sm btn-danger" id="shareReset">링크 재발급</button>' +
      '</div>');
    var set = function (t) {
      var url = location.origin + '/s/' + t;
      node.querySelector('#shareUrl').value = url;
      node.querySelector('#shareOpen').href = url;
    };
    set(token);
    node.querySelector('#shareCopy').onclick = function () {
      U.copyText(node.querySelector('#shareUrl').value).then(function (ok) {
        if (ok) U.toast('공유 링크를 복사했습니다.', 'success');
        else { node.querySelector('#shareUrl').select(); U.toast('자동 복사가 안 됩니다. 선택된 링크를 Ctrl+C로 복사하세요.', 'warning'); }
      });
    };
    node.querySelector('#shareReset').onclick = async function () {
      if (!await U.confirm('공유 링크 재발급', '<p>기존 링크는 더 이상 열리지 않습니다. 계속할까요?</p>', '재발급', 'danger')) return;
      try {
        var r = await U.api('POST', '/api/products/' + pid + '/share/reset');
        set(r.shareToken);
        if (Ed.active && Ed.product && Ed.product.id === pid) Ed.product.shareToken = r.shareToken;
        products.forEach(function (p) { if (p.id === pid) p.shareToken = r.shareToken; });
        U.toast('새 링크를 발급했습니다.', 'success');
      } catch (e) { U.showError('재발급 실패', e); }
    };
    await U.modal({ title: '공유 링크 · ' + name, icon: '🔗', node: node, buttons: [{ label: '닫기', value: true }],
      onOpen: function () { node.querySelector('#shareUrl').select(); } });
  }

  // ══════════════════════════════════════════════════════
  //  에디터
  // ══════════════════════════════════════════════════════
  var Ed = {
    active: false, product: null, round: '1', pages: [], idx: -1, revision: 0, completed: false,
    dirty: false, saving: false, uploading: 0, tool: 'box', color: '#e5484d', selectedId: null, hoverId: null, drag: null,
    loadToken: 0,
  };

  Ed.draftKey = function () { return 'wpc-draft:' + Ed.product.id + ':' + Ed.round; };
  Ed.editable = function () { return !Ed.completed && !(serverStatus && serverStatus.safeMode); };
  Ed.page = function () { return Ed.pages[Ed.idx] || null; };

  Ed.open = async function (pid, round) {
    var token = ++Ed.loadToken;
    Ed.active = true;
    $('dashView').classList.add('hidden');
    $('editorView').classList.remove('hidden');
    $('loadingMask').classList.remove('hidden');
    try {
      var product = await U.api('GET', '/api/products/' + pid);
      if (token !== Ed.loadToken) return;
      if (!product.rounds[round]) {
        var first = Object.keys(product.rounds).sort(function (a, b) { return a - b; })[0] || '1';
        history.replaceState(null, '', '#/p/' + pid + '/' + first);
        currentHash = location.hash;
        round = first;
      }
      Ed.product = product;
      Ed.round = round;
      document.title = product.name + ' · ' + round + '차 – 주석 검토';
      $('edTitle').textContent = product.name;
      $('edTitle').title = product.name;
      Ed.renderRoundTabs();
      await Ed.loadRound(token);
    } catch (e) {
      $('loadingMask').classList.add('hidden');
      if (token !== Ed.loadToken) return;
      await U.showError('불러오지 못했습니다', e);
      Ed.dirty = false;
      go('#/');
    }
  };

  Ed.close = function () {
    Ed.active = false; Ed.dirty = false; Ed.product = null; Ed.pages = []; Ed.idx = -1;
    Ed.loadToken++;
  };

  Ed.loadRound = async function (token) {
    var rd = await U.api('GET', '/api/products/' + Ed.product.id + '/rounds/' + Ed.round);
    if (token !== Ed.loadToken) return;
    Ed.pages = rd.pages || [];
    Ed.revision = rd.revision || 0;
    Ed.completed = !!rd.completed;
    Ed.dirty = false;
    Ed.selectedId = null;
    Ed.renderLock();
    // 저장되지 않은 임시 작업 복구 확인
    var draft = U.storage.get(Ed.draftKey());
    if (draft && Array.isArray(draft.pages) && JSON.stringify(draft.pages) !== JSON.stringify(Ed.pages)) {
      $('loadingMask').classList.add('hidden');
      var newer = draft.baseRevision !== Ed.revision;
      var choice = await U.modal({
        title: '저장되지 않은 작업이 있습니다', tone: 'warning', icon: '🛟',
        html: '<p>' + U.fmtDate(draft.at) + ' 에 작업하던 내용(페이지 ' + draft.pages.length + '개)이 저장되지 않은 채 이 브라우저에 남아 있습니다.</p>' +
          (newer ? '<p><b>주의:</b> 그 이후 서버에 다른 저장 내역이 있습니다. 복구 후 저장하면 어느 쪽을 남길지 다시 묻습니다.</p>' : '') +
          '<p class="hint">복구하면 편집 화면에 불러오며, [저장]을 눌러야 서버에 반영됩니다.</p>',
        buttons: [{ label: '버리기', value: 'discard' }, { label: '복구하기', value: 'restore', kind: 'primary' }],
        dismissValue: 'later', persistent: true,
      });
      if (token !== Ed.loadToken) return;
      if (choice === 'restore') {
        Ed.pages = draft.pages;
        Ed.baseRevisionOverride = draft.baseRevision;
        Ed.markDirty(true);
        U.toast('임시 저장된 작업을 복구했습니다. 저장 버튼을 눌러 반영하세요.', 'success');
      } else if (choice === 'discard') {
        U.storage.del(Ed.draftKey());
      }
    }
    Ed.renderRoundTabs();
    Ed.renderLock();
    Ed.updateSaveStatus();
    Ed.showPage(Ed.pages.length ? 0 : -1);
  };

  // ── 차수 탭 ──
  Ed.renderRoundTabs = function () {
    var wrap = $('roundTabs');
    wrap.innerHTML = '';
    Object.keys(Ed.product.rounds).sort(function (a, b) { return a - b; }).forEach(function (k) {
      var meta = Ed.product.rounds[k];
      var b = U.el('<button class="round-tab' + (k === Ed.round ? ' active' : '') + '">' + k + '차' + (meta && meta.completed ? '<span class="done-mark">✓</span>' : '') + '</button>');
      b.title = meta && meta.completed ? '완료된 차수' : (meta && meta.pageCount ? meta.pageCount + '장' : '미작성');
      b.onclick = function () { if (k !== Ed.round) go('#/p/' + Ed.product.id + '/' + k); };
      wrap.appendChild(b);
    });
  };

  $('addRoundBtn').onclick = async function () {
    if (Ed.dirty && !(await Ed.guardLeave())) return;
    try {
      var r = await U.api('POST', '/api/products/' + Ed.product.id + '/rounds');
      Ed.product.rounds[r.round] = { pageCount: 0, annotCount: 0, completed: false };
      Ed.dirty = false;
      U.toast(r.round + '차를 추가했습니다.', 'success');
      go('#/p/' + Ed.product.id + '/' + r.round);
    } catch (e) { U.showError('차수를 추가하지 못했습니다', e); }
  };

  $('renameBtn').onclick = async function () {
    var n = await renameProduct(Ed.product.id, Ed.product.name);
    if (n) { Ed.product.name = n; $('edTitle').textContent = n; }
  };
  $('backBtn').onclick = function () { go('#/'); };
  $('shareBtn').onclick = function () { openShareModal(Ed.product.id, Ed.product.shareToken, Ed.product.name); };

  // ── 잠금(완료) 상태 ──
  Ed.renderLock = function () {
    var editable = Ed.editable();
    $('lockedBanner').classList.toggle('hidden', !Ed.completed);
    $('edTools').querySelectorAll('button, input').forEach(function (el) {
      if (el.closest('#pageNav')) return;
      el.disabled = !editable;
    });
    $('saveBtn').disabled = !editable;
    var cb = $('completeBtn');
    cb.textContent = Ed.completed ? '✓ ' + Ed.round + '차 완료됨' : '✓ ' + Ed.round + '차 완료 처리';
    cb.className = 'btn btn-sm ' + (Ed.completed ? 'is-active' : 'btn-success');
    cb.title = Ed.completed ? '클릭하면 완료를 취소합니다' : '이 차수의 검토를 완료 처리합니다 (완료 후 읽기 전용)';
    $('overlay').className = 'overlay ' + (editable ? 'editable tool-' + Ed.tool : 'readonly');
  };

  async function setRoundComplete(val) {
    if (val && Ed.dirty) {
      var c = await U.confirm('저장되지 않은 변경이 있습니다', '<p>완료 처리하기 전에 먼저 저장해야 합니다. 저장 후 완료 처리할까요?</p>', '저장 후 완료');
      if (!c) return;
      if (!(await Ed.save())) return;
    }
    if (val && !Ed.pages.length) { U.alert('완료 처리할 수 없습니다', '<p>내용이 없는 차수는 완료 처리할 수 없습니다.</p>', 'warning'); return; }
    if (val) {
      var open = Ed.pages.reduce(function (s, p) { return s + p.annotations.filter(function (a) { return !a.done; }).length; }, 0);
      var ok = await U.confirm(Ed.round + '차 완료 처리', '<p>' + Ed.round + '차 검토를 완료 처리합니다. 완료된 차수는 읽기 전용이 되며, 공유 링크에 <b>“확인 완료”</b>로 표시됩니다.</p>' +
        (open ? '<p><b>미해결 주석이 ' + open + '개</b> 남아 있습니다.</p>' : ''), '완료 처리', 'info');
      if (!ok) return;
    }
    try {
      var r = await U.api('PATCH', '/api/products/' + Ed.product.id + '/rounds/' + Ed.round + '/complete', { completed: val });
      Ed.completed = val;
      Ed.product.rounds[Ed.round] = r.meta;
      Ed.renderRoundTabs(); Ed.renderLock(); Ed.renderOverlay(); Ed.renderList();
      U.toast(Ed.round + '차 ' + (val ? '완료 처리했습니다.' : '완료를 취소했습니다. 다시 수정할 수 있습니다.'), 'success');
    } catch (e) { U.showError('완료 상태를 바꾸지 못했습니다', e); }
  }
  $('completeBtn').onclick = function () { setRoundComplete(!Ed.completed); };
  $('unlockBtn').onclick = function () { setRoundComplete(false); };

  // ── 저장 상태 / 임시 저장 ──
  var draftTimer = null;
  Ed.markDirty = function (skipDraft) {
    Ed.dirty = true;
    Ed.updateSaveStatus();
    if (skipDraft === true) { Ed.writeDraft(); return; }
    clearTimeout(draftTimer);
    draftTimer = setTimeout(Ed.writeDraft, 400);
  };
  Ed.writeDraft = function () {
    if (!Ed.product || !Ed.dirty) return;
    var base = Ed.baseRevisionOverride != null ? Ed.baseRevisionOverride : Ed.revision;
    var ok = U.storage.set(Ed.draftKey(), { pages: Ed.pages, baseRevision: base, at: Date.now() });
    if (!ok && !Ed.draftWarned) {
      Ed.draftWarned = true;
      U.toast('브라우저 임시 저장 공간이 부족합니다. 가능한 빨리 저장해 주세요.', 'warning', { duration: 8000 });
    }
  };
  Ed.updateSaveStatus = function (state, msg) {
    var el = $('saveStatus');
    el.className = 'save-status';
    if (state === 'saving') { el.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:2px"></span>저장 중…'; return; }
    if (state === 'error') { el.classList.add('err'); el.innerHTML = '<span class="dot"></span>' + U.esc(msg || '저장 실패'); return; }
    if (Ed.uploading) { el.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:2px"></span>업로드 중…'; return; }
    if (Ed.dirty) { el.classList.add('dirty'); el.innerHTML = '<span class="dot"></span>저장되지 않은 변경'; return; }
    if (state === 'saved') { el.classList.add('ok'); el.innerHTML = '<span class="dot"></span>저장됨'; return; }
    var meta = Ed.product && Ed.product.rounds[Ed.round];
    el.textContent = meta && meta.updatedAt ? '마지막 저장 ' + U.fmtRelative(meta.updatedAt) : '';
  };

  // ── 저장 ──
  Ed.save = async function (opts) {
    opts = opts || {};
    if (!Ed.product || Ed.saving) return false;
    if (!Ed.editable()) { U.alert('저장할 수 없습니다', '<p>' + (Ed.completed ? '완료된 차수는 수정할 수 없습니다. 먼저 완료를 취소하세요.' : '서버가 안전 모드입니다.') + '</p>', 'warning'); return false; }
    if (Ed.uploading) { U.alert('업로드가 진행 중입니다', '<p>파일 업로드가 끝난 뒤 다시 저장해 주세요.</p>', 'warning'); return false; }
    if (!Ed.dirty && !opts.force) { U.toast('변경된 내용이 없습니다.', 'info'); return true; }
    Ed.saving = true;
    Ed.updateSaveStatus('saving');
    var base = Ed.baseRevisionOverride != null ? Ed.baseRevisionOverride : Ed.revision;
    try {
      var r = await U.api('PUT', '/api/products/' + Ed.product.id + '/rounds/' + Ed.round,
        { pages: Ed.pages, baseRevision: base, allowShrink: !!opts.allowShrink }, { timeout: 60000 });
      Ed.revision = r.revision;
      Ed.baseRevisionOverride = null;
      Ed.dirty = false;
      Ed.product.rounds[Ed.round] = r.meta;
      U.storage.del(Ed.draftKey());
      Ed.saving = false;
      Ed.updateSaveStatus('saved');
      Ed.renderRoundTabs();
      U.toast('저장했습니다.', 'success', { duration: 2000 });
      return true;
    } catch (err) {
      Ed.saving = false;
      Ed.writeDraft();
      Ed.updateSaveStatus('error', err.network ? '연결 실패 – 저장 안 됨' : '저장 실패');
      return Ed.handleSaveError(err);
    }
  };

  Ed.handleSaveError = async function (err) {
    var keepNote = '<p class="hint">✅ 작업 내용은 사라지지 않았습니다. 화면과 이 브라우저에 그대로 보관되어 있습니다.</p>';
    if (err.code === 'SHRINK_GUARD') {
      var ok = await U.confirm('페이지 수가 줄어듭니다', '<p>' + U.esc(err.message) + '</p><p>삭제한 페이지가 맞다면 계속하세요. 실수라면 취소 후 확인해 주세요. (이전 버전은 “버전 기록”에서 되돌릴 수 있습니다)</p>', '계속 저장');
      if (ok) return Ed.save({ allowShrink: true, force: true });
      return false;
    }
    if (err.code === 'CONFLICT') {
      var c = await U.modal({
        title: '다른 곳에서 먼저 저장했습니다', tone: 'warning',
        html: '<p>내가 편집하는 동안 다른 사람(또는 다른 브라우저 창)이 이 차수를 ' + U.fmtDate(err.data.serverUpdatedAt) + ' 에 저장했습니다.</p>' +
          '<ul><li><b>내 버전으로 저장</b>: 지금 화면의 내용으로 덮어씁니다. (상대방 내용은 “버전 기록”에 남습니다)</li>' +
          '<li><b>서버 버전 불러오기</b>: 내 변경을 버리고 최신 내용을 불러옵니다.</li></ul>' + keepNote,
        buttons: [{ label: '취소', value: null }, { label: '서버 버전 불러오기', value: 'reload' }, { label: '내 버전으로 저장', value: 'mine', kind: 'primary' }],
      });
      if (c === 'mine') { Ed.baseRevisionOverride = err.data.serverRevision; return Ed.save({ allowShrink: true, force: true }); }
      if (c === 'reload') { U.storage.del(Ed.draftKey()); Ed.dirty = false; Ed.baseRevisionOverride = null; await Ed.loadRound(Ed.loadToken); }
      return false;
    }
    if (err.code === 'ROUND_COMPLETED') {
      await U.alert('완료된 차수입니다', '<p>' + U.esc(err.message) + '</p>' + keepNote, 'warning');
      return false;
    }
    var choice = await U.modal({
      title: '저장하지 못했습니다', tone: 'danger',
      html: '<p>' + U.esc(err.message) + '</p>' +
        (err.data && err.data.problems ? '<ul>' + err.data.problems.map(function (p) { return '<li>' + U.esc(p) + '</li>'; }).join('') + '</ul>' : '') +
        keepNote + '<p class="hint">문제가 계속되면 [작업 내보내기]로 파일을 받아 두세요.</p>',
      buttons: [{ label: '작업 내보내기', value: 'export' }, { label: '닫기', value: null }, { label: '다시 시도', value: 'retry', kind: 'primary' }],
    });
    if (choice === 'retry') return Ed.save({ force: true });
    if (choice === 'export') Ed.exportJson();
    return false;
  };

  Ed.exportJson = function () {
    var blob = new Blob([JSON.stringify({ product: Ed.product.name, productId: Ed.product.id, round: Ed.round, exportedAt: new Date().toISOString(), pages: Ed.pages }, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = Ed.product.name + '_' + Ed.round + '차_작업내보내기.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  };

  $('saveBtn').onclick = function () { Ed.save(); };

  Ed.guardLeave = async function () {
    if (!Ed.dirty) return true;
    var c = await U.modal({
      title: '저장되지 않은 변경이 있습니다', tone: 'warning',
      html: '<p>이동하기 전에 저장할까요?</p><p class="hint">저장하지 않고 이동해도 이 브라우저에 임시 보관되어, 다시 열면 복구할 수 있습니다.</p>',
      buttons: [{ label: '취소', value: 'cancel' }, { label: '저장하지 않고 이동', value: 'leave' }, { label: '저장 후 이동', value: 'save', kind: 'primary' }],
      dismissValue: 'cancel',
    });
    if (c === 'save') return Ed.save();
    if (c === 'leave') { Ed.writeDraft(); Ed.dirty = false; return true; }
    return false;
  };

  // ── 페이지 표시 ──
  Ed.showPage = function (idx) {
    Ed.idx = idx;
    Ed.selectedId = null;
    var page = Ed.page();
    $('dropzone').classList.toggle('hidden', !!page);
    $('stage').classList.toggle('hidden', !page);
    Ed.renderNav();
    Ed.renderThumbs();
    Ed.renderList();
    if (!page) { $('loadingMask').classList.add('hidden'); $('overlay').innerHTML = ''; return; }
    $('loadingMask').classList.remove('hidden');
    $('overlay').innerHTML = '';
    U.renderContent($('contentHolder'), page, {
      onReady: function (el) {
        $('loadingMask').classList.add('hidden');
        if (page.type === 'image' && el.naturalWidth && (!page.width || !page.height)) { page.width = el.naturalWidth; page.height = el.naturalHeight; }
        Ed.renderOverlay();
      },
      onResize: function () { Ed.renderOverlay(); },
      onError: function (msg) {
        $('loadingMask').classList.add('hidden');
        U.toast((idx + 1) + '번째 페이지: ' + msg + ' “현재 교체”로 다른 파일을 올리거나 페이지를 삭제하세요.', 'error', { duration: 9000 });
      },
    });
    $('canvasArea').scrollTop = 0;
  };

  Ed.renderNav = function () {
    var n = Ed.pages.length;
    $('pageLabel').textContent = n ? (Ed.idx + 1) + ' / ' + n : '0 / 0';
    $('prevBtn').disabled = Ed.idx <= 0;
    $('nextBtn').disabled = Ed.idx >= n - 1;
    var editable = Ed.editable();
    $('replaceBtn').disabled = !editable || !n;
    $('deletePageBtn').disabled = !editable || !n;
  };
  $('prevBtn').onclick = function () { if (Ed.idx > 0) Ed.showPage(Ed.idx - 1); };
  $('nextBtn').onclick = function () { if (Ed.idx < Ed.pages.length - 1) Ed.showPage(Ed.idx + 1); };

  Ed.renderThumbs = function () {
    var wrap = $('thumbs');
    wrap.classList.toggle('hidden', Ed.pages.length < 2);
    wrap.innerHTML = '';
    var dragFrom = null;
    Ed.pages.forEach(function (p, i) {
      var t = document.createElement('div');
      t.className = 'thumb' + (i === Ed.idx ? ' active' : '');
      t.title = (i + 1) + '. ' + (p.name || '');
      if (p.type === 'image') t.innerHTML = '<img loading="lazy" src="' + U.fileUrl(p.file) + '" alt="">';
      else t.innerHTML = (p.type === 'html' ? '🌐' : '📄') + '<span class="t-kind">' + (p.type === 'html' ? 'HTML' : 'CODE') + '</span>';
      t.innerHTML += '<span class="t-num">' + (i + 1) + '</span>' + (p.annotations.length ? '<span class="t-cnt">' + p.annotations.length + '</span>' : '');
      t.onclick = function () { if (i !== Ed.idx) Ed.showPage(i); };
      if (Ed.editable()) {
        t.draggable = true;
        t.addEventListener('dragstart', function (e) { dragFrom = i; t.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
        t.addEventListener('dragend', function () { t.classList.remove('dragging'); });
        t.addEventListener('dragover', function (e) { if (dragFrom !== null) { e.preventDefault(); t.classList.add('drop-target'); } });
        t.addEventListener('dragleave', function () { t.classList.remove('drop-target'); });
        t.addEventListener('drop', function (e) {
          e.preventDefault(); e.stopPropagation(); t.classList.remove('drop-target');
          if (dragFrom === null || dragFrom === i) return;
          var cur = Ed.page();
          var moved = Ed.pages.splice(dragFrom, 1)[0];
          Ed.pages.splice(i, 0, moved);
          Ed.idx = Ed.pages.indexOf(cur);
          dragFrom = null;
          Ed.markDirty();
          Ed.renderThumbs(); Ed.renderNav();
        });
      }
      wrap.appendChild(t);
    });
    var active = wrap.querySelector('.thumb.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  // ── 주석 오버레이 ──
  var overlay = $('overlay');
  Ed.renderOverlay = function () {
    var page = Ed.page();
    if (!page) return;
    U.renderAnnotations(overlay, page.annotations, { selectedId: Ed.selectedId, hoverId: Ed.hoverId });
  };
  function findAnn(id) { var p = Ed.page(); return p && p.annotations.find(function (a) { return String(a.id) === String(id); }); }
  function relPos(e) {
    var r = overlay.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1), w: r.width, h: r.height };
  }

  overlay.addEventListener('pointerdown', function (e) {
    var page = Ed.page();
    if (!page || e.button !== 0) return;
    var hit = e.target.closest('.an');
    if (!Ed.editable()) { if (hit) Ed.select(hit.dataset.id, true); return; }
    var pos = relPos(e);
    e.preventDefault();
    try { overlay.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    if (hit) {
      var a = findAnn(hit.dataset.id);
      Ed.drag = { mode: 'move', a: a, el: hit, sx: pos.x, sy: pos.y, ox: a.x, oy: a.y, moved: false };
    } else if (Ed.tool === 'box') {
      var d = document.createElement('div');
      d.className = 'an-draft';
      d.style.setProperty('--c', Ed.color);
      overlay.appendChild(d);
      Ed.drag = { mode: 'draw', el: d, sx: pos.x, sy: pos.y };
    } else {
      Ed.drag = { mode: 'pin', sx: pos.x, sy: pos.y };
    }
  });
  overlay.addEventListener('pointermove', function (e) {
    var d = Ed.drag; if (!d) return;
    var pos = relPos(e);
    if (d.mode === 'move') {
      var dx = pos.x - d.sx, dy = pos.y - d.sy;
      if (!d.moved && Math.abs(dx * pos.w) < 4 && Math.abs(dy * pos.h) < 4) return;
      d.moved = true;
      d.a.x = clamp(d.ox + dx, 0, 1 - (d.a.width || 0));
      d.a.y = clamp(d.oy + dy, 0, 1 - (d.a.height || 0));
      d.el.style.left = (d.a.x * 100) + '%';
      d.el.style.top = (d.a.y * 100) + '%';
    } else if (d.mode === 'draw') {
      d.el.style.left = (Math.min(d.sx, pos.x) * 100) + '%';
      d.el.style.top = (Math.min(d.sy, pos.y) * 100) + '%';
      d.el.style.width = (Math.abs(pos.x - d.sx) * 100) + '%';
      d.el.style.height = (Math.abs(pos.y - d.sy) * 100) + '%';
    }
  });
  overlay.addEventListener('pointerup', function (e) {
    var d = Ed.drag; if (!d) return;
    Ed.drag = null;
    var pos = relPos(e);
    if (d.mode === 'move') {
      if (d.moved) { Ed.markDirty(); Ed.renderOverlay(); }
      else Ed.select(d.a.id, true);
    } else if (d.mode === 'draw') {
      d.el.remove();
      var w = Math.abs(pos.x - d.sx), h = Math.abs(pos.y - d.sy);
      if (w * pos.w < 8 || h * pos.h < 8) {
        if (w * pos.w < 3 && h * pos.h < 3) U.toast('드래그해서 박스를 그리세요. 한 지점만 표시하려면 “핀” 도구를 쓰세요.', 'info', { duration: 2500 });
        return;
      }
      Ed.addAnnotation({ kind: 'box', x: Math.min(d.sx, pos.x), y: Math.min(d.sy, pos.y), width: w, height: h });
    } else if (d.mode === 'pin') {
      Ed.addAnnotation({ kind: 'pin', x: d.sx, y: d.sy, width: 0, height: 0 });
    }
  });
  overlay.addEventListener('pointercancel', function () {
    if (Ed.drag && Ed.drag.mode === 'draw') Ed.drag.el.remove();
    Ed.drag = null; Ed.renderOverlay();
  });
  overlay.addEventListener('mouseover', function (e) {
    var hit = e.target.closest('.an');
    Ed.setHover(hit ? hit.dataset.id : null);
  });
  overlay.addEventListener('mouseleave', function () { Ed.setHover(null); });

  Ed.setHover = function (id) {
    if (Ed.hoverId === id) return;
    Ed.hoverId = id;
    U.setHighlight(overlay, id, 'hl');
    U.setHighlight($('annList'), id, 'hl');
  };

  Ed.select = function (id, scrollList) {
    Ed.selectedId = id;
    U.setHighlight(overlay, id, 'sel');
    U.setHighlight($('annList'), id, 'sel');
    if (scrollList && id != null) {
      var card = $('annList').querySelector('.ac[data-id="' + CSS.escape(String(id)) + '"]');
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        var ta = card.querySelector('textarea');
        if (ta && Ed.editable()) ta.focus({ preventScroll: true });
      }
    }
  };

  Ed.scrollToAnn = function (a) {
    var area = $('canvasArea'), r = overlay.getBoundingClientRect(), ar = area.getBoundingClientRect();
    var y = r.top - ar.top + area.scrollTop + (a.y + (a.height || 0) / 2) * r.height;
    var x = r.left - ar.left + area.scrollLeft + (a.x + (a.width || 0) / 2) * r.width;
    area.scrollTo({ top: y - area.clientHeight / 2, left: x - area.clientWidth / 2, behavior: 'smooth' });
  };

  Ed.addAnnotation = function (geom) {
    var page = Ed.page();
    var a = Object.assign({ id: uid(), number: page.nextNum || 1, color: Ed.color, comment: '', done: false, createdAt: Date.now() }, geom);
    page.nextNum = a.number + 1;
    page.annotations.push(a);
    Ed.markDirty();
    Ed.selectedId = a.id;
    Ed.renderOverlay();
    Ed.renderList();
    Ed.renderThumbs();
    Ed.select(a.id, true);
  };

  Ed.deleteAnnotation = function (id) {
    var page = Ed.page();
    var i = page.annotations.findIndex(function (a) { return String(a.id) === String(id); });
    if (i < 0) return;
    var removed = page.annotations.splice(i, 1)[0];
    Ed.markDirty();
    Ed.selectedId = null;
    Ed.renderOverlay(); Ed.renderList(); Ed.renderThumbs();
    U.toast('주석 #' + removed.number + ' 을 삭제했습니다.', 'info', {
      action: { label: '되돌리기', onClick: function () {
        if (Ed.page() !== page) return;
        page.annotations.splice(i, 0, removed);
        Ed.markDirty(); Ed.renderOverlay(); Ed.renderList(); Ed.renderThumbs();
      } },
    });
  };

  // ── 사이드바 ──
  Ed.renderList = function () {
    var list = $('annList');
    var page = Ed.page();
    var anns = page ? page.annotations : [];
    var total = Ed.pages.reduce(function (s, p) { return s + p.annotations.length; }, 0);
    var open = Ed.pages.reduce(function (s, p) { return s + p.annotations.filter(function (a) { return !a.done; }).length; }, 0);
    $('annCount').textContent = '이 페이지 ' + anns.length + '개';
    $('roundAnnSummary').textContent = Ed.pages.length ? Ed.round + '차 전체 ' + total + '개 · 미해결 ' + open : '';
    list.innerHTML = '';
    if (!page) { list.innerHTML = '<div class="sb-empty">파일을 올리면 이곳에 주석이 표시됩니다.</div>'; return; }
    if (!anns.length) {
      list.innerHTML = Ed.editable()
        ? '<div class="sb-empty">이미지 위를 <b>드래그</b>해서 박스를 그리거나<br><b>핀</b> 도구로 클릭해 지점을 지정하세요.<br><br><span style="font-size:12px">단축키: B 박스 · P 핀 · Delete 삭제 · Ctrl+S 저장</span></div>'
        : '<div class="sb-empty">이 페이지에는 주석이 없습니다.</div>';
      return;
    }
    var editable = Ed.editable();
    anns.forEach(function (a) {
      var card = U.el(
        '<div class="ac' + (a.done ? ' done' : '') + '">' +
          '<div class="ac-top"><div class="ac-num"></div><div class="ac-label"></div>' +
          '<label class="ac-done"><input type="checkbox"> 해결</label>' +
          (editable ? '<button class="btn btn-sm btn-ghost btn-icon" data-del title="주석 삭제">✕</button>' : '') +
          '</div></div>');
      card.dataset.id = a.id;
      card.style.setProperty('--c', a.color);
      card.querySelector('.ac-num').textContent = a.number;
      card.querySelector('.ac-label').textContent = (a.kind === 'pin' ? '📍 지점' : '▭ 영역') + ' · 위치 보기';
      var chk = card.querySelector('input[type=checkbox]');
      chk.checked = !!a.done;
      chk.disabled = !editable;
      chk.onchange = function () {
        a.done = chk.checked; card.classList.toggle('done', a.done);
        Ed.markDirty(); Ed.renderOverlay(); Ed.renderList();
      };
      if (editable) {
        var ta = document.createElement('textarea');
        ta.placeholder = '수정 요청 사항을 입력하세요';
        ta.value = a.comment || '';
        ta.oninput = function () { a.comment = ta.value; U.autosize(ta); Ed.markDirty(); };
        ta.onfocus = function () { Ed.select(a.id, false); };
        card.appendChild(ta);
        setTimeout(function () { U.autosize(ta); }, 0);
        card.querySelector('[data-del]').onclick = function (e) { e.stopPropagation(); Ed.deleteAnnotation(a.id); };
      } else {
        var tx = document.createElement('div');
        tx.className = 'ac-text' + (a.comment ? '' : ' empty');
        tx.textContent = a.comment || '(내용 없음)';
        card.appendChild(tx);
      }
      card.querySelector('.ac-label').onclick = function () { Ed.select(a.id, false); Ed.scrollToAnn(a); };
      card.addEventListener('mouseenter', function () { Ed.setHover(a.id); });
      card.addEventListener('mouseleave', function () { Ed.setHover(null); });
      list.appendChild(card);
    });
    if (Ed.selectedId != null) U.setHighlight(list, Ed.selectedId, 'sel');
  };

  // ── 도구 / 색상 ──
  function setTool(t) {
    Ed.tool = t;
    $('toolSeg').querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b.dataset.tool === t); });
    Ed.renderLock();
  }
  $('toolSeg').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setTool(b.dataset.tool); });
  $('colorPicker').addEventListener('click', function (e) {
    var d = e.target.closest('.color-dot'); if (!d) return;
    Ed.color = d.dataset.color;
    this.querySelectorAll('.color-dot').forEach(function (x) { x.classList.toggle('active', x === d); });
  });

  document.addEventListener('keydown', function (e) {
    if (!Ed.active || document.querySelector('.modal-backdrop')) return;
    var inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); Ed.save(); return; }
    if (inField) { if (e.key === 'Escape') document.activeElement.blur(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && Ed.selectedId != null && Ed.editable()) { e.preventDefault(); Ed.deleteAnnotation(Ed.selectedId); }
    else if (e.key === 'b' || e.key === 'B') setTool('box');
    else if (e.key === 'p' || e.key === 'P') setTool('pin');
    else if (e.key === 'ArrowLeft' && Ed.idx > 0) Ed.showPage(Ed.idx - 1);
    else if (e.key === 'ArrowRight' && Ed.idx < Ed.pages.length - 1) Ed.showPage(Ed.idx + 1);
    else if (e.key === 'Escape') Ed.select(null);
  });

  // ══════════════════════════════════════════════════════
  //  파일 추가 (검증 → 업로드 → 페이지 생성)
  //  하나라도 실패하면 그 파일만 제외하고, 이유를 사용자에게 알린다.
  //  업로드 실패는 기존 저장 데이터에 어떤 영향도 주지 않는다.
  // ══════════════════════════════════════════════════════
  function classify(file) {
    var ext = extOf(file.name);
    var type = (file.type || '').toLowerCase();
    if (ext === 'heic' || ext === 'heif' || type === 'image/heic' || type === 'image/heif') {
      throw new Error('HEIC/HEIF(아이폰 사진) 형식은 지원하지 않습니다. JPG 또는 PNG로 변환해서 올려주세요.');
    }
    if (ext === 'psd' || ext === 'ai' || ext === 'pdf' || ext === 'zip') throw new Error('.' + ext + ' 파일은 올릴 수 없습니다. 이미지(JPG/PNG)로 내보낸 뒤 올려주세요.');
    if (IMAGE_EXTS.indexOf(ext) >= 0 || (type.indexOf('image/') === 0 && !ext)) return 'image';
    if (HTML_EXTS.indexOf(ext) >= 0) return 'html';
    if (CODE_EXTS.indexOf(ext) >= 0) return 'code';
    if (type.indexOf('image/') === 0) return 'image';
    throw new Error('지원하지 않는 파일 형식입니다' + (ext ? ' (.' + ext + ')' : '') + '. 이미지, HTML, 소스코드/텍스트 파일만 올릴 수 있습니다.');
  }

  /** 브라우저에서 실제로 열리는 이미지인지 디코딩해서 확인 */
  function probeImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      var timer = setTimeout(function () { cleanup(); reject(new Error('이미지를 여는 데 너무 오래 걸립니다. 파일이 손상되었을 수 있습니다.')); }, 20000);
      function cleanup() { clearTimeout(timer); URL.revokeObjectURL(url); }
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        cleanup();
        if (!w || !h) return reject(new Error('이미지 크기를 읽을 수 없습니다. 손상된 파일일 수 있습니다.'));
        resolve({ width: w, height: h });
      };
      img.onerror = function () { cleanup(); reject(new Error('이미지를 열 수 없습니다. 파일이 손상되었거나, 확장자와 실제 형식이 다르거나, 브라우저가 지원하지 않는 형식입니다.')); };
      img.src = url;
    });
  }

  function readText(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(new Error('파일을 읽을 수 없습니다.')); };
      fr.readAsText(file);
    });
  }

  function uploadBlob(blob, name) {
    return U.api('POST', '/api/files?name=' + encodeURIComponent(name), blob, { timeout: 180000, contentType: blob.type || 'application/octet-stream' });
  }

  function extractHtmlImages(html) {
    var urls = [], seen = {};
    var re = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi, m;
    while ((m = re.exec(html)) !== null) {
      var u = m[1].trim();
      if (!seen[u]) { seen[u] = true; urls.push(u); }
    }
    return urls;
  }

  function unwrapCdnUrl(raw) {
    var proxy = raw.match(/\/proxy\/src\/(https?:\/\/.+?)(?:\/hdims\/|\/format\/|\/optimize|$)/);
    if (proxy) return proxy[1];
    return raw.replace(/\/hdims\/.*$/, '').replace(/\/format\/[^?#]*/, '').replace(/\/optimize[^?#]*/, '');
  }

  function dataUrlToBlob(du) {
    var m = du.match(/^data:([^;,]*)(;base64)?,(.*)$/);
    if (!m) throw new Error('잘못된 data URL');
    var bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: m[1] || 'application/octet-stream' });
  }

  /** 한 개의 이미지 원본(파일/URL/data URL) → 업로드된 페이지 객체 */
  async function makeImagePageFromUrl(url, name) {
    if (/^data:/i.test(url)) {
      var blob = dataUrlToBlob(url);
      var dims = await probeImage(blob);
      var up = await uploadBlob(blob, name + '.' + ((blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')));
      return { type: 'image', name: name, file: up.file, width: dims.width, height: dims.height };
    }
    if (!/^https?:\/\//i.test(url)) throw new Error('상대 경로 이미지(' + url.slice(0, 60) + ')는 가져올 수 없습니다. 전체 주소(https://…)여야 합니다.');
    var r = await U.api('POST', '/api/files/from-url', { url: unwrapCdnUrl(url) }, { timeout: 90000 });
    var probe = await probeImage(await (await fetch(U.fileUrl(r.file))).blob());
    return { type: 'image', name: name || r.name, file: r.file, width: probe.width, height: probe.height };
  }

  function newPage(p) {
    return Object.assign({ id: uid(), annotations: [], nextNum: 1, width: null, height: null }, p);
  }

  /**
   * @param {File[]} files
   * @param {'append'|'replace'} mode
   */
  Ed.addFiles = async function (files, mode) {
    if (!Ed.editable()) return;
    if (!files.length) return;
    if (mode === 'replace' && !Ed.page()) mode = 'append';
    var failures = [], added = [];
    var toast = U.toast('파일 확인 중…', 'info', { duration: 0 });
    Ed.uploading++;
    Ed.updateSaveStatus();
    try {
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        toast.update('업로드 중 (' + (i + 1) + '/' + files.length + ') · ' + f.name, i / files.length);
        try {
          var kind = classify(f);
          if (f.size === 0) throw new Error('빈 파일(0바이트)입니다.');
          if (f.size > MAX_MB * 1048576) throw new Error('파일이 너무 큽니다 (' + U.fmtBytes(f.size) + '). 파일당 최대 ' + MAX_MB + 'MB까지 가능합니다. 이미지를 압축하거나 나눠서 올려주세요.');
          if (kind === 'image') {
            var dims = await probeImage(f);
            var up = await uploadBlob(f, f.name);
            if (up.kind !== 'image') throw new Error('서버에서 이미지로 인식하지 못했습니다.');
            added.push(newPage({ type: 'image', name: f.name, file: up.file, width: dims.width, height: dims.height }));
          } else if (kind === 'html' && mode === 'append') {
            var html = await readText(f);
            var imgs = extractHtmlImages(html);
            var how = 'render';
            if (imgs.length) {
              toast.update('HTML 처리 방법 선택 대기 중…');
              how = await U.modal({
                title: 'HTML 파일 처리 방법', icon: '🌐',
                html: '<p><b>' + U.esc(f.name) + '</b> 에서 이미지 <b>' + imgs.length + '개</b>를 찾았습니다.</p>' +
                  '<ul><li><b>이미지로 가져오기</b>: HTML 안의 이미지를 각각 한 페이지로 추가합니다. (상세페이지 이미지 검토에 적합)</li>' +
                  '<li><b>HTML 화면 그대로</b>: HTML을 웹페이지처럼 그려서 한 페이지로 추가합니다.</li>' +
                  '<li><b>소스코드로 보기</b>: HTML 코드를 텍스트로 보여줍니다.</li></ul>',
                buttons: [{ label: '소스코드로 보기', value: 'code' }, { label: 'HTML 화면 그대로', value: 'render' }, { label: '이미지로 가져오기', value: 'images', kind: 'primary' }],
                dismissValue: 'skip',
              });
            }
            if (how === 'skip') { failures.push({ name: f.name, reason: '사용자가 취소했습니다.' }); continue; }
            if (how === 'images') {
              for (var j = 0; j < imgs.length; j++) {
                toast.update('HTML 이미지 가져오는 중 (' + (j + 1) + '/' + imgs.length + ')', j / imgs.length);
                try { added.push(newPage(await makeImagePageFromUrl(imgs[j], f.name + ' (' + (j + 1) + ')'))); }
                catch (e2) { failures.push({ name: f.name + ' 이미지 ' + (j + 1), reason: e2.message }); }
              }
            } else {
              var upH = await uploadBlob(f, f.name);
              added.push(newPage({ type: how === 'code' ? 'code' : 'html', name: f.name, file: upH.file }));
            }
          } else {
            var upT = await uploadBlob(f, f.name);
            added.push(newPage({ type: kind === 'html' ? 'html' : 'code', name: f.name, file: upT.file }));
          }
        } catch (e) {
          failures.push({ name: f.name, reason: e.message });
        }
      }
    } finally {
      Ed.uploading--;
      toast.close();
    }
    if (!Ed.active) return;
    if (added.length) {
      if (mode === 'replace') {
        var cur = Ed.page();
        var np = added[0];
        cur.type = np.type; cur.name = np.name; cur.file = np.file; cur.width = np.width; cur.height = np.height;
        Ed.markDirty();
        Ed.showPage(Ed.idx);
        U.toast('현재 페이지 파일을 교체했습니다' + (cur.annotations.length ? ' (주석 ' + cur.annotations.length + '개 유지 – 위치를 확인하세요)' : '') + '. 저장해야 반영됩니다.', 'success', { duration: 5000 });
      } else {
        var first = Ed.pages.length;
        Array.prototype.push.apply(Ed.pages, added);
        Ed.markDirty();
        Ed.showPage(first);
        U.toast(added.length + '개 페이지를 추가했습니다. [저장]을 눌러야 서버에 반영됩니다.', 'success', { duration: 4500 });
      }
    } else {
      Ed.updateSaveStatus();
    }
    if (failures.length) {
      await U.modal({
        title: (added.length ? '일부 파일을 추가하지 못했습니다' : '파일을 추가하지 못했습니다'), tone: 'danger',
        html: '<p>아래 ' + failures.length + '개 파일은 문제가 있어 추가하지 않았습니다.</p><ul>' +
          failures.map(function (x) { return '<li><b>' + U.esc(x.name) + '</b><br><span style="color:var(--text-2)">' + U.esc(x.reason) + '</span></li>'; }).join('') +
          '</ul><p class="hint">✅ 기존에 작업·저장된 데이터에는 아무 영향이 없습니다.</p>',
      });
    }
  };

  $('addFilesBtn').onclick = function () { $('fileInput').multiple = true; $('fileInput').dataset.mode = 'append'; $('fileInput').click(); };
  $('replaceBtn').onclick = async function () {
    $('fileInput').multiple = false; $('fileInput').dataset.mode = 'replace'; $('fileInput').click();
  };
  $('dropzone').onclick = function () { if (Ed.editable()) $('addFilesBtn').onclick(); };
  $('fileInput').addEventListener('change', function () {
    var fs = Array.prototype.slice.call(this.files);
    var mode = this.dataset.mode || 'append';
    this.value = '';
    Ed.addFiles(mode === 'replace' ? fs.slice(0, 1) : fs, mode);
  });

  var area = $('canvasArea'), dragDepth = 0;
  area.addEventListener('dragenter', function (e) { if (Ed.editable() && e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) { dragDepth++; area.classList.add('drag-over'); } });
  area.addEventListener('dragleave', function () { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) area.classList.remove('drag-over'); });
  area.addEventListener('dragover', function (e) { if (Ed.editable() && e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) e.preventDefault(); });
  area.addEventListener('drop', function (e) {
    dragDepth = 0; area.classList.remove('drag-over');
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    if (Ed.editable()) Ed.addFiles(Array.prototype.slice.call(e.dataTransfer.files), 'append');
  });
  document.addEventListener('paste', function (e) {
    if (!Ed.active || !Ed.editable() || /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    var items = (e.clipboardData && e.clipboardData.files) ? Array.prototype.slice.call(e.clipboardData.files) : [];
    var imgs = items.filter(function (f) { return f.type.indexOf('image/') === 0; });
    if (!imgs.length) return;
    e.preventDefault();
    var files = imgs.map(function (f, i) { return new File([f], '붙여넣은 이미지 ' + new Date().toLocaleTimeString() + (i ? ' ' + (i + 1) : '') + '.' + (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg'), { type: f.type }); });
    Ed.addFiles(files, 'append');
  });

  // URL 추가
  async function addFromUrl() {
    var raw = $('urlInput').value.trim();
    if (!raw) { $('urlInput').focus(); return; }
    var t = U.toast('URL 이미지 불러오는 중…', 'info', { duration: 0 });
    Ed.uploading++; Ed.updateSaveStatus();
    try {
      var name = decodeURIComponent((unwrapCdnUrl(raw).split('/').pop() || 'url-image').split('?')[0]).slice(0, 80);
      var page = newPage(await makeImagePageFromUrl(raw, name));
      $('urlInput').value = '';
      Ed.uploading--; t.close();
      Ed.pages.push(page);
      Ed.markDirty();
      Ed.showPage(Ed.pages.length - 1);
      U.toast('이미지를 추가했습니다. 저장해야 반영됩니다.', 'success');
    } catch (e) {
      Ed.uploading--; t.close(); Ed.updateSaveStatus();
      U.showError('URL 이미지를 가져오지 못했습니다', e, '<p class="hint">이미지 파일의 직접 주소(…jpg, …png)인지 확인하세요. 기존 데이터에는 영향이 없습니다.</p>');
    }
  }
  $('urlAddBtn').onclick = addFromUrl;
  $('urlInput').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) addFromUrl(); });

  // 텍스트(소스코드) 직접 입력
  $('pasteTextBtn').onclick = async function () {
    var node = U.el(
      '<div>' +
        '<div style="display:flex;gap:8px;margin-bottom:8px"><input class="input" id="ptName" placeholder="이름 (예: main.html, 상품설명.txt)" style="flex:1">' +
        '<select class="input" id="ptType"><option value="code">소스코드/텍스트로 보기</option><option value="html">HTML 화면으로 그리기</option></select></div>' +
        '<textarea class="input" id="ptText" rows="14" style="width:100%;font-family:var(--mono);font-size:12.5px" placeholder="여기에 소스코드나 텍스트를 붙여넣으세요"></textarea>' +
      '</div>');
    var res = await U.modal({
      title: '텍스트 / 소스코드 입력', icon: '⌨', node: node, wide: true,
      buttons: [{ label: '취소', value: null }, { label: '페이지로 추가', kind: 'primary', value: function () {
        return { name: node.querySelector('#ptName').value.trim(), type: node.querySelector('#ptType').value, text: node.querySelector('#ptText').value };
      } }],
      onOpen: function () { node.querySelector('#ptText').focus(); },
    });
    if (!res) return;
    if (!res.text.trim()) { U.alert('내용이 비어 있습니다', '<p>붙여넣은 텍스트가 없어 추가하지 않았습니다.</p>', 'warning'); return; }
    var ext = res.type === 'html' ? 'html' : 'txt';
    var name = res.name || ('텍스트 ' + new Date().toLocaleString());
    if (!extOf(name)) name += '.' + ext;
    if (res.type === 'html' && HTML_EXTS.indexOf(extOf(name)) < 0) name += '.html';
    if (res.type === 'code' && CODE_EXTS.indexOf(extOf(name)) < 0 && HTML_EXTS.indexOf(extOf(name)) < 0) name += '.txt';
    try {
      Ed.uploading++; Ed.updateSaveStatus();
      var up = await uploadBlob(new Blob([res.text], { type: 'text/plain' }), name);
      Ed.uploading--;
      Ed.pages.push(newPage({ type: res.type, name: name, file: up.file }));
      Ed.markDirty();
      Ed.showPage(Ed.pages.length - 1);
    } catch (e) {
      Ed.uploading--; Ed.updateSaveStatus();
      U.showError('텍스트를 추가하지 못했습니다', e);
    }
  };

  $('deletePageBtn').onclick = async function () {
    var p = Ed.page(); if (!p) return;
    var ok = await U.confirm('페이지 삭제', '<p><b>' + (Ed.idx + 1) + '번째 페이지</b>(' + U.esc(p.name || '') + ')' + (p.annotations.length ? '와 주석 <b>' + p.annotations.length + '개</b>' : '') + '를 삭제합니다.</p><p class="hint">저장 전까지는 서버에 반영되지 않으며, 저장 후에도 “버전 기록”에서 되돌릴 수 있습니다.</p>', '삭제', 'danger');
    if (!ok) return;
    Ed.pages.splice(Ed.idx, 1);
    Ed.markDirty();
    Ed.showPage(Math.min(Ed.idx, Ed.pages.length - 1));
  };

  // ── 버전 기록 ──
  $('historyBtn').onclick = async function () {
    var node = U.el('<div><p class="hint">저장할 때마다 직전 상태가 자동으로 보관됩니다 (차수별 최근 50개). 불러온 뒤 [저장]해야 반영됩니다.</p><div id="hBody">불러오는 중…</div></div>');
    var closeFn = null;
    U.api('GET', '/api/products/' + Ed.product.id + '/rounds/' + Ed.round + '/history').then(function (list) {
      var body = node.querySelector('#hBody');
      if (!list.length) { body.innerHTML = '<div class="sb-empty">아직 보관된 이전 버전이 없습니다.</div>'; return; }
      body.innerHTML = '<table class="table"><thead><tr><th>저장 시각</th><th>페이지</th><th>주석</th><th></th></tr></thead><tbody></tbody></table>';
      list.forEach(function (h) {
        var tr = U.el('<tr><td>' + U.fmtDate(h.savedAt) + '<br><span class="hint">' + U.fmtRelative(h.savedAt) + '</span></td><td>' + h.pageCount + '장</td><td>' + h.annotCount + '개</td><td class="actions"><button class="btn btn-sm">이 버전 불러오기</button></td></tr>');
        tr.querySelector('button').onclick = async function () {
          if (!Ed.editable()) { U.alert('불러올 수 없습니다', '<p>완료된 차수입니다. 먼저 완료를 취소하세요.</p>', 'warning'); return; }
          try {
            var v = await U.api('GET', '/api/products/' + Ed.product.id + '/rounds/' + Ed.round + '/history/' + h.id);
            Ed.pages = v.pages;
            Ed.markDirty(true);
            Ed.showPage(Ed.pages.length ? 0 : -1);
            if (closeFn) closeFn(true);
            U.toast(U.fmtDate(h.savedAt) + ' 버전을 불러왔습니다. [저장]을 눌러야 반영됩니다.', 'success', { duration: 5000 });
          } catch (e) { U.showError('버전을 불러오지 못했습니다', e); }
        };
        body.querySelector('tbody').appendChild(tr);
      });
    }).catch(function (e) { node.querySelector('#hBody').textContent = '불러오기 실패: ' + e.message; });
    await U.modal({ title: Ed.round + '차 버전 기록', icon: '🕘', node: node, wide: true, buttons: [{ label: '닫기', value: true }], onOpen: function (m, close) { closeFn = close; } });
  };

  // ══════════════════════════════════════════════════════
  //  백업 관리
  // ══════════════════════════════════════════════════════
  async function openBackupModal() {
    var node = U.el('<div><div id="bkStatus">불러오는 중…</div><div class="section-title">백업 목록</div><div id="bkList"></div>' +
      '<div class="section-title">기존 시스템 데이터 가져오기</div>' +
      '<p class="hint">기존 주석검토 서버(webpage-magician)의 제품·차수·이미지·주석을 그대로 옮겨옵니다. 가져오기 전 자동으로 백업이 만들어지며, 이미 가져온 제품은 건너뜁니다.</p>' +
      '<div class="share-box"><input class="input" id="lgUrl" placeholder="https://webpage-magician-production.up.railway.app"><button class="btn" id="lgUrlBtn">서버에서 가져오기</button></div>' +
      '<div style="margin-top:8px" class="hint">또는 기존 <b>products.json</b> 파일: <input type="file" id="lgFile" accept=".json,application/json"></div>' +
      '<div id="lgProgress" class="hint" style="margin-top:8px"></div></div>');
    var render = function () {
      return U.api('GET', '/api/backups').then(function (r) {
        var s = r.status;
        var warnHtml = serverStatus && serverStatus.storageWarning ? '<div class="banner warning" style="margin:0 0 12px;border-radius:8px">⚠️ <div>' + U.esc(serverStatus.storageWarning) + '</div></div>' : '';
        node.querySelector('#bkStatus').innerHTML = warnHtml +
          '<dl class="kv">' +
          '<dt>자동 백업</dt><dd>매일 ' + s.time + ' (' + U.esc(s.timezone || '') + ') · 최근 ' + s.keep + '개 보관</dd>' +
          '<dt>다음 자동 백업</dt><dd>' + U.fmtDate(s.nextRun, true, s.timezone) + '</dd>' +
          '<dt>마지막 백업</dt><dd>' + (s.last ? U.fmtDate(s.last.createdAt, true, s.timezone) + ' (' + U.fmtRelative(s.last.createdAt) + ')' : '없음') + '</dd>' +
          (s.lastError ? '<dt>최근 오류</dt><dd style="color:var(--danger)">' + U.esc(s.lastError.message) + '</dd>' : '') +
          '</dl><button class="btn btn-primary btn-sm" id="bkNow">지금 백업하기</button>';
        node.querySelector('#bkNow').onclick = async function () {
          this.disabled = true;
          try { var m = await U.api('POST', '/api/backups', undefined, { timeout: 300000 }); U.toast('백업 완료: ' + m.name, 'success'); render(); loadStatus(); }
          catch (e) { U.showError('백업하지 못했습니다', e); this.disabled = false; }
        };
        var kindLabel = { auto: '자동', manual: '수동', 'pre-restore': '복원 직전', 'pre-import': '가져오기 직전' };
        var lb = node.querySelector('#bkList');
        if (!r.list.length) { lb.innerHTML = '<div class="sb-empty">아직 백업이 없습니다.</div>'; return; }
        lb.innerHTML = '<table class="table"><thead><tr><th>시각</th><th>종류</th><th>내용</th><th></th></tr></thead><tbody></tbody></table>';
        r.list.forEach(function (b) {
          var tr = U.el('<tr><td>' + U.fmtDate(b.createdAt, true, r.status.timezone) + '</td><td><span class="pill ' + (b.kind === 'auto' ? 'primary' : '') + '">' + (kindLabel[b.kind] || b.kind) + '</span></td>' +
            '<td class="hint">제품 ' + b.productCount + ' · 페이지 ' + b.pageCount + ' · 주석 ' + b.annotCount + '<br>' + U.fmtBytes(b.bytes) + '</td>' +
            '<td class="actions"><a class="btn btn-sm" href="/api/backups/' + encodeURIComponent(b.name) + '/download">다운로드</a><button class="btn btn-sm" data-a="restore">복원</button>' +
            (b.kind !== 'auto' ? '<button class="btn btn-sm btn-ghost btn-icon" data-a="del" title="삭제">🗑</button>' : '') + '</td></tr>');
          tr.querySelector('[data-a="restore"]').onclick = async function () {
            var ok = await U.confirm('이 백업으로 복원할까요?', '<p><b>' + U.fmtDate(b.createdAt) + '</b> 시점(제품 ' + b.productCount + '개)으로 전체 데이터를 되돌립니다.</p><p>복원 직전 현재 상태는 자동으로 “복원 직전” 백업으로 보관되므로 다시 되돌릴 수 있습니다.</p>', '복원', 'danger');
            if (!ok) return;
            try { await U.api('POST', '/api/backups/' + encodeURIComponent(b.name) + '/restore', undefined, { timeout: 300000 }); U.toast('복원했습니다.', 'success'); render(); loadStatus(); loadProducts(); }
            catch (e) { U.showError('복원하지 못했습니다', e); }
          };
          var del = tr.querySelector('[data-a="del"]');
          if (del) del.onclick = async function () {
            if (!await U.confirm('백업 삭제', '<p>이 백업을 삭제할까요?</p>', '삭제', 'danger')) return;
            U.api('DELETE', '/api/backups/' + encodeURIComponent(b.name)).then(render, function (e) { U.showError('삭제 실패', e); });
          };
          lb.querySelector('tbody').appendChild(tr);
        });
      }).catch(function (e) { node.querySelector('#bkStatus').textContent = '불러오기 실패: ' + e.message; });
    };
    var pollJob = function (jobId) {
      var prog = node.querySelector('#lgProgress');
      var tick = function () {
        U.api('GET', '/api/import/jobs/' + jobId).then(function (j) {
          if (j.status === 'running') {
            prog.textContent = '가져오는 중… ' + (j.progress ? (j.progress.done + '/' + j.progress.total + (j.progress.current ? ' · ' + j.progress.current : '')) : '');
            setTimeout(tick, 1500);
          } else if (j.status === 'done') {
            prog.textContent = '';
            U.alert('가져오기 완료', '<p>새로 가져온 제품 <b>' + j.result.imported + '개</b>, 이미 있어서 건너뛴 제품 ' + j.result.skipped + '개</p>' +
              (j.result.warnings.length ? '<p>경고 ' + j.result.warnings.length + '건:</p><ul>' + j.result.warnings.slice(0, 30).map(function (w) { return '<li>' + U.esc(w) + '</li>'; }).join('') + '</ul>' : ''), 'success');
            loadProducts(); render();
          } else {
            prog.textContent = '';
            U.alert('가져오기 실패', '<p>' + U.esc(j.error) + '</p><p class="hint">기존 데이터에는 영향이 없습니다.</p>', 'danger');
          }
        }).catch(function (e) { prog.textContent = '상태 확인 실패: ' + e.message; setTimeout(tick, 4000); });
      };
      tick();
    };
    node.querySelector('#lgUrlBtn').onclick = function () {
      var url = node.querySelector('#lgUrl').value.trim();
      if (!url) { node.querySelector('#lgUrl').focus(); return; }
      U.api('POST', '/api/import/legacy-url', { url: url }).then(function (r) { pollJob(r.jobId); }, function (e) { U.showError('가져오기를 시작하지 못했습니다', e); });
    };
    node.querySelector('#lgFile').onchange = function () {
      var f = this.files[0]; this.value = '';
      if (!f) return;
      node.querySelector('#lgProgress').textContent = '파일 업로드 중…';
      U.api('POST', '/api/import/legacy-file', f, { timeout: 600000, contentType: 'application/json' })
        .then(function (r) { pollJob(r.jobId); }, function (e) { node.querySelector('#lgProgress').textContent = ''; U.showError('가져오기를 시작하지 못했습니다', e); });
    };
    render();
    await U.modal({ title: '백업 관리', icon: '🛟', node: node, wide: true, buttons: [{ label: '닫기', value: true }] });
  }

  // ══════════════════════════════════════════════════════
  //  시작
  // ══════════════════════════════════════════════════════
  loadStatus().then(route);
  setInterval(loadStatus, 5 * 60 * 1000);
})();
