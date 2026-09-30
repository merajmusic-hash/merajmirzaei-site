// Gallery photo viewer: clicking a photo on /gallery (or the big photo on a
// photo's own page) opens it large over a dark background.
//   - click / tap the photo: zoom in 2x at that spot; again to zoom out
//   - while zoomed: drag (mouse) or swipe (finger) to move around
//   - phones: pinch-zoom also works (the page itself allows it)
//   - ‹ › buttons, arrow keys or a sideways swipe: previous / next
//   - ×, Esc, the browser's Back button or a click on the dark area: close
// While open, the address bar shows the photo's own page (/gallery/<name>),
// so the link can be shared and reopens that photo. Without JavaScript the
// photos are plain links to those pages, which work on their own.
// The photo list comes from <script id="galleryData">, written by the Worker.
(function () {
  var dataEl = document.getElementById('galleryData');
  if (!dataEl) return;
  var data;
  try { data = JSON.parse(dataEl.textContent); } catch (e) { return; }
  var items = (data && data.items) || [];
  if (!items.length) return;
  var rtl = data.lang === 'fa';
  var T = rtl
    ? { close: 'بستن', prev: 'عکس قبلی', next: 'عکس بعدی', dialog: 'نمای بزرگ عکس' }
    : { close: 'Close', prev: 'Previous photo', next: 'Next photo', dialog: 'Photo viewer' };
  var ZOOM = 2;
  var pageUrl = location.pathname;

  var css = ''
    + '.gal a.gal-open,.gp-fig a.gal-open{display:block;cursor:zoom-in}'
    + '.lb{position:fixed;inset:0;z-index:1000;background:var(--ink,#0B0D10);display:flex;flex-direction:column;color:var(--text,#E7E4DE)}'
    + '.lb[hidden]{display:none}'
    + '.lb-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;flex:none;direction:ltr}'
    + '.lb-count{font-family:var(--mono,monospace);font-size:12px;letter-spacing:.12em;color:var(--muted,#8B95A1)}'
    + '.lb button{font:inherit;cursor:pointer;background:rgba(20,24,29,.85);color:var(--text,#E7E4DE);border:1px solid var(--line,#262D36);'
    + 'border-radius:50%;width:44px;height:44px;display:flex;align-items:center;justify-content:center;font-size:24px;line-height:1;padding:0}'
    + '.lb button:hover,.lb button:focus-visible{border-color:var(--brass,#C2A878);color:var(--brass,#C2A878);outline:none}'
    + '.lb-main{position:relative;flex:1;min-height:0;display:flex}'
    + '.lb-stage{flex:1;min-width:0;display:flex;overflow:hidden;direction:ltr;cursor:zoom-in;user-select:none;-webkit-user-select:none}'
    + '.lb-img{flex:none;margin:auto;max-width:100%;max-height:100%;object-fit:contain;display:block;-webkit-user-drag:none}'
    + '.lb.zoomed .lb-stage{overflow:auto;cursor:grab}'
    + '.lb.zoomed .lb-stage.dragging{cursor:grabbing}'
    + '.lb.zoomed .lb-img{max-width:none;max-height:none}'
    + '.lb-prev,.lb-next{position:absolute;top:50%;transform:translateY(-50%);z-index:2}'
    + '.lb-prev{inset-inline-start:12px}.lb-next{inset-inline-end:12px}'
    + '.lb.zoomed .lb-prev,.lb.zoomed .lb-next,.lb.single .lb-prev,.lb.single .lb-next{display:none}'
    + '.lb-cap{flex:none;padding:10px 16px 16px;text-align:center;font-size:13px;color:var(--muted,#8B95A1);min-height:20px}'
    + '.lb-cap .people{display:block;margin-top:3px}'
    + '.lb-cap .people a{color:var(--brass,#C2A878);text-decoration:none}'
    + '.lb-cap .people a:hover{text-decoration:underline}'
    + '.lb.zoomed .lb-cap{display:none}'
    + '@media(max-width:600px){.lb-prev,.lb-next{width:38px;height:38px;font-size:20px}.lb-prev{inset-inline-start:6px}.lb-next{inset-inline-end:6px}}';
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var lb = document.createElement('div');
  lb.className = 'lb';
  lb.hidden = true;
  lb.setAttribute('role', 'dialog');
  lb.setAttribute('aria-modal', 'true');
  lb.setAttribute('aria-label', T.dialog);
  lb.innerHTML = '<div class="lb-top"><span class="lb-count"></span>'
    + '<button type="button" class="lb-close" aria-label="' + T.close + '">×</button></div>'
    + '<div class="lb-main">'
    + '<button type="button" class="lb-prev" aria-label="' + T.prev + '">' + (rtl ? '›' : '‹') + '</button>'
    + '<div class="lb-stage"><img class="lb-img" alt="" draggable="false"></div>'
    + '<button type="button" class="lb-next" aria-label="' + T.next + '">' + (rtl ? '‹' : '›') + '</button>'
    + '</div><div class="lb-cap"></div>';
  document.body.appendChild(lb);

  var stage = lb.querySelector('.lb-stage');
  var img = lb.querySelector('.lb-img');
  var capEl = lb.querySelector('.lb-cap');
  var countEl = lb.querySelector('.lb-count');
  var closeBtn = lb.querySelector('.lb-close');
  var cur = -1, zoomed = false, pushed = false, lastFocus = null, savedOverflow = '';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(n) { return rtl ? String(n).replace(/[0-9]/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'[d]; }) : String(n); }

  function unzoom() {
    zoomed = false;
    lb.classList.remove('zoomed');
    img.style.width = '';
    stage.scrollLeft = 0; stage.scrollTop = 0;
  }

  function zoomAt(clientX, clientY) {
    var r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var fx = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    var fy = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    var w = r.width * ZOOM, h = r.height * ZOOM;
    zoomed = true;
    lb.classList.add('zoomed');
    img.style.width = w + 'px';
    // Put the spot that was clicked in the middle of the screen.
    stage.scrollLeft = Math.max(0, fx * w - stage.clientWidth / 2);
    stage.scrollTop = Math.max(0, fy * h - stage.clientHeight / 2);
  }

  function show(i) {
    cur = (i + items.length) % items.length;
    var it = items[cur];
    unzoom();
    img.src = it.src;
    img.alt = it.alt || '';
    countEl.textContent = num(cur + 1) + ' / ' + num(items.length);
    var people = (it.people || []).map(function (p) {
      return p.href ? '<a href="' + esc(p.href) + '">' + esc(p.label) + '</a>' : '<span>' + esc(p.label) + '</span>';
    }).join(' · ');
    capEl.innerHTML = esc(it.caption) + (people ? '<span class="people">' + people + '</span>' : '');
    [cur - 1, cur + 1].forEach(function (k) {
      var n = items[(k + items.length) % items.length];
      if (n) { var pre = new Image(); pre.src = n.src; }
    });
  }

  function open(i) {
    lastFocus = document.activeElement;
    lb.classList.toggle('single', items.length < 2);
    show(i);
    lb.hidden = false;
    savedOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    var href = items[cur].href;
    if (location.pathname !== href) {
      try { history.pushState({ lb: 1 }, '', href); pushed = true; } catch (e) {}
    }
    closeBtn.focus();
  }

  function go(step) {
    if (lb.hidden) return;
    show(cur + step);
    try { history.replaceState(pushed ? { lb: 1 } : history.state, '', items[cur].href); } catch (e) {}
  }

  function hide() {
    if (lb.hidden) return;
    unzoom();
    lb.hidden = true;
    document.documentElement.style.overflow = savedOverflow;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus({ preventScroll: true }); } catch (e) {} }
  }

  function close() {
    if (pushed) { pushed = false; history.back(); return; } // popstate hides it
    hide();
    if (location.pathname !== pageUrl) { try { history.replaceState(history.state, '', pageUrl); } catch (e) {} }
  }

  window.addEventListener('popstate', function () {
    pushed = false;
    hide();
  });

  // Photos on the page open the viewer (plain clicks only — a middle-click
  // or Ctrl/Cmd-click still opens the photo's page in a new tab).
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a.gal-open');
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var i = Number(a.getAttribute('data-i'));
    if (!(i >= 0 && i < items.length)) return;
    e.preventDefault();
    open(i);
  });

  closeBtn.addEventListener('click', close);
  lb.querySelector('.lb-prev').addEventListener('click', function () { go(-1); });
  lb.querySelector('.lb-next').addEventListener('click', function () { go(1); });

  // A click on the dark area around the photo closes; on the photo zooms.
  var drag = null, moved = false;
  stage.addEventListener('click', function (e) {
    if (moved) { moved = false; return; }
    if (zoomed) { unzoom(); return; }
    if (e.target === img) zoomAt(e.clientX, e.clientY);
    else close();
  });
  lb.querySelector('.lb-cap').addEventListener('click', function (e) {
    if (e.target === capEl) close();
  });

  // Mouse drag to move around a zoomed photo (fingers scroll natively).
  stage.addEventListener('mousedown', function (e) {
    if (!zoomed || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, l: stage.scrollLeft, t: stage.scrollTop };
    moved = false;
    stage.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    stage.scrollLeft = drag.l - dx;
    stage.scrollTop = drag.t - dy;
  });
  window.addEventListener('mouseup', function () {
    if (!drag) return;
    drag = null;
    stage.classList.remove('dragging');
  });

  // Sideways swipe (when not zoomed and not pinch-zoomed): previous / next.
  var touch = null;
  stage.addEventListener('touchstart', function (e) {
    touch = (!zoomed && e.touches.length === 1) ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  stage.addEventListener('touchend', function (e) {
    if (!touch || zoomed || (window.visualViewport && window.visualViewport.scale > 1.05)) { touch = null; return; }
    var t = e.changedTouches[0];
    var dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      moved = true; // don't treat it as a tap
      setTimeout(function () { moved = false; }, 400);
      // A swipe to the left brings the next photo in (the opposite on the Farsi page).
      go((dx < 0) !== rtl ? 1 : -1);
    }
  }, { passive: true });

  document.addEventListener('keydown', function (e) {
    if (lb.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); if (zoomed) unzoom(); else close(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(rtl ? -1 : 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(rtl ? 1 : -1); }
  });
})();
