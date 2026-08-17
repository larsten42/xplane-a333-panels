/* ============================================================================
   rmp.js — Airbus RMP (Radio Management Panel) + ACP (Audio Control Panel)

   Requires fcu-instruments.js first (panel-chassis, seven-seg, fcu-knob,
   fcu-lever, fcu-led-button).

     <script src="fcu-instruments.js"></script>
     <script src="rmp.js"></script>
     <rmp-panel></rmp-panel>
     <acp-panel></acp-panel>

   No dependencies, no build step, no network.
   ========================================================================== */
(function () {
  'use strict';

  var AMBER = '#ffb15a';
  var GLOW = '0 0 7px rgba(255,150,40,.55), 0 0 14px rgba(255,130,20,.28), 0 1px 1px rgba(0,0,0,.8)';
  var SILK = 'rgba(232,220,184,.92)';

  function num(el, a, d) { var v = parseFloat(el.getAttribute(a)); return isNaN(v) ? d : v; }
  function flag(el, a, d) { var v = el.getAttribute(a); return v === null ? d : v !== 'false'; }
  function capture(el, id) { try { el.setPointerCapture(id); } catch (e) { /* stray id */ } }

  function cap(x, y, text, o) {
    o = o || {};
    return '<div data-cap="1" style="position:absolute;left:' + x + 'px;top:' + y + 'px;' +
      'transform:' + (o.transform || 'translate(-50%,-50%)') + ';font-size:' + (o.size || 13) + 'px;' +
      'font-weight:700;letter-spacing:' + (o.ls || '.8') + 'px;white-space:nowrap;user-select:none;' +
      'color:' + (o.color || SILK) + ';text-shadow:' + (o.glow ? GLOW : '0 1px 1px rgba(0,0,0,.85)') + '">' + text + '</div>';
  }

  /* Channel caret above a pushbutton. White silkscreen unlit, amber under
     panel backlight, green when that channel is the selected one. */
  var CARET = {
    off: { c: SILK, glow: 'none' },
    lit: { c: AMBER, glow: 'drop-shadow(0 0 5px rgba(255,150,40,.6))' },
    sel: { c: '#4dff8f', glow: 'drop-shadow(0 0 6px rgba(62,240,122,.8))' }
  };

  function caret(id, x, y, state) {
    var s = CARET[state || 'off'];
    return '<div data-caret="' + id + '" style="position:absolute;left:' + x + 'px;top:' + y + 'px;' +
      'transform:translate(-50%,-50%);width:0;height:0;' +
      'border-left:7px solid transparent;border-right:7px solid transparent;' +
      'border-top:9px solid ' + s.c + ';filter:' + s.glow + ';pointer-events:none"></div>';
  }

  /* ======================================================= ACP volume knob */

  class AcpKnob extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      var id = this.getAttribute('knob-id') || '';
      this.dataset.acpKnob = id;
      var size = num(this, 'size', 62);
      this.value = num(this, 'value', 40);
      this.min = -135; this.max = 135;

      this.style.cssText = 'position:absolute;display:block;width:' + size + 'px;height:' + size + 'px;' +
        'border-radius:50%;cursor:pointer;touch-action:none;user-select:none;' +
        '-webkit-tap-highlight-color:transparent;' + (this.getAttribute('style') || '');

      this.innerHTML =
        '<div data-body style="position:absolute;inset:0;border-radius:50%;' +
          'background:radial-gradient(circle at 38% 28%,#5c6266 0%,#3b4145 46%,#1d2225 100%);' +
          'box-shadow:0 5px 12px rgba(0,0,0,.65), inset 0 2px 3px rgba(210,220,225,.22), inset 0 -3px 6px rgba(0,0,0,.6);' +
          'pointer-events:none"></div>' +
        '<div data-cap style="position:absolute;inset:' + Math.round(size * 0.14) + 'px;border-radius:50%;' +
          'background:radial-gradient(circle at 36% 26%,#8e969b 0%,#6b7378 50%,#424a4f 100%);' +
          'box-shadow:inset 0 1px 2px rgba(255,255,255,.25);pointer-events:none;' +
          'transition:transform .06s linear">' +
          '<i style="position:absolute;left:50%;top:' + Math.round(size * 0.08) + 'px;width:3px;' +
            'height:' + Math.round(size * 0.30) + 'px;margin-left:-1.5px;border-radius:2px;' +
            'background:#f2f6f7;box-shadow:0 0 4px rgba(255,255,255,.5)"></i>' +
        '</div>' +
        '<div data-lamp style="position:absolute;inset:' + Math.round(size * 0.14) + 'px;border-radius:50%;' +
          'pointer-events:none;opacity:0;transition:opacity .12s linear;' +
          'background:radial-gradient(circle,rgba(255,255,255,.85) 0%,rgba(235,245,255,.35) 60%,rgba(255,255,255,0) 100%);' +
          'box-shadow:0 0 18px rgba(230,240,255,.85)"></div>';

      this._cap = this.querySelector('[data-cap]');
      this._lamp = this.querySelector('[data-lamp]');

      var self = this;
      var api = {
        get: function () { return self.value; },
        set: function (v) { self._set(v, false); },
        onChange: function (fn) { self._cb = fn; },
        setLamp: function (on) { self._lamp.style.opacity = on ? '1' : '0'; },
        isLit: function () { return self._lamp.style.opacity === '1'; },
        toggleLamp: function () { api.setLamp(!api.isLit()); return api.isLit(); },
        onTap: function (fn) { self._tapCb = fn; },
        root: this
      };
      this.knob = api;
      this.api = api;

      /* touch-first: press and drag up/down, same feel as the other knobs */
      var DRAG = num(this, 'drag-step', 3), dragY = 0, dragging = false, moved = 0;
      this.addEventListener('pointerdown', function (e) {
        capture(self, e.pointerId);
        dragging = true; dragY = e.clientY; moved = 0;
      });
      this.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        var dy = dragY - e.clientY;
        if (Math.abs(dy) < DRAG) return;
        moved += Math.abs(dy);
        dragY = e.clientY;
        self._set(self.value + dy, true);
      });
      var end = function (e) {
        if (!dragging) return;
        dragging = false;
        if (self.hasPointerCapture(e.pointerId)) self.releasePointerCapture(e.pointerId);
        if (moved < DRAG) { if (self._tapCb) self._tapCb(); else api.toggleLamp(); }
      };
      this.addEventListener('pointerup', end);
      this.addEventListener('pointercancel', end);
      this.addEventListener('wheel', function (e) {
        e.preventDefault();
        self._set(self.value + (e.deltaY > 0 ? -4 : 4), true);
      }, { passive: false });

      this._set(this.value, false);
      if (flag(this, 'lit', false)) api.setLamp(true);
      this.dispatchEvent(new CustomEvent('acp-knob-ready', { detail: api, bubbles: true }));
    }

    _set(v, fire) {
      this.value = Math.max(0, Math.min(100, v));
      this._cap.style.transform = 'rotate(' + (this.min + (this.max - this.min) * this.value / 100) + 'deg)';
      if (fire && this._cb) this._cb(this.value);
    }
  }

  /* ================================================= ACP transmit key */

  class AcpKey extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      this.dataset.acpKey = this.getAttribute('key-id') || '';
      var w = num(this, 'width', 112), h = num(this, 'height', 56);
      var up = '0 4px 9px rgba(0,0,0,.6), inset 0 1px 1px rgba(190,215,225,.22), inset 0 -2px 4px rgba(0,0,0,.7)';
      var down = '0 1px 3px rgba(0,0,0,.6), inset 0 3px 7px rgba(0,0,0,.85)';

      this.style.cssText = 'position:absolute;box-sizing:border-box;display:flex;align-items:center;' +
        'justify-content:center;width:' + w + 'px;height:' + h + 'px;border-radius:4px;' +
        'background:linear-gradient(180deg,#2b3338 0%,#12181b 55%,#080c0e 100%);box-shadow:' + up + ';' +
        'cursor:pointer;user-select:none;touch-action:manipulation;-webkit-tap-highlight-color:transparent;' +
        (this.getAttribute('style') || '');

      this.innerHTML =
        '<span data-legend style="pointer-events:none;display:flex;flex-direction:column;gap:3px;' +
          'width:' + Math.round(w * 0.62) + 'px;font-size:9px;font-weight:700;letter-spacing:1px;' +
          'color:rgba(232,220,184,.30);text-align:center;line-height:1">' +
          '<i style="display:block;height:5px;border-radius:1px;background:rgba(232,220,184,.16)"></i>' +
          '<span data-legend-text></span>' +
        '</span>';
      this.querySelector('[data-legend-text]').textContent = this.getAttribute('legend') || '';

      var self = this;
      var api = {
        setLit: function (on) { self._paint(!!on); },
        isLit: function () { return !!self.lit; },
        toggle: function () { self._paint(!self.lit); return self.lit; },
        onPress: function (fn) { self._cb = fn; },
        root: this
      };
      this.key = api;
      this.api = api;

      this.addEventListener('pointerdown', function () { self.style.boxShadow = down; });
      this.addEventListener('pointerup', function () {
        self.style.boxShadow = up;
        if (self._cb) self._cb(api); else api.toggle();
      });
      this.addEventListener('pointerleave', function () { self.style.boxShadow = up; });
      this._paint(flag(this, 'lit', false));
      this.dispatchEvent(new CustomEvent('acp-key-ready', { detail: api, bubbles: true }));
    }

    _paint(on) {
      this.lit = on;
      var l = this.querySelector('[data-legend]');
      l.style.color = on ? AMBER : 'rgba(232,220,184,.30)';
      l.style.textShadow = on ? GLOW : 'none';
      l.querySelector('i').style.background = on ? AMBER : 'rgba(232,220,184,.16)';
      l.querySelector('i').style.boxShadow = on ? '0 0 8px rgba(255,150,40,.7)' : 'none';
    }
  }

  /* ============================================================ RMP panel */

  var RMP_W = 872, RMP_H = 452;
  var BW = 104, BH = 46;

  function rmpBtn(id, label, x, y, w) {
    return '<fcu-led-button btn-id="' + id + '" label="' + label + '" led="none" ' +
      'width="' + (w || BW) + '" height="' + BH + '" ' +
      'style="position:absolute;left:' + x + 'px;top:' + y + 'px"></fcu-led-button>';
  }

  var RMP_ROW1 = [['vhf1', 'VHF1'], ['vhf2', 'VHF2'], ['vhf3', 'VHF3']];
  var RMP_ROW2 = [['hf1', 'HF1'], ['sel', ''], ['hf2', 'HF2'], ['am', 'AM']];
  var RMP_NAV = [['nav', 'NAV'], ['vor', 'VOR'], ['ls', 'LS'], ['blank', ''], ['adf', 'ADF'], ['bfo', 'BFO']];

  class RmpPanel extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      var scale = num(this, 'scale', 1);
      /* [active, standby] held in panel state — the display element is write-only */
      this.freq = [num(this, 'active', 121825), num(this, 'standby', 126375)];
      this.style.cssText = 'display:inline-block;font-family:Helvetica,Arial,sans-serif;' + (this.getAttribute('style') || '');

      var x0 = 56, pitch = 120, r1 = 176, r2 = 250, r3 = 356;
      var html = '<panel-chassis></panel-chassis>';

      html += cap(214, 26, 'ACTIVE', { size: 15, ls: '2' }) + cap(626, 26, 'STBY/CRS', { size: 15, ls: '2' });
      html += '<seven-seg data-disp="active" digits="6" value="' + this.freq[0] + '" label="" on-color="' + AMBER + '" ' +
        'scale="1.05" pad-x="24" pad-y="15" style="position:absolute;left:56px;top:44px"></seven-seg>';
      html += '<seven-seg data-disp="stby" digits="6" value="' + this.freq[1] + '" label="" on-color="' + AMBER + '" ' +
        'scale="1.05" pad-x="24" pad-y="15" style="position:absolute;left:450px;top:44px"></seven-seg>';

      /* transfer key between the two windows */
      html += '<div data-xfer style="position:absolute;left:370px;top:56px;width:66px;height:64px;border-radius:4px;' +
        'display:flex;align-items:center;justify-content:center;' +
        'background:linear-gradient(180deg,#2b3338 0%,#12181b 55%,#080c0e 100%);' +
        'box-shadow:0 4px 9px rgba(0,0,0,.6), inset 0 1px 1px rgba(190,215,225,.22), inset 0 -2px 4px rgba(0,0,0,.7);' +
        'cursor:pointer;user-select:none;touch-action:manipulation">' +
        '<svg width="44" height="18" viewBox="0 0 54 18" style="pointer-events:none;overflow:visible">' +
          '<g stroke="#3ef07a" fill="#3ef07a" style="filter:drop-shadow(0 0 5px rgba(62,240,122,.7))">' +
            '<line x1="10" y1="9" x2="44" y2="9" stroke-width="3" stroke-linecap="round"></line>' +
            '<polygon points="1,9 13,2 13,16" stroke="none"></polygon>' +
            '<polygon points="53,9 41,2 41,16" stroke="none"></polygon>' +
          '</g>' +
        '</svg></div>';

      RMP_ROW1.forEach(function (b, i) {
        var x = x0 + i * pitch;
        html += caret(b[0], x + BW / 2, r1 - 16, i === 0 ? 'sel' : 'off') + rmpBtn(b[0], b[1], x, r1);
      });

      RMP_ROW2.forEach(function (b, i) {
        var x = x0 + i * pitch;
        if (b[0] === 'sel') {
          /* SEL is a debossed indicator window: legend inside, lamp dot below it.
             Both are unlit by default — setSel(true) brings them up amber. */
          var cx = x + BW / 2;
          var D = 54;
          html += '<div data-sel style="position:absolute;left:' + (cx - D / 2) + 'px;top:' + (r2 + BH / 2 - D / 2) + 'px;' +
            'width:' + D + 'px;height:' + D + 'px;border-radius:50%;pointer-events:none;' +
            'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;' +
            'background:radial-gradient(circle at 50% 65%,#151b1f 0%,#0d1113 65%,#080b0c 100%);' +
            'box-shadow:inset 0 4px 8px rgba(0,0,0,.9), inset 0 -2px 3px rgba(190,215,225,.10), 0 1px 0 rgba(190,215,225,.12)">' +
            '<span data-sel-text style="font-size:13px;font-weight:700;letter-spacing:1.4px;' +
              'color:rgba(232,220,184,.18)">SEL</span>' +
            '<i data-sel-dot style="display:block;width:8px;height:8px;border-radius:50%;' +
              'background:rgba(255,177,90,.16);box-shadow:inset 0 1px 2px rgba(0,0,0,.7)"></i>' +
            '</div>';
          return;
        }
        html += caret(b[0], x + BW / 2, r2 - 16) + rmpBtn(b[0], b[1], x, r2);
      });

      /* STBY NAV bracket */
      var bx0 = x0 - 8, bx1 = x0 + 5 * pitch + BW + 8;
      html += '<div style="position:absolute;left:' + bx0 + 'px;top:' + (r3 - 32) + 'px;width:' + (bx1 - bx0) +
        'px;height:32px;border:2px solid rgba(232,220,184,.55);border-bottom:none;border-radius:3px 3px 0 0;' +
        'pointer-events:none"></div>';
      html += '<div style="position:absolute;left:' + (bx0 + (bx1 - bx0) / 2 - 80) + 'px;top:' + (r3 - 42) + 'px;' +
        'width:160px;height:20px;background:#2e4f61;pointer-events:none"></div>';
      html += cap(bx0 + (bx1 - bx0) / 2, r3 - 32, 'STBY NAV', { size: 15, ls: '2' });

      RMP_NAV.forEach(function (b, i) {
        var x = x0 + i * pitch;
        if (b[0] === 'blank') {
          html += '<div style="position:absolute;left:' + x + 'px;top:' + r3 + 'px;width:' + BW + 'px;height:' + BH +
            'px;border-radius:4px;background:linear-gradient(180deg,#20272b 0%,#0d1214 60%,#070a0c 100%);' +
            'box-shadow:0 4px 9px rgba(0,0,0,.6), inset 0 1px 1px rgba(190,215,225,.14)"></div>';
          return;
        }
        html += caret(b[0], x + BW / 2, r3 - 12) + rmpBtn(b[0], b[1], x, r3);
      });

      /* clear plastic flip-lid over the NAV key, hinged along its top edge */
      var gx = x0 - 10, gy = r3 - 26, gw = BW + 20, gh = BH + 38;
      html += '<div data-guard style="position:absolute;left:' + gx + 'px;top:' + gy + 'px;' +
        'width:' + gw + 'px;height:' + gh + 'px;cursor:pointer;touch-action:manipulation;' +
        'transform-origin:50% 4px;transform-style:preserve-3d;perspective:600px;' +
        'transition:transform .34s cubic-bezier(.34,1.24,.64,1)">' +
        /* hinge barrel across the top */
        '<div style="pointer-events:none;position:absolute;left:6px;top:0;width:' + (gw - 12) + 'px;height:7px;border-radius:4px;' +
          'background:linear-gradient(180deg,#c9d6da 0%,#8b979c 45%,#4e585c 100%);' +
          'box-shadow:0 1px 2px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.7)"></div>' +
        /* hinge pins */
        '<div style="pointer-events:none;position:absolute;left:0;top:-1px;width:9px;height:9px;border-radius:50%;' +
          'background:radial-gradient(circle at 35% 30%,#e6eef1,#5a6469);box-shadow:0 1px 2px rgba(0,0,0,.6)"></div>' +
        '<div style="pointer-events:none;position:absolute;right:0;top:-1px;width:9px;height:9px;border-radius:50%;' +
          'background:radial-gradient(circle at 35% 30%,#e6eef1,#5a6469);box-shadow:0 1px 2px rgba(0,0,0,.6)"></div>' +
        /* the lid itself — thin acrylic pane with a rolled lower lip */
        '<div style="position:absolute;left:0;top:5px;right:0;bottom:0;border-radius:3px 3px 7px 7px;' +
          'background:linear-gradient(158deg,rgba(232,244,248,.30) 0%,rgba(200,222,230,.10) 38%,' +
            'rgba(178,200,208,.07) 62%,rgba(235,246,250,.26) 100%);' +
          'box-shadow:inset 0 0 0 2px rgba(228,242,246,.42), inset 0 2px 5px rgba(255,255,255,.35),' +
            ' inset 0 -3px 6px rgba(255,255,255,.22), 0 5px 12px rgba(0,0,0,.45);' +
          'backdrop-filter:blur(.5px);pointer-events:none">' +
          /* specular streak across the pane */
          '<div style="position:absolute;left:8%;top:8%;width:34%;height:78%;border-radius:2px;' +
            'background:linear-gradient(150deg,rgba(255,255,255,.34) 0%,rgba(255,255,255,.06) 70%,rgba(255,255,255,0) 100%)"></div>' +
          /* grip lip along the bottom edge */
          '<div style="position:absolute;left:22%;right:22%;bottom:-3px;height:8px;border-radius:5px;' +
            'background:linear-gradient(180deg,rgba(240,250,252,.55),rgba(150,172,180,.35));' +
            'box-shadow:0 2px 4px rgba(0,0,0,.45)"></div>' +
        '</div></div>';

      /* tuning knob + power switch */
      html += '<fcu-knob knob-id="rmp-tune" size="170" boss="true" ring="false" detent="10" knurl="false" ' +
        'bezel-mark="true" cap-inset="34" style="position:absolute;left:646px;top:150px"></fcu-knob>';
      html += '<fcu-lever lever-id="rmp-power" vertical="true" size="46" position="right" ' +
        'style="position:absolute;left:' + (RMP_W - 90) + 'px;top:' + (r3 - 6) + 'px"></fcu-lever>';
      html += cap(RMP_W - 67, r3 - 26, 'ON', { size: 12, glow: true }) +
              cap(RMP_W - 67, r3 + 62, 'OFF', { size: 12, glow: true });

      this.innerHTML =
        '<div data-box style="width:' + (RMP_W * scale) + 'px;height:' + (RMP_H * scale) + 'px">' +
          '<div data-panel style="position:relative;box-sizing:border-box;width:' + RMP_W + 'px;height:' + RMP_H + 'px;' +
            'transform-origin:top left' + (scale === 1 ? '' : ';transform:scale(' + scale + ')') + '">' +
            html +
          '</div></div>';

      var self = this;
      var api = {
        display: function (k) { var e = self.querySelector('[data-disp="' + k + '"]'); return e && e.segdisplay; },
        button: function (id) { var e = self.querySelector('[data-btn="' + id + '"]'); return e && e.button; },
        knob: function () { var e = self.querySelector('[data-knob="rmp-tune"]'); return e && e.knob; },
        power: function () { var e = self.querySelector('[data-lever="rmp-power"]'); return e && e.lever; },
        /* 'off' (white silkscreen) | 'lit' (amber backlight) | 'sel' (green) */
        setCaret: function (id, state) {
          var el = self.querySelector('[data-caret="' + id + '"]');
          if (!el) return;
          var s = CARET[state] || CARET.off;
          el.style.borderTopColor = s.c;
          el.style.filter = s.glow;
        },
        selectChannel: function (id) {
          self.querySelectorAll('[data-caret]').forEach(function (el) {
            var s = el.dataset.caret === id ? CARET.sel : (self._backlit ? CARET.lit : CARET.off);
            el.style.borderTopColor = s.c;
            el.style.filter = s.glow;
          });
          self._channel = id;
        },
        channel: function () { return self._channel || 'vhf1'; },
        setBacklight: function (on) {
          self._backlit = !!on;
          api.selectChannel(self._channel || 'vhf1');
        },
        guardOpen: function () { return !!self._guardOpen; },
        setGuard: function (open) { self._setGuard(!!open); },
        selLit: function () { return !!self._sel; },
        setSel: function (on) {
          self._sel = !!on;
          var t = self.querySelector('[data-sel-text]'), d = self.querySelector('[data-sel-dot]');
          if (t) { t.style.color = on ? AMBER : 'rgba(232,220,184,.18)'; t.style.textShadow = on ? GLOW : 'none'; }
          if (d) {
            d.style.background = on ? AMBER : 'rgba(255,177,90,.16)';
            d.style.boxShadow = on ? '0 0 9px rgba(255,150,40,.85)' : 'inset 0 1px 2px rgba(0,0,0,.7)';
          }
        },
        onTransfer: function (fn) { self._xferCb = fn; },
        transfer: function () { self._transfer(); },
        freq: function () { return self.freq.slice(); },
        setFreq: function (active, standby) {
          if (active !== null && active !== undefined) self.freq[0] = active;
          if (standby !== null && standby !== undefined) self.freq[1] = standby;
          self._paint();
        },
        root: this
      };
      this.panel = api;
      this.api = api;
      if (typeof window !== 'undefined') window.rmpPanel = api;
      this._channel = 'vhf1';
      this._wire();
      this._paint();
      this.dispatchEvent(new CustomEvent('rmp-ready', { detail: api, bubbles: true }));
    }

    _wire() {
      var self = this;
      var g = this.querySelector('[data-guard]');
      var nav = this.querySelector('[data-btn="nav"]');
      /* closed lid physically blocks the NAV key; clicking the lid swings it up */
      var setGuard = function (open) {
        self._guardOpen = open;
        g.style.transform = open ? 'rotateX(-104deg)' : '';
        g.style.boxShadow = open ? '0 10px 18px rgba(0,0,0,.35)' : '';
        if (nav) nav.style.pointerEvents = open ? '' : 'none';
      };
      this._setGuard = setGuard;
      g.addEventListener('click', function () { setGuard(!self._guardOpen); });
      setGuard(false);

      var x = this.querySelector('[data-xfer]');
      x.addEventListener('pointerdown', function () {
        x.style.boxShadow = '0 1px 3px rgba(0,0,0,.6), inset 0 3px 7px rgba(0,0,0,.85)';
      });
      var up = function () {
        x.style.boxShadow = '0 4px 9px rgba(0,0,0,.6), inset 0 1px 1px rgba(190,215,225,.22), inset 0 -2px 4px rgba(0,0,0,.7)';
      };
      x.addEventListener('pointerup', function () { up(); self._transfer(); });
      x.addEventListener('pointerleave', up);
      x.addEventListener('pointercancel', up);
    }

      /* both windows read 121.825 style — dp sits on the digit after the MHz part */
    _paint() {
      var self = this;
      ['active', 'stby'].forEach(function (k, i) {
        var e = self.querySelector('[data-disp="' + k + '"]');
        if (!e || !e.segdisplay) return;
        e.segdisplay.set(String(self.freq[i]).padStart(6, '0'));
        e.segdisplay.setDecimal(3, true);
      });
    }

    _transfer() {
      this.freq = [this.freq[1], this.freq[0]];
      this._paint();
      if (this._xferCb) this._xferCb(this.freq[0], this.freq[1]);
    }
  }

  /* ============================================================ ACP panel */

  var ACP_W = 872, ACP_H = 428;
  /* row-1 keys are standard three-stripe-LED Airbus buttons; their legends are
     CALL on the five radio channels, then MECH (INT) and ATT (CAB) */
  var ACP_TOP = [['vhf1', 'VHF1', 'CALL'], ['vhf2', 'VHF2', 'CALL'], ['vhf3', 'VHF3', 'CALL'],
                 ['hf1', 'HF1', 'CALL'], ['hf2', 'HF2', 'CALL'],
                 ['int', 'INT', 'MECH'], ['cab', 'CAB', 'ATT']];
  var ACP_BOTTOM = [['vor1', 'VOR1'], ['vor2', 'VOR2'], ['mkr', 'MKR'], ['ls', 'LS'],
                    ['nav', ''], ['adf1', 'ADF1'], ['adf2', 'ADF2']];

  class AcpPanel extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      var scale = num(this, 'scale', 1);
      this.style.cssText = 'display:inline-block;font-family:Helvetica,Arial,sans-serif;' + (this.getAttribute('style') || '');

      var x0 = 82, pitch = 118, KW = 100, KH = 48, KN = 54;
      var html = '<panel-chassis></panel-chassis>';

      /* row 1 — transmit keys, their legends, and the reception volume pots */
      ACP_TOP.forEach(function (b, i) {
        var cx = x0 + i * pitch;
        /* LEDs dark and legend greyed at rest; setLed() and setBacklight()
           drive the two independently */
        html += '<fcu-led-button btn-id="' + b[0] + '-call" label="' + b[2] + '" lit="false" ' +
          'backlit="false" label-color="rgba(232,220,184,.34)" ' +
          'width="' + KW + '" height="' + KH + '" ' +
          'style="position:absolute;left:' + (cx - KW / 2) + 'px;top:26px"></fcu-led-button>';
        html += cap(cx, 92, b[1], { size: 12, glow: true, color: AMBER });
        html += '<acp-knob knob-id="' + b[0] + '-vol" size="' + KN + '" value="' + (35 + i * 4) + '" ' +
          'style="left:' + (cx - KN / 2) + 'px;top:' + (136 - KN / 2) + 'px"></acp-knob>';
      });

      /* middle band — INT/RAD selector, VOICE / RESET, PA */
      html += cap(x0, 196, 'INT', { size: 11, glow: true, color: AMBER });
      html += '<fcu-lever lever-id="int-rad" vertical="true" size="40" position="right" ' +
        'style="position:absolute;left:' + (x0 - 20) + 'px;top:210px"></fcu-lever>';
      html += cap(x0, 274, 'RAD', { size: 11, glow: true, color: AMBER });

      html += '<fcu-led-button btn-id="voice" label="VOICE" lit="false" backlit="false" ' +
        'label-color="rgba(232,220,184,.34)" width="104" height="46" ' +
        'style="position:absolute;left:' + (x0 + 84) + 'px;top:212px"></fcu-led-button>';
      html += '<fcu-led-button btn-id="reset" label="RESET" led="none" width="104" height="46" ' +
        'style="position:absolute;left:' + (x0 + 202) + 'px;top:212px"></fcu-led-button>';

      html += '<acp-knob knob-id="pa-vol" size="' + KN + '" value="45" ' +
        'style="left:' + (x0 + 372) + 'px;top:208px"></acp-knob>';
      html += cap(x0 + 468, 235, 'PA', { size: 13, glow: true, color: AMBER });
      html += '<fcu-led-button btn-id="pa-key" label="" lit="false" ' +
        'width="' + KW + '" height="' + KH + '" ' +
        'style="position:absolute;left:' + (x0 + 500) + 'px;top:211px"></fcu-led-button>';

      /* row 2 — nav reception pots */
      ACP_BOTTOM.forEach(function (b, i) {
        var cx = x0 + i * pitch;
        if (b[1]) html += cap(cx, 318, b[1], { size: 12, glow: true, color: AMBER });
        html += '<acp-knob knob-id="' + b[0] + '-vol" size="' + KN + '" value="' + (30 + i * 5) + '" ' +
          'style="left:' + (cx - KN / 2) + 'px;top:' + (362 - KN / 2) + 'px"></acp-knob>';
      });

      this.innerHTML =
        '<div data-box style="width:' + (ACP_W * scale) + 'px;height:' + (ACP_H * scale) + 'px">' +
          '<div data-panel style="position:relative;box-sizing:border-box;width:' + ACP_W + 'px;height:' + ACP_H + 'px;' +
            'transform-origin:top left' + (scale === 1 ? '' : ';transform:scale(' + scale + ')') + '">' +
            html +
          '</div></div>';

      var self = this;
      var api = {
        /* row-1 three-stripe-LED call keys: 'vhf1' … 'cab', plus 'pa' */
        key: function (id) {
          var e = self.querySelector('[data-btn="' + id + '-call"]') ||
                  self.querySelector('[data-btn="' + id + '-key"]');
          if (e && e.button) return e.button;
          e = self.querySelector('[data-acp-key="' + id + '"]');
          return e && e.key;
        },
        volume: function (id) { var e = self.querySelector('[data-acp-knob="' + id + '-vol"]'); return e && e.knob; },
        button: function (id) { var e = self.querySelector('[data-btn="' + id + '"]'); return e && e.button; },
        intRad: function () { var e = self.querySelector('[data-lever="int-rad"]'); return e && e.lever; },
        root: this
      };
      this.panel = api;
      this.api = api;
      if (typeof window !== 'undefined') window.acpPanel = api;
      this.dispatchEvent(new CustomEvent('acp-ready', { detail: api, bubbles: true }));
    }
  }

  if (!customElements.get('acp-knob')) customElements.define('acp-knob', AcpKnob);
  if (!customElements.get('acp-key')) customElements.define('acp-key', AcpKey);
  if (!customElements.get('rmp-panel')) customElements.define('rmp-panel', RmpPanel);
  if (!customElements.get('acp-panel')) customElements.define('acp-panel', AcpPanel);
})();
