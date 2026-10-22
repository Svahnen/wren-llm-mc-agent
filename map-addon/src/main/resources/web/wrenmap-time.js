// wrenmap: (1) make the BlueMap viewer follow the in-game time (assets/wrenmap/time.json), (2) top-center Wren status panel
// (assets/wrenmap/wren-status.json, polled every 2 s). Both feeds are written by the wrenmap server mod.
(function () {
  var POLL_MS = 5000, FADE_MS = 3000, MIN = 0.25;   // MIN = BlueMap's own "night" sunlight value
  var follow = true, anim = null, started = false;
  try { follow = localStorage.getItem('wrenmap.followTime') !== '0'; } catch (e) {}

  function uni() {
    var b = window.bluemap;
    return b && b.mapViewer && b.mapViewer.data && b.mapViewer.data.uniforms && b.mapViewer.data.uniforms.sunlightStrength;
  }
  function fadeTo(target) {
    var u = uni(); if (!u) return;
    var from = u.value; if (Math.abs(from - target) < 0.01) return;
    var t0 = performance.now();
    if (anim) cancelAnimationFrame(anim);
    (function step(now) {
      var k = Math.min(1, (now - t0) / FADE_MS), uu = uni(); if (!uu) return;
      uu.value = from + (target - from) * (k * k * (3 - 2 * k));
      try { window.bluemap.mapViewer.redraw(); } catch (e) {}
      if (k < 1 && follow) anim = requestAnimationFrame(step); else anim = null;
    })(t0);
  }
  function poll() {
    if (!follow) return;
    fetch(new URL('assets/wrenmap/time.json?' + Date.now(), document.baseURI), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && typeof j.sunlight === 'number') fadeTo(MIN + (1 - MIN) * j.sunlight); })
      .catch(function () {});
  }
  var btn;
  function label() {
    btn.textContent = follow ? '☀ Follow game time: ON' : '☀ Follow game time: OFF';
    btn.style.opacity = follow ? '1' : '.6';
  }
  function ui() {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:100000;padding:4px 10px;border:0;border-radius:12px;' +
      'background:rgba(30,30,40,.8);color:#fff;font:12px sans-serif;cursor:pointer';
    btn.onclick = function () {
      follow = !follow;
      try { localStorage.setItem('wrenmap.followTime', follow ? '1' : '0'); } catch (e) {}
      label(); if (follow) poll(); else if (anim) { cancelAnimationFrame(anim); anim = null; }
    };
    label(); document.body.appendChild(btn);
  }

  // ---- Wren status panel (top center) ----
  var panel, body, tog, expanded = false, collapsed = false, last = null;
  try { collapsed = localStorage.getItem('wrenmap.panelCollapsed') === '1'; } catch (e) {}
  function el(tag, css, parent) { var e = document.createElement(tag); e.style.cssText = css || ''; if (parent) parent.appendChild(e); return e; }
  function panelUi() {
    panel = el('div', 'position:fixed;top:6px;left:50%;transform:translateX(-50%);z-index:100000;max-width:min(560px,calc(100vw - 150px));' +
      'box-sizing:border-box;display:flex;align-items:flex-start;gap:6px;padding:3px 6px;border-radius:10px;' +
      'background:rgba(20,20,30,.62);color:#fff;font:12px/1.35 sans-serif;pointer-events:auto');
    body = el('div', 'min-width:0;flex:1;cursor:pointer;overflow:hidden;', panel);
    body.onclick = function () { expanded = !expanded; render(); };
    tog = el('button', 'flex:none;border:0;background:transparent;color:#fff;font:12px sans-serif;cursor:pointer;padding:0 2px;opacity:.8', panel);
    tog.type = 'button'; tog.title = 'Show/hide the Wren status';
    tog.onclick = function () {
      collapsed = !collapsed;
      try { localStorage.setItem('wrenmap.panelCollapsed', collapsed ? '1' : '0'); } catch (e) {}
      render();
    };
    document.body.appendChild(panel); render();
  }
  function line(parent, css) { return el('div', 'white-space:' + (expanded ? 'normal' : 'nowrap') + ';overflow:hidden;text-overflow:ellipsis;' + (css || ''), parent); }
  function render() {
    if (!panel) return;
    tog.textContent = collapsed ? '▸ Wren' : '▾';
    body.style.display = collapsed ? 'none' : 'block';
    while (body.firstChild) body.removeChild(body.firstChild);
    if (collapsed) return;
    var j = last;
    if (!j) { line(body).textContent = 'Wren: no status yet'; return; }
    var name = j.name || 'Wren', l1 = line(body), l2 = line(body, 'opacity:.9');
    var goal = j.goal || '(no goal)', thought = j.thought || '';
    l1.textContent = name + (j.online ? '' : ' (offline)') + ' • Goal: ' + goal;
    var v = j.vitals, vt = '';
    if (v) {
      var vs = document.createElement('span');
      vs.style.cssText = 'margin-right:8px;white-space:nowrap';
      vs.appendChild(bar('\u2764', v.hp, v.maxHp || 20, '#e53935'));
      vs.appendChild(bar('\uD83C\uDF57', v.food, 20, '#fb8c00'));
      l1.insertBefore(vs, l1.firstChild);
      vt = '\nHealth ' + v.hp + '/' + (v.maxHp || 20) + ', food ' + v.food + '/20, saturation ' + v.sat + (v.held ? ', holding ' + v.held + (v.heldCount > 1 ? ' x' + v.heldCount : '') : ', hands empty');
    }
    var bits = [];
    if (j.pos) bits.push('@ ' + j.pos.x + ' ' + j.pos.y + ' ' + j.pos.z);
    if (j.nearest) bits.push(j.nearest.dist + ' m to ' + j.nearest.name);
    if (j.clock) bits.push('day ' + j.day + ' ' + j.clock);
    if (v && v.held) bits.push('holding ' + v.held + (v.heldCount > 1 ? ' x' + v.heldCount : ''));
    if (v && v.sat > 0) bits.push('sat ' + v.sat);
    l2.textContent = bits.join(' • ') + (thought ? ' • “' + thought + '”' : '');
    body.title = 'Goal: ' + goal + (thought ? '\nThought: ' + thought : '') + '\n' + bits.join(' | ') + vt;
    if (!expanded) body.title += '\n(tap to expand)';
  }
  // small icon + 10-segment bar (value/max), e.g. a heart with 7/20 filled
  function bar(icon, val, max, color) {
    var w = document.createElement('span');
    w.style.cssText = 'display:inline-flex;align-items:center;gap:3px;margin-right:6px;vertical-align:middle';
    var i = document.createElement('span'); i.textContent = icon; w.appendChild(i);
    var t = document.createElement('span');
    t.style.cssText = 'display:inline-block;width:46px;height:7px;border-radius:3px;background:rgba(255,255,255,.25);overflow:hidden';
    var f = document.createElement('span');
    f.style.cssText = 'display:block;height:100%;background:' + color + ';width:' + Math.max(0, Math.min(100, val / max * 100)) + '%';
    t.appendChild(f); w.appendChild(t);
    var n = document.createElement('span'); n.textContent = Math.round(val) + '/' + max; n.style.cssText = 'font-size:11px'; w.appendChild(n);
    return w;
  }
  function pollStatus() {
    fetch(new URL('assets/wrenmap/wren-status.json?' + Date.now(), document.baseURI), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j) { last = j; render(); } })
      .catch(function () {});
  }
  function start() {
    if (started) return; started = true;
    ui(); poll(); setInterval(poll, POLL_MS);
    panelUi(); pollStatus(); setInterval(pollStatus, 2000);
  }
  var tries = 0, wait = setInterval(function () {
    if (uni()) { clearInterval(wait); start(); } else if (++tries > 120) clearInterval(wait);
  }, 500);
})();
