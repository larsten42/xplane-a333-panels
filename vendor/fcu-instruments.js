/*
 * Airbus-style FCU / EFIS instrumentation — vanilla custom elements.
 * No dependencies, no build step, no network. Works from file://.
 *
 *   <script src="fcu-instruments.js"></script>
 *   <fcu-panel></fcu-panel>
 *   <efis-panel></efis-panel>
 *
 * Every element exposes an imperative API as properties on the DOM node
 * (el.knob, el.button, el.lever, el.fcu, el.segdisplay, el.panel).
 */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- utils */

  var AMBER = '#ffb15a';
  var SILK = 'rgba(226,238,243,.7)';
  var SILK_AMBER = 'rgba(255,177,90,.9)';
  var SILK_WHITE = '#e8eef0';
  var GLOW_TEXT = '0 0 7px rgba(255,150,40,.55), 0 0 14px rgba(255,130,20,.28), 0 1px 1px rgba(0,0,0,.8)';
  var GLOW_COLLAR = '0 0 6px 1px rgba(255,138,26,.62), 0 0 13px 2px rgba(255,124,18,.26)';
  var SEG_OFF = 'rgba(230,214,170,.07)';
  var LABEL_OFF = 'rgba(232,220,184,.16)';

  function capture(el, id) {
    try { el.setPointerCapture(id); } catch (err) { /* best-effort: stray pointer id */ }
  }

  function alpha(hex, a) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return 'rgba(247,220,140,' + a + ')';
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* Apply base styles WITHOUT clobbering the author's inline style attribute. */
  function base(el, css) {
    var own = el.getAttribute('style') || '';
    el.style.cssText = css + (own ? ';' + own : '');
  }

  function num(el, name, dflt) {
    var v = el.getAttribute(name);
    if (v === null || v === '') return dflt;
    var f = parseFloat(v);
    return isNaN(f) ? dflt : f;
  }

  function flag(el, name, dflt) {
    var v = el.getAttribute(name);
    if (v === null) return dflt;
    return v !== 'false' && v !== '0';
  }

  function list(el, name, dflt) {
    var v = el.getAttribute(name);
    if (!v) return dflt;
    var out = v.split(',').map(function (s) { return parseFloat(s); }).filter(function (n) { return !isNaN(n); });
    return out.length ? out : dflt;
  }

  /* ------------------------------------------------- seven-segment digits */

  var SEG_H = 'clip-path:polygon(0% 50%,15% 0%,85% 0%,100% 50%,85% 100%,15% 100%)';
  var SEG_V = 'clip-path:polygon(50% 0%,100% 12%,100% 88%,50% 100%,0% 88%,0% 12%)';
  var SEGS = {
    dp: 'left:-9px;top:48px;width:6px;height:6px;border-radius:1px',
    a: 'left:6.5px;top:0;width:17px;height:6px;' + SEG_H,
    g: 'left:6.5px;top:24px;width:17px;height:6px;' + SEG_H,
    d: 'left:6.5px;top:48px;width:17px;height:6px;' + SEG_H,
    f: 'left:0;top:3.5px;width:6px;height:21px;' + SEG_V,
    b: 'left:24px;top:3.5px;width:6px;height:21px;' + SEG_V,
    e: 'left:0;top:29.5px;width:6px;height:21px;' + SEG_V,
    c: 'left:24px;top:29.5px;width:6px;height:21px;' + SEG_V
  };

  function digit(id) {
    var h = '<div data-d="' + id + '" style="position:relative;width:30px;height:54px;flex:none">';
    for (var k in SEGS) {
      h += '<i data-s="' + k + '" style="position:absolute;background:' + SEG_OFF + ';' + SEGS[k] + '"></i>';
    }
    return h + '</div>';
  }

  var GLYPHS = {
    '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg',
    '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g', '_': 'd',
    'A': 'abcefg', 'b': 'cdefg', 'C': 'adef', 'c': 'deg', 'd': 'bcdeg', 'E': 'adefg',
    'F': 'aefg', 'H': 'bcefg', 'h': 'cefg', 'I': 'bc', 'L': 'def', 'n': 'ceg',
    'o': 'cdeg', 'P': 'abefg', 'r': 'eg', 'S': 'acdfg', 't': 'defg', 'U': 'bcdef',
    'u': 'cde', ' ': ''
  };

  function glyph(ch) {
    if (GLYPHS[ch] !== undefined) return GLYPHS[ch];
    return GLYPHS[String(ch).toUpperCase()] || '';
  }

  /* A shared lit/unlit painter for anything with data-s / data-l. */
  function Lamp(host) {
    this.host = host;
    this.on = AMBER;
    this.off = SEG_OFF;
    this.glow = true;
    this._derive();
  }
  Lamp.prototype._derive = function () {
    this.shadow = 'drop-shadow(0 0 5px ' + alpha(this.on, 0.55) + ')';
    this.text = '0 0 8px ' + alpha(this.on, 0.5);
  };
  Lamp.prototype.setColor = function (hex) { this.on = hex; this._derive(); };
  Lamp.prototype.light = function (el, on) {
    el.dataset.on = on ? '1' : '';
    el.style.background = on ? this.on : this.off;
    el.style.filter = (on && this.glow) ? this.shadow : 'none';
  };
  Lamp.prototype.label = function (el, on) {
    el.dataset.on = on ? '1' : '';
    el.style.color = on ? this.on : LABEL_OFF;
    el.style.textShadow = (on && this.glow) ? this.text : 'none';
  };

  var WINDOW_BG = 'background:linear-gradient(180deg,#132227 0%,#0c181c 55%,#0a1418 100%);' +
    'box-shadow:inset 0 0 0 1px #2b4a52, inset 0 2px 14px rgba(0,0,0,.8), 0 8px 30px rgba(0,0,0,.6)';

  /* ============================================================ chassis */

  var SCREW = 'width:15px;height:15px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#7f9aa8,#243b47 70%);' +
    'box-shadow:inset 0 1px 1px rgba(255,255,255,.4), 0 1px 2px rgba(0,0,0,.5)';

  class PanelChassis extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      this.dataset.chassis = '1';
      var dark = this.getAttribute('tone') === 'dark';
      base(this, 'position:absolute;left:0;top:0;width:100%;height:100%;border-radius:12px;' +
        (dark
          ? 'background:linear-gradient(163deg,#3b4044 0%,#2b3033 18%,#1d2123 52%,#15181a 78%,#0c0e10 100%);' +
            'box-shadow:inset 0 2px 0 rgba(200,210,215,.22), inset 0 -3px 0 rgba(0,0,0,.6),' +
            ' inset 3px 0 0 rgba(160,170,175,.10), inset -3px 0 0 rgba(0,0,0,.35), 0 22px 50px rgba(0,0,0,.7);'
          : 'background:linear-gradient(163deg,#5b7d8e 0%,#3f6274 18%,#2e4f61 52%,#26424f 78%,#1b3240 100%);' +
            'box-shadow:inset 0 2px 0 rgba(190,225,240,.35), inset 0 -3px 0 rgba(0,0,0,.55),' +
            ' inset 3px 0 0 rgba(150,190,205,.12), inset -3px 0 0 rgba(0,0,0,.3), 0 22px 50px rgba(0,0,0,.65);') +
        'pointer-events:none');
      var screws = flag(this, 'screws', true)
        ? '<i data-screw="tl" style="position:absolute;left:15px;top:15px;' + SCREW + '"></i>' +
          '<i data-screw="tr" style="position:absolute;right:15px;top:15px;' + SCREW + '"></i>' +
          '<i data-screw="bl" style="position:absolute;left:15px;bottom:15px;' + SCREW + '"></i>' +
          '<i data-screw="br" style="position:absolute;right:15px;bottom:15px;' + SCREW + '"></i>'
        : '';
      this.innerHTML =
        '<div style="position:absolute;inset:8px;border-radius:8px;box-shadow:inset 0 0 0 1px rgba(10,25,35,.45), inset 0 1px 0 rgba(180,215,230,.18)"></div>' +
        '<div style="position:absolute;inset:0;border-radius:12px;background:radial-gradient(120% 90% at 50% -10%, rgba(255,255,255,.10) 0%, rgba(255,255,255,0) 55%)"></div>' +
        screws;
      if (dark) {
        this.querySelectorAll('[data-screw]').forEach(function (el) {
          el.style.background = 'radial-gradient(circle at 35% 30%,#8a8f93,#22262a 70%)';
        });
      }
    }
  }

  /* ==================================================== generic seven-seg */

  class SevenSeg extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      var n = num(this, 'digits', 4);
      this.lamp = new Lamp(this);
      this.lamp.glow = flag(this, 'glow', true);
      if (this.getAttribute('on-color')) this.lamp.setColor(this.getAttribute('on-color'));

      base(this, 'position:relative;display:inline-flex;flex-direction:column;align-items:center;' +
        'border-radius:5px;font-family:Helvetica,Arial,sans-serif;' + WINDOW_BG);
      if (this.getAttribute('bezel-tone') === 'black') {
        this.style.background = 'linear-gradient(180deg,#16181a 0%,#0b0c0e 55%,#060708 100%)';
        this.style.boxShadow = 'inset 0 0 0 1px #34383c, inset 0 2px 14px rgba(0,0,0,.85), 0 6px 20px rgba(0,0,0,.6)';
      }

      var digits = '';
      for (var i = 0; i < n; i++) digits += digit('d' + i);
      this.innerHTML =
        '<span data-l="TITLE" style="font-size:17px;font-weight:700;letter-spacing:2px;color:' + LABEL_OFF + '"></span>' +
        '<div data-box style="position:relative"><div data-row style="position:absolute;left:0;top:0;display:flex;align-items:flex-end;gap:12px">' +
        digits + '</div></div>';

      this._label = this.querySelector('[data-l="TITLE"]');
      this._box = this.querySelector('[data-box]');
      this._row = this.querySelector('[data-row]');

      var self = this;
      this.segdisplay = {
        set: function (v) { self._setValue(v); },
        setLabel: function (on) { self.lamp.label(self._label, !!on); },
        setLabelText: function (t) { self._label.textContent = t; },
        setDecimal: function (i, on) {
          var d = self.querySelector('[data-d="d' + i + '"] [data-s="dp"]');
          if (d) self.lamp.light(d, !!on);
        },
        lampTest: function () {
          self.querySelectorAll('i[data-s]').forEach(function (s) { self.lamp.light(s, true); });
          self.lamp.label(self._label, true);
        },
        clear: function () {
          self.querySelectorAll('i[data-s]').forEach(function (s) { self.lamp.light(s, false); });
          self.lamp.label(self._label, false);
        },
        dashes: function () { self._setValue(new Array(num(self, 'digits', 4) + 1).join('-')); },
        setColor: function (hex) { self.lamp.setColor(hex); self._repaint(); },
        setGlow: function (on) { self.lamp.glow = !!on; self._repaint(); },
        setBrightness: function (v) { self.style.opacity = Math.max(0.15, Math.min(1, v)); },
        root: this
      };

      this._layout();
      this._setValue(this.getAttribute('value') || '1013');
      this.lamp.label(this._label, flag(this, 'label-lit', true));
      this.dispatchEvent(new CustomEvent('segdisplay-ready', { detail: this.segdisplay, bubbles: true }));
    }

    _layout() {
      var s = num(this, 'scale', 1);
      var n = num(this, 'digits', 4);
      var w = n * 30 + (n - 1) * 12;
      this._row.style.transform = s === 1 ? '' : 'scale(' + s + ')';
      this._row.style.transformOrigin = 'top left';
      this._box.style.width = (w * s) + 'px';
      this._box.style.height = (54 * s) + 'px';
      this.style.padding = num(this, 'pad-y', 13) + 'px ' + num(this, 'pad-x', 18) + 'px';
      this.style.borderRadius = num(this, 'radius', 5) + 'px';
      this.style.gap = num(this, 'gap', 6) + 'px';
      var al = this.getAttribute('label-align') || 'center';
      this.style.alignItems = al === 'left' ? 'flex-start' : al === 'right' ? 'flex-end' : 'center';
      var txt = this.getAttribute('label');
      this._label.textContent = txt === null ? 'QNH' : txt;
      this._label.style.fontSize = (17 * s) + 'px';
      this._label.style.display = txt === '' ? 'none' : '';
    }

    _repaint() {
      var self = this;
      this.querySelectorAll('i[data-s]').forEach(function (s) { self.lamp.light(s, s.dataset.on === '1'); });
      this.lamp.label(this._label, this._label.dataset.on === '1');
    }

    _setValue(v) {
      var len = num(this, 'digits', 4);
      var s = (v === null || v === undefined) ? '' : String(v);
      s = s.slice(-len);
      while (s.length < len) s = ' ' + s;
      for (var i = 0; i < len; i++) {
        var d = this.querySelector('[data-d="d' + i + '"]');
        if (!d) continue;
        var segs = glyph(s[i]);
        var self = this;
        d.querySelectorAll('i[data-s]').forEach(function (el) {
          var k = el.getAttribute('data-s');
          if (k !== 'dp') self.lamp.light(el, segs.indexOf(k) !== -1);
        });
      }
    }
  }

  /* ======================================================== FCU display */

  var FIELDS = { spd: 3, hdg: 3, alt: 5, vs: 4 };
  var LABELS = ['SPD', 'MACH', 'HDG', 'TRK', 'LAT', 'HDG2', 'TRK2', 'VS2', 'FPA2',
    'ALT', 'LVLCH', 'VS', 'FPA', 'SPDDOT', 'HDGDOT', 'ALTDOT'];

  var LBL = 'font-size:17px;font-weight:700;letter-spacing:1px';
  var DOT = 'width:22px;height:22px;border-radius:50%;background:' + SEG_OFF + ';align-self:center;flex:none';

  function annun(name, text) {
    return '<span data-l="' + name + '" style="color:' + LABEL_OFF + '">' + text + '</span>';
  }

  class FcuDisplay extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      this.lamp = new Lamp(this);
      this.lamp.glow = flag(this, 'glow', true);
      if (this.getAttribute('on-color')) this.lamp.setColor(this.getAttribute('on-color'));
      base(this, 'display:inline-block;font-family:Helvetica,Arial,sans-serif');

      var win = 'position:relative;box-sizing:border-box;width:532px;flex:none;' + WINDOW_BG + ';border-radius:6px';

      var lvlch =
        '<span data-l="LVLCH" style="position:absolute;left:148px;width:175px;bottom:0;height:19px;color:' + LABEL_OFF + ';line-height:19px">' +
        '<i style="position:absolute;left:0;top:9px;width:48px;height:2px;background:currentColor"></i>' +
        '<i style="position:absolute;right:0;top:9px;width:48px;height:2px;background:currentColor"></i>' +
        '<i style="position:absolute;left:0;top:9px;width:2px;height:10px;background:currentColor"></i>' +
        '<i style="position:absolute;right:0;top:9px;width:2px;height:10px;background:currentColor"></i>' +
        '<span style="position:absolute;left:50%;top:0;transform:translateX(-50%);white-space:nowrap">LVL/CH</span>' +
        '</span>';

      var sign =
        '<div data-sign="vs" style="position:relative;width:24px;height:54px;flex:none;margin-left:4px">' +
        '<i data-s="h" style="position:absolute;left:0;top:24px;width:24px;height:6px;background:' + SEG_OFF + ';' + SEG_H + '"></i>' +
        '<i data-s="v" style="position:absolute;left:9px;top:15px;width:6px;height:24px;background:' + SEG_OFF + ';' + SEG_V + '"></i>' +
        '</div>';

      this.innerHTML =
        '<div style="display:flex;align-items:stretch;gap:30px">' +

        '<div style="' + win + ';display:flex;align-items:flex-end;justify-content:space-between;padding:18px 22px 20px">' +
          '<div style="display:flex;flex-direction:column;gap:8px">' +
            '<div style="display:flex;gap:14px;' + LBL + '">' + annun('SPD', 'SPD') + annun('MACH', 'MACH') + '</div>' +
            '<div style="display:flex;align-items:flex-end;gap:12px">' +
              digit('spd0') + digit('spd1') + digit('spd2') +
              '<span data-l="SPDDOT" style="' + DOT + '"></span>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:8px">' +
            '<div style="display:flex;gap:12px;' + LBL + '">' + annun('HDG', 'HDG') + annun('TRK', 'TRK') + annun('LAT', 'LAT') + '</div>' +
            '<div style="display:flex;align-items:flex-end;gap:12px">' +
              digit('hdg0') + digit('hdg1') + digit('hdg2') +
              '<span data-l="HDGDOT" style="' + DOT + '"></span>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:2px;' + LBL + ';padding-bottom:12px">' +
            annun('HDG2', 'HDG') + annun('TRK2', 'TRK') +
          '</div>' +
        '</div>' +

        '<div style="' + win + ';display:flex;align-items:flex-end;gap:12px;padding:18px 20px 20px">' +
          '<div style="display:flex;flex-direction:column;gap:2px;' + LBL + ';padding-bottom:12px">' +
            annun('VS2', 'V/S') + annun('FPA2', 'FPA') +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:8px">' +
            '<div style="position:relative;width:440px;height:22px;' + LBL + '">' +
              '<span data-l="ALT" style="position:absolute;left:74px;bottom:0;color:' + LABEL_OFF + '">ALT</span>' +
              lvlch +
              '<span data-l="VS" style="position:absolute;right:44px;bottom:0;color:' + LABEL_OFF + '">V/S</span>' +
              '<span data-l="FPA" style="position:absolute;right:0;bottom:0;color:' + LABEL_OFF + '">FPA</span>' +
            '</div>' +
            '<div style="display:flex;align-items:flex-end;gap:12px">' +
              digit('alt0') + digit('alt1') + digit('alt2') + digit('alt3') + digit('alt4') +
              '<span data-l="ALTDOT" style="' + DOT + '"></span>' + sign +
              digit('vs0') + digit('vs1') + digit('vs2') + digit('vs3') +
            '</div>' +
          '</div>' +
        '</div>' +
        '</div>';

      var self = this;
      var api = {
        setField: function (f, v) { self._setField(f, v); },
        set: function (obj) {
          Object.keys(obj || {}).forEach(function (k) {
            if (FIELDS[k]) self._setField(k, obj[k]); else api.setLabel(k, obj[k]);
          });
        },
        setDecimal: function (field, i, on) {
          var d = self.querySelector('[data-d="' + field + i + '"] [data-s="dp"]');
          if (d) self.lamp.light(d, !!on);
        },
        showMach: function (v) {
          var s = String(v).replace('.', '');
          while (s.length < 3) s = ' ' + s;
          self._setField('spd', s);
          api.setDecimal('spd', 1, true);
          api.setLabel('MACH', true);
          api.setLabel('SPD', false);
        },
        setSign: function (s) { self._setSign(s); },
        setMode: function (mode) {
          var t = String(mode).toUpperCase().indexOf('TRK') !== -1;
          api.setLabels({ HDG: !t, TRK: t, HDG2: !t, TRK2: t, VS2: !t, FPA2: t, VS: !t, FPA: t });
        },
        setLabel: function (name, on) {
          var el = self.querySelector('[data-l="' + String(name).toUpperCase() + '"]');
          if (!el) return;
          if (!el.textContent.trim()) self.lamp.light(el, !!on);
          else self.lamp.label(el, !!on);
        },
        setLabels: function (obj) { Object.keys(obj || {}).forEach(function (k) { api.setLabel(k, obj[k]); }); },
        labels: LABELS.slice(),
        fields: Object.keys(FIELDS),
        lampTest: function () {
          self.querySelectorAll('i[data-s]').forEach(function (s) { self.lamp.light(s, true); });
          LABELS.forEach(function (l) { api.setLabel(l, true); });
        },
        clear: function () {
          self.querySelectorAll('i[data-s]').forEach(function (s) { self.lamp.light(s, false); });
          LABELS.forEach(function (l) { api.setLabel(l, false); });
        },
        dashes: function () {
          Object.keys(FIELDS).forEach(function (f) {
            self._setField(f, new Array(FIELDS[f] + 1).join('-'));
          });
        },
        setBrightness: function (v) { self.style.opacity = Math.max(0.15, Math.min(1, v)); },
        setColor: function (hex) { self.lamp.setColor(hex); self._repaint(); },
        setGlow: function (on) { self.lamp.glow = !!on; self._repaint(); },
        root: this
      };
      this.fcu = api;
      this.api = api;

      api.clear();
      api.set({ spd: '250', hdg: '270', alt: '32000', vs: '-1200' });
      api.setMode('HDG-VS');
      api.setLabels({ SPD: true, LAT: true, ALT: true, SPDDOT: true, HDGDOT: true, ALTDOT: true });
      this.dispatchEvent(new CustomEvent('fcu-ready', { detail: api, bubbles: true }));
    }

    _repaint() {
      var self = this;
      this.querySelectorAll('i[data-s]').forEach(function (s) { self.lamp.light(s, s.dataset.on === '1'); });
      LABELS.forEach(function (n) {
        var el = self.querySelector('[data-l="' + n + '"]');
        if (!el) return;
        if (!el.textContent.trim()) self.lamp.light(el, el.dataset.on === '1');
        else self.lamp.label(el, el.dataset.on === '1');
      });
    }

    _setSign(s) {
      var g = this.querySelector('[data-sign="vs"]');
      if (!g) return;
      this.lamp.light(g.querySelector('[data-s="h"]'), s === '+' || s === '-');
      this.lamp.light(g.querySelector('[data-s="v"]'), s === '+');
    }

    _setField(field, value) {
      var len = FIELDS[field];
      if (!len) return;
      var s = (value === null || value === undefined) ? '' : String(value);
      if (field === 'vs') {
        var sign = null;
        if (s[0] === '+' || s[0] === '-') { sign = s[0]; s = s.slice(1); }
        else if (s.trim()) sign = '+';
        this._setSign(s.trim() ? sign : null);
      }
      s = s.slice(-len);
      while (s.length < len) s = ' ' + s;
      for (var i = 0; i < len; i++) {
        var d = this.querySelector('[data-d="' + field + i + '"]');
        if (!d) continue;
        var segs = glyph(s[i]);
        var self = this;
        d.querySelectorAll('i[data-s]').forEach(function (el) {
          var k = el.getAttribute('data-s');
          if (k !== 'dp') self.lamp.light(el, segs.indexOf(k) !== -1);
        });
      }
    }
  }

  /* ============================================================== knob */

  var PETAL_TOOTH = 'position:absolute;left:50%;top:-9%;width:15%;height:22%;margin-left:-7.5%;' +
    'border-radius:2px;background:linear-gradient(160deg,#c6ced3 0%,#b1babf 100%)';

  class FcuKnob extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      var id = this.getAttribute('id-name') || this.getAttribute('knob-id') || '';
      this.dataset.knob = id;

      var size = num(this, 'size', 128);
      var k = size / 128;
      var bare = !flag(this, 'collar', true);
      var hasBezel = flag(this, 'bezel', false);
      var hasRing = flag(this, 'selector-ring', false);
      var boss = this.getAttribute('boss');
      var petal = boss === 'petal' || boss === 'petal-shallow';

      var glowInset = 9;
      var bezelInset = bare ? glowInset : 17;
      var capInset = hasBezel ? bezelInset + 8 : (bare ? glowInset : 26);
      if (this.hasAttribute('cap-inset')) capInset = num(this, 'cap-inset', capInset);
      var knurl = flag(this, 'knurl', true);

      base(this, 'position:relative;width:' + size + 'px;height:' + size + 'px;border-radius:50%;' +
        'background:transparent;cursor:ns-resize;touch-action:none;display:block');
      this.style.outline = flag(this, 'ring', true) ? '2px solid ' + SILK : 'none';
      this.style.outlineOffset = bare ? '-6px' : '-1px';
      this.style.boxShadow = bare ? 'none' : '0 6px 14px rgba(0,0,0,.55)';

      var petals = '';
      for (var a = 0; a < 360; a += 45) {
        petals += '<div style="position:absolute;left:0;top:0;width:100%;height:100%;transform:rotate(' + a + 'deg)">' +
          '<i style="' + PETAL_TOOTH + '"></i></div>';
      }

      this.innerHTML =
        '<div data-collar style="position:absolute;inset:' + (glowInset * k) + 'px;border-radius:50%"></div>' +
        '<div data-bezel style="position:absolute;inset:' + (bezelInset * k) + 'px;border-radius:50%;' +
          'background:repeating-conic-gradient(from 0deg,#cbd2d6 0deg 2.2deg,#8d979d 2.2deg 4.4deg);box-shadow:0 3px 8px rgba(0,0,0,.6)">' +
          '<div data-bezel-stub style="display:none;position:absolute;left:50%;top:50%;width:0;height:0">' +
            '<div style="position:absolute;left:-4px;top:-6px;width:8px;height:14px;border-radius:2px;' +
            'background:linear-gradient(180deg,#eef2f4 0%,#b9c1c6 60%,#79838a 100%);box-shadow:0 1px 2px rgba(0,0,0,.6)"></div>' +
          '</div>' +
        '</div>' +
        '<div data-capface style="position:absolute;inset:' + (capInset * k) + 'px;border-radius:50%">' +
          '<div data-petals style="display:none;position:absolute;left:16%;top:16%;right:16%;bottom:16%;z-index:3">' + petals + '</div>' +
          '<div data-boss style="display:none;position:absolute;left:12.5%;top:12.5%;right:12.5%;bottom:12.5%;border-radius:50%;z-index:3;' +
            'background:repeating-conic-gradient(from 0deg,#c4ccd1 0deg 5deg,#9aa3a9 5deg 10deg);' +
            'box-shadow:0 3px 6px rgba(0,0,0,.5), 0 1px 0 rgba(255,255,255,.45), inset 0 -3px 7px rgba(0,0,0,.4)">' +
            '<div data-boss-face style="position:absolute;left:7%;top:7%;right:7%;bottom:7%;border-radius:50%;' +
              'background:radial-gradient(circle at 38% 28%,#d3d9dd 0%,#aeb6bb 44%,#828b91 78%,#5f686e 100%);' +
              'box-shadow:inset 0 2px 3px rgba(255,255,255,.5), inset 0 -3px 6px rgba(0,0,0,.3)"></div>' +
            '<div data-boss-ring style="position:absolute;left:12%;top:12%;right:12%;bottom:12%;border-radius:50%;' +
              'border:3px solid rgba(238,244,247,.92);box-shadow:0 1px 2px rgba(0,0,0,.4), inset 0 1px 2px rgba(0,0,0,.35)"></div>' +
            '<svg data-tri viewBox="0 0 100 100" style="display:none;position:absolute;left:14%;top:14%;width:72%;height:72%;overflow:visible;filter:none">' +
              '<polygon points="50,4 88,70 12,70" fill="none" stroke="#1f5fae" stroke-width="7" data-nobacklight="1" stroke-linejoin="round"></polygon></svg>' +
          '</div>' +
          '<div data-cap-label style="display:none;position:absolute;border-radius:50%;align-items:center;justify-content:center;' +
            'flex-direction:column;text-align:center;line-height:1.1;font-size:13px;font-weight:700;letter-spacing:.5px;' +
            'color:#141a1e;text-shadow:0 1px 0 rgba(255,255,255,.35);' +
            'background:radial-gradient(circle at 36% 28%,#b9c1c6 0%,#98a1a7 52%,#78828a 100%);' +
            'box-shadow:inset 0 2px 3px rgba(255,255,255,.6), inset 0 -3px 6px rgba(0,0,0,.3);' +
            'pointer-events:none;user-select:none;z-index:4"></div>' +
          '<div data-mark style="position:absolute;left:50%;top:3px;width:4px;height:22px;margin-left:-2px;' +
            'border-radius:3px;background:rgba(40,48,52,.55)"></div>' +
        '</div>' +
        '<div data-ring style="display:none;position:absolute;border-radius:50%;background:transparent;' +
          'border:11px solid #12181c;box-sizing:border-box;' +
          'box-shadow:0 3px 7px rgba(0,0,0,.55), inset 0 1px 1px rgba(190,215,225,.14);pointer-events:none;z-index:2">' +
          '<div data-ring-stub style="position:absolute;left:50%;top:50%;width:0;height:0">' +
            '<div style="position:absolute;background:linear-gradient(180deg,#e6ebee 0%,#aab3b9 45%,#6f787e 100%);' +
            'clip-path:polygon(30% 0%,70% 0%,100% 45%,100% 100%,0% 100%,0% 45%);box-shadow:0 1px 2px rgba(0,0,0,.6)"></div>' +
          '</div>' +
        '</div>';

      var collar = this.querySelector('[data-collar]');
      var bezel = this.querySelector('[data-bezel]');
      var cap = this.querySelector('[data-capface]');
      var ring = this.querySelector('[data-ring]');
      this._collar = collar; this._cap = cap; this._ring = ring;
      this._bezelStub = this.querySelector('[data-bezel-stub]');
      this._ringStub = this.querySelector('[data-ring-stub]');
      this.angle = 0; this.ringIndex = 0; this.bezelIndex = 0;

      /* collar: dark ring, or bare amber leak */
      if (bare) {
        collar.style.background = 'transparent';
        collar.style.boxShadow = GLOW_COLLAR;
        cap.style.boxShadow = 'inset 0 2px 3px rgba(255,255,255,.7), inset 0 -3px 6px rgba(0,0,0,.35)';
      } else {
        collar.style.background = '#12181c';
        collar.style.boxShadow = GLOW_COLLAR + ', inset 0 3px 8px rgba(0,0,0,.85)';
        cap.style.boxShadow = 'inset 0 2px 3px rgba(255,255,255,.7), inset 0 -3px 6px rgba(0,0,0,.35)';
      }
      bezel.style.display = (bare && !hasBezel) ? 'none' : '';
      if (!knurl) bezel.style.background = 'radial-gradient(circle at 38% 26%,#9aa2a7 0%,#7c858b 48%,#525b61 100%)';
      if (flag(this, 'bezel-mark', false)) {
        bezel.insertAdjacentHTML('beforeend',
          '<i data-bezel-mark style="position:absolute;left:50%;top:' + (2 * k) + 'px;width:' + (5 * k) +
          'px;height:' + (12 * k) + 'px;margin-left:' + (-2.5 * k) + 'px;border-radius:2px;' +
          'background:linear-gradient(180deg,#f7f9fa,#cbd2d5);box-shadow:0 1px 2px rgba(0,0,0,.6)"></i>');
      }
      cap.style.background = petal
        ? 'radial-gradient(circle at 36% 26%,#8e979d 0%,#6d767c 45%,#464f55 100%)'
        : 'radial-gradient(circle at 36% 26%,#c3cace 0%,#98a1a7 45%,#616a70 100%)';

      /* boss variants */
      if (boss) {
        var bossEl = this.querySelector('[data-boss]');
        var mark = this.querySelector('[data-mark]');
        bossEl.style.display = '';
        mark.style.display = 'none';
        var petalWrap = this.querySelector('[data-petals]');
        petalWrap.style.display = petal ? '' : 'none';
        if (boss === 'petal-shallow') {
          petalWrap.querySelectorAll('i').forEach(function (el) {
            el.style.top = '-5%'; el.style.height = '16%'; el.style.width = '21%'; el.style.marginLeft = '-10.5%';
          });
        }
        if (petal) {
          bossEl.style.left = bossEl.style.top = bossEl.style.right = bossEl.style.bottom = '16%';
          bossEl.style.background = 'linear-gradient(160deg,#cbd3d8 0%,#b7c0c5 45%,#a3acb2 100%)';
          bossEl.style.boxShadow = 'none';
          var face = this.querySelector('[data-boss-face]');
          face.style.background = 'linear-gradient(160deg,#cbd3d8 0%,#b7c0c5 48%,#a6afb5 100%)';
          face.style.boxShadow = 'none';
          this.querySelector('[data-boss-ring]').style.display = 'none';
          this.querySelector('[data-tri]').style.display = boss === 'petal' ? '' : 'none';
        } else {
          this.querySelector('[data-boss-ring]').style.left = '12%';
          if (!knurl) {
            bossEl.style.background = 'radial-gradient(circle at 36% 26%,#c3cace 0%,#a2abb0 45%,#79828a 100%)';
          }
        }
      }

      /* engraved cap legend — rotates with the cap */
      var capLabel = this.getAttribute('cap-label');
      if (capLabel) {
        var cl = this.querySelector('[data-cap-label]');
        cl.style.display = 'flex';
        cl.style.inset = (hasRing ? (15 * k + 2) : 5) + 'px';
        cl.innerHTML = capLabel.split('|').join('<br>');
        this.querySelector('[data-mark]').style.display = 'none';
      }

      var self = this;
      var api = {
        setAngle: function (deg) { self.angle = deg; cap.style.transform = 'rotate(' + deg + 'deg)'; },
        turn: function (d) { api.setAngle(self.angle + d); },
        getAngle: function () { return self.angle; },
        onTurn: function (fn) { self._turnCb = fn; },
        // push = press and hold; pull = short tap
        onPush: function (fn) { self._pushCb = fn; },
        onPull: function (fn) { self._pullCb = fn; },
        push: function () { if (self._pushCb) self._pushCb(); },
        pull: function () { if (self._pullCb) self._pullCb(); },
        // free-spinning outer ring (concentric coarse/fine tuning)
        setBezelAngle: function (deg) { self.bezelAngle = deg; bezel.style.transform = 'rotate(' + deg + 'deg)'; },
        turnBezel: function (d) { api.setBezelAngle((self.bezelAngle || 0) + d); },
        getBezelAngle: function () { return self.bezelAngle || 0; },
        setBezel: function (i) { self._setBezel(i, false); },
        getBezel: function () { return self.bezelIndex; },
        toggleBezel: function () {
          self._setBezel(self.bezelIndex + 1 >= self._bezelAngles().length ? 0 : self.bezelIndex + 1, true);
        },
        onBezel: function (fn) { self._bezelCb = fn; },
        setRing: function (i) { self._setRing(i, false); },
        getRing: function () { return self.ringIndex; },
        toggleRing: function () { self._setRing(self.ringIndex ? 0 : 1, true); },
        onRing: function (fn) { self._ringCb = fn; },
        setGlow: function (on) {
          collar.style.boxShadow = on
            ? (bare ? GLOW_COLLAR : GLOW_COLLAR + ', inset 0 3px 8px rgba(0,0,0,.85)')
            : (bare ? 'none' : 'inset 0 3px 8px rgba(0,0,0,.85)');
        },
        root: this
      };
      this.knob = api;
      this.api = api;

      this.addEventListener('wheel', function (e) {
        e.preventDefault();
        var dir = e.deltaY > 0 ? -1 : 1;
        api.turn(dir * num(self, 'detent', 15));
        if (self._turnCb) self._turnCb(dir);
      }, { passive: false });

      var dragging = false, startY = 0, moved = 0, holdTimer = null, pushed = false;
      var HOLD_MS = num(this, 'hold-ms', 400);
      /* touch-first: one detent per DRAG_STEP px of vertical travel, up = increment */
      var DRAG_STEP = num(this, 'drag-step', 14);
      this.addEventListener('pointerdown', function (e) {
        if (self._ringHit && self._ringHit(e)) return;
        capture(self, e.pointerId);
        dragging = true; startY = e.clientY; moved = 0; pushed = false;
        // hold the knob to PUSH; a short tap is a PULL
        holdTimer = setTimeout(function () {
          holdTimer = null;
          if (moved >= DRAG_STEP) return;
          pushed = true;
          if (self._pushCb) self._pushCb();
        }, HOLD_MS);
      });
      this.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        var dy = startY - e.clientY;
        moved = Math.max(moved, Math.abs(dy));
        if (Math.abs(dy) < DRAG_STEP) return;
        var steps = Math.trunc(dy / DRAG_STEP);
        startY -= steps * DRAG_STEP;
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        var dir = steps > 0 ? 1 : -1;
        for (var i = 0; i < Math.abs(steps); i++) {
          api.turn(dir * num(self, 'detent', 15));
          if (self._turnCb) self._turnCb(dir);
        }
      });
      var endDrag = function (e) {
        if (!dragging) return;
        dragging = false;
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if (self.hasPointerCapture(e.pointerId)) self.releasePointerCapture(e.pointerId);
        if (moved < DRAG_STEP && !pushed && self._pullCb) self._pullCb();
      };
      this.addEventListener('pointerup', endDrag);
      this.addEventListener('pointercancel', endDrag);
      this.addEventListener('contextmenu', function (e) { e.preventDefault(); });

      if (hasBezel) {
        bezel.style.background = 'repeating-conic-gradient(from 0deg,#3a4247 0deg 2.2deg,#0b0f12 2.2deg 4.4deg)';
        cap.style.background = 'radial-gradient(circle at 36% 26%,#dfe4e7 0%,#b9c1c6 45%,#8b949a 100%)';
        this._bezelStub.style.display = '';
        bezel.style.cursor = 'pointer';
        bezel.addEventListener('pointerdown', function (e) {
          e.stopPropagation();
          var r = bezel.getBoundingClientRect();
          var ang = Math.atan2(e.clientX - (r.left + r.width / 2), (r.top + r.height / 2) - e.clientY) * 180 / Math.PI;
          var l = self._bezelAngles(), best = 0;
          l.forEach(function (v, i) { if (Math.abs(v - ang) < Math.abs(l[best] - ang)) best = i; });
          self._setBezel(best, true);
        });
        this._setBezel(num(this, 'bezel-index', 0), false);
      }

      if (hasRing) {
        ring.style.display = '';
        ring.style.inset = ((capInset + 4) * k) + 'px';
        ring.style.borderWidth = (11 * k) + 'px';
        this._ringHit = function (e) {
          var b = ring.getBoundingClientRect();
          var cx = b.left + b.width / 2, cy = b.top + b.height / 2;
          var d = Math.sqrt(Math.pow(e.clientX - cx, 2) + Math.pow(e.clientY - cy, 2));
          var bw = parseFloat(ring.style.borderWidth) || 11;
          if (d > b.width / 2 || d < b.width / 2 - bw - 2) return false;
          self._setRing(e.clientX < cx ? 0 : 1, true);
          return true;
        };
        this._setRing(num(this, 'ring-index', 0), false);
      }

      this.dispatchEvent(new CustomEvent('knob-ready', { detail: api, bubbles: true }));
    }

    _ringAngles() { return list(this, 'ring-angles', [-30, 30]); }

    _setRing(i, fire) {
      var l = this._ringAngles();
      var n = Math.max(0, Math.min(l.length - 1, i));
      var changed = n !== this.ringIndex;
      this.ringIndex = n;
      var ring = this._ring;
      var rw = ring.offsetWidth || (num(this, 'size', 128) - 26);
      var bw = parseFloat(ring.style.borderWidth) || 11;
      var r = rw / 2 - bw / 2;
      var arrow = this._ringStub.firstElementChild;
      if (arrow) {
        arrow.style.height = bw + 'px';
        arrow.style.top = (-bw / 2) + 'px';
        arrow.style.width = (bw * 1.7) + 'px';
        arrow.style.left = (-bw * 0.85) + 'px';
      }
      this._ringStub.style.transform = 'rotate(' + l[n] + 'deg) translateY(' + (-r) + 'px)';
      if (fire && changed && this._ringCb) this._ringCb(n, l[n]);
    }

    _bezelAngles() { return list(this, 'bezel-angles', [-45, 45]); }

    _setBezel(i, fire) {
      var l = this._bezelAngles();
      var n = Math.max(0, Math.min(l.length - 1, i));
      var changed = n !== this.bezelIndex;
      this.bezelIndex = n;
      var size = num(this, 'size', 128), k = size / 128;
      var inset = (flag(this, 'collar', true) ? 17 : 9) * k;
      var r = size / 2 - inset - 8 * k;
      this._bezelStub.style.transform = 'rotate(' + l[n] + 'deg) translateY(' + (-r) + 'px)';
      if (fire && changed && this._bezelCb) this._bezelCb(n, l[n]);
    }
  }

  /* ===================================================== selector knob */

  class FcuSelectorKnob extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      this.dataset.knob = this.getAttribute('knob-id') || '';
      var size = num(this, 'size', 112), k = size / 112;
      var bare = !flag(this, 'collar', true);
      this.index = 0;

      base(this, 'position:relative;display:block;width:' + size + 'px;height:' + size + 'px;' +
        'border-radius:50%;background:transparent;cursor:pointer;user-select:none;touch-action:none');
      this.style.outline = flag(this, 'ring', true) ? '2px solid ' + SILK : 'none';
      this.style.outlineOffset = '-1px';
      this.style.boxShadow = bare ? 'none' : '0 6px 14px rgba(0,0,0,.55)';

      var capInset = (bare ? 10 : 17) * k;
      this.innerHTML =
        '<div data-collar style="position:absolute;inset:' + (9 * k) + 'px;border-radius:50%"></div>' +
        '<div data-capface style="position:absolute;inset:' + capInset + 'px;border-radius:50%;' +
          'background:radial-gradient(circle at 38% 26%,#c6cdd1 0%,#a4acb1 40%,#7d868c 76%,#565f65 100%)">' +
          '<div data-pointer style="position:absolute;left:50%;top:50%;width:0;height:0">' +
            '<div data-pencil style="position:absolute;background:linear-gradient(100deg,#d8dee1 0%,#c1c8cc 38%,#9aa2a8 72%,#737c82 100%);' +
              'filter:drop-shadow(0 2px 2px rgba(0,0,0,.45))">' +
              '<div data-line style="position:absolute;left:50%;top:0;border-radius:1.5px;background:#fbfdfe;' +
              'box-shadow:0 0 3px rgba(255,255,255,.7)"></div>' +
            '</div>' +
          '</div>' +
        '</div>';

      var collar = this.querySelector('[data-collar]');
      var cap = this.querySelector('[data-capface]');
      this._collar = collar;
      this._pointer = this.querySelector('[data-pointer]');

      if (bare) {
        collar.style.background = 'transparent';
        collar.style.boxShadow = GLOW_COLLAR;
        cap.style.boxShadow = 'inset 0 2px 3px rgba(255,255,255,.75), inset 0 -4px 8px rgba(0,0,0,.35)';
      } else {
        collar.style.background = '#12181c';
        collar.style.boxShadow = GLOW_COLLAR + ', inset 0 3px 8px rgba(0,0,0,.85)';
        cap.style.boxShadow = 'inset 0 2px 3px rgba(255,255,255,.75), inset 0 -4px 8px rgba(0,0,0,.35), 0 3px 8px rgba(0,0,0,.5)';
      }

      /* pencil pointer derived from the cap's true radius */
      var cr = size / 2 - capInset;
      var pw = 0.42 * 2 * cr, ph = 2 * cr;
      var yS = (0.30 * ph).toFixed(2);
      var yA = (cr + Math.sqrt(cr * cr - (pw / 2) * (pw / 2))).toFixed(2);
      var pen = this.querySelector('[data-pencil]');
      pen.style.left = (-pw / 2) + 'px';
      pen.style.top = (-cr) + 'px';
      pen.style.width = pw + 'px';
      pen.style.height = ph + 'px';
      pen.style.clipPath = 'path("M' + (pw / 2).toFixed(2) + ',0 L' + pw.toFixed(2) + ',' + yS +
        ' L' + pw.toFixed(2) + ',' + yA + ' A' + cr.toFixed(2) + ',' + cr.toFixed(2) + ' 0 0 1 0,' + yA + ' L0,' + yS + ' Z")';
      var ln = this.querySelector('[data-line]');
      ln.style.width = (4 * k) + 'px';
      ln.style.marginLeft = (-2 * k) + 'px';
      ln.style.height = (ph * 0.8) + 'px';

      var self = this;
      var api = {
        setIndex: function (i) { self._setIndex(i, false); },
        getIndex: function () { return self.index; },
        next: function () { self._setIndex(self.index + 1, true); },
        prev: function () { self._setIndex(self.index - 1, true); },
        count: function () { return self._angles().length; },
        angle: function () { return self._angles()[self.index]; },
        onChange: function (fn) { self._cb = fn; },
        setGlow: function (on) {
          collar.style.boxShadow = on
            ? (bare ? GLOW_COLLAR : GLOW_COLLAR + ', inset 0 3px 8px rgba(0,0,0,.85)')
            : (bare ? 'none' : 'inset 0 3px 8px rgba(0,0,0,.85)');
        },
        root: this
      };
      this.knob = api;
      this.api = api;

      /* drag-invert="true": flips which way "up"/wheel-forward walks the
         index, for a knob face whose labels are laid out running the
         opposite rotational sense from the default (e.g. EFIS's ND
         mode/range, whose label positions match a real Airbus hardware
         photo and can't just be moved to match). Default false leaves
         every existing caller (the round <fcu-knob>'s own wheel handling,
         and any other <fcu-selector-knob> like the radio panel's band
         selector) unchanged, so "up = clockwise" stays true panel-to-panel
         even though the two knob faces sweep their labels in opposite
         directions. */
      var invert = flag(this, 'drag-invert', false);

      this.addEventListener('wheel', function (e) {
        e.preventDefault();
        var dir = e.deltaY > 0 ? 1 : -1;
        self._setIndex(self.index + (invert ? -dir : dir), true);
      }, { passive: false });

      /* touch-first: press and drag up/down, one detent per DRAG_STEP px.
         drag-mode="angle" keeps the old point-at-the-detent behaviour. */
      var SEL_STEP = num(this, 'drag-step', 40);
      var dragY = 0;
      var dragTo = function (e) {
        var dy = dragY - e.clientY;
        if (Math.abs(dy) < SEL_STEP) return;
        var steps = Math.trunc(dy / SEL_STEP);
        dragY -= steps * SEL_STEP;
        /* labels run clockwise from the top, so dragging UP walks back up
           the list -- drag-invert flips this, see its own comment above. */
        self._setIndex(self.index - steps * (invert ? -1 : 1), true);
      };
      var snapTo = function (e) {
        var r = self.getBoundingClientRect();
        var ang = Math.atan2(e.clientX - (r.left + r.width / 2), (r.top + r.height / 2) - e.clientY) * 180 / Math.PI;
        var l = self._angles(), best = 0;
        l.forEach(function (v, i) { if (Math.abs(v - ang) < Math.abs(l[best] - ang)) best = i; });
        self._setIndex(best, true);
      };
      this.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        capture(self, e.pointerId);
        self._dragging = true;
        if (self.getAttribute('drag-mode') === 'angle') snapTo(e);
        else dragY = e.clientY;
      });
      this.addEventListener('pointermove', function (e) {
        if (!self._dragging) return;
        if (self.getAttribute('drag-mode') === 'angle') snapTo(e);
        else dragTo(e);
      });
      var end = function (e) {
        self._dragging = false;
        if (self.hasPointerCapture(e.pointerId)) self.releasePointerCapture(e.pointerId);
      };
      this.addEventListener('pointerup', end);
      this.addEventListener('pointercancel', end);

      this._setIndex(num(this, 'index', 0), false);
      this.dispatchEvent(new CustomEvent('knob-ready', { detail: api, bubbles: true }));
    }

    _angles() {
      var a = list(this, 'angles', null);
      if (a) return a;
      var n = num(this, 'detents', 5), step = num(this, 'step', 45);
      var start = this.hasAttribute('start-angle') ? num(this, 'start-angle', 0) : -((n - 1) * step) / 2;
      var out = [];
      for (var i = 0; i < n; i++) out.push(start + i * step);
      return out;
    }

    _setIndex(i, fire) {
      var l = this._angles();
      var n = Math.max(0, Math.min(l.length - 1, i));
      var changed = n !== this.index;
      this.index = n;
      this._pointer.style.transform = 'rotate(' + l[n] + 'deg)';
      if (fire && changed && this._cb) this._cb(n, l[n]);
    }
  }

  /* ====================================================== round button */

  class FcuRoundButton extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      this.dataset.btn = this.getAttribute('btn-id') || '';
      var size = num(this, 'size', 58);
      var up = '0 3px 6px rgba(0,0,0,.45), inset 0 1px 1px rgba(205,230,240,.22), inset 0 -2px 4px rgba(0,0,0,.45)';
      var down = '0 1px 3px rgba(0,0,0,.6), inset 0 3px 7px rgba(0,0,0,.85), inset 0 -1px 1px rgba(200,225,235,.12)';

      base(this, 'position:relative;display:block;width:' + size + 'px;height:' + size + 'px;border-radius:50%;' +
        'background:radial-gradient(circle at 38% 26%,#3f484e 0%,#242c31 46%,#10161a 100%);box-shadow:' + up + ';' +
        'cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation');
      this.style.outline = flag(this, 'ring', true) ? '2px solid ' + SILK : 'none';
      this.style.outlineOffset = '4px';

      this.innerHTML = '<div style="position:absolute;inset:' + (5 * size / 58) + 'px;border-radius:50%;' +
        'background:radial-gradient(circle at 50% 64%,#252d32 0%,#141a1e 50%,#080c0f 100%);' +
        'box-shadow:inset 0 2px 5px rgba(0,0,0,.6), inset 0 -1px 1px rgba(190,215,225,.1);pointer-events:none"></div>';

      var self = this;
      var api = {
        press: function () { self.style.boxShadow = down; },
        release: function () { self.style.boxShadow = up; },
        onPress: function (fn) { self._cb = fn; },
        setBacklight: function (on) {
          if (!flag(self, 'ring', true)) return;
          self.style.outline = '2px solid ' + (on ? SILK_AMBER : SILK);
          self.style.filter = on ? 'drop-shadow(0 0 5px rgba(255,140,30,.45))' : 'none';
        },
        root: this
      };
      this.button = api;
      this.api = api;
      this.addEventListener('pointerdown', function () { api.press(); });
      this.addEventListener('pointerup', function () { api.release(); if (self._cb) self._cb(); });
      this.addEventListener('pointerleave', function () { api.release(); });
      this.dispatchEvent(new CustomEvent('button-ready', { detail: api, bubbles: true }));
    }
  }

  /* ======================================================== LED button */

  function dim(hex, a) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return 'rgba(62,240,122,' + (a || 0.14) + ')';
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + (a || 0.14) + ')';
  }

  class FcuLedButton extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      var id = this.getAttribute('btn-id') || '';
      this.dataset.btn = id;
      var w = num(this, 'width', 92), h = num(this, 'height', 46);
      var up = '0 4px 9px rgba(0,0,0,.6), inset 0 1px 1px rgba(190,215,225,.25), inset 0 -2px 4px rgba(0,0,0,.7)';
      var down = '0 1px 3px rgba(0,0,0,.6), inset 0 3px 7px rgba(0,0,0,.85)';
      this.ledColor = this.getAttribute('led-color') || '#3ef07a';

      base(this, 'position:relative;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;' +
        'width:' + w + 'px;height:' + h + 'px;border-radius:4px;padding:' + (h >= 56 ? 9 : 6) + 'px 0 0;' +
        'gap:' + (h >= 56 ? 7 : 5) + 'px;' +
        'background:linear-gradient(180deg,#2b3338 0%,#12181b 55%,#080c0e 100%);box-shadow:' + up + ';' +
        'cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation');

      /* led="none": legend-only Airbus pushbutton (RMP / ACP style). The LED slot
         stays in the layout but invisible, so the legend sits at the same height
         as on a button that has one. */
      var noLed = this.getAttribute('led') === 'none';
      var bar = '<i style="display:block;width:100%;height:3px;border-radius:1px;background:' + dim(this.ledColor) + '"></i>';
      this.innerHTML =
        '<span ' + (noLed ? '' : 'data-led="' + id + '" ') +
          'style="pointer-events:none;width:' + Math.round(w * 52 / 92) + 'px;height:11px;' +
          (noLed ? 'visibility:hidden;' : '') +
          'display:flex;flex-direction:column;justify-content:space-between">' + bar + bar + bar + '</span>' +
        '<span data-label style="pointer-events:none;font-size:14px;font-weight:700;letter-spacing:1px;' +
          'white-space:nowrap;user-select:none"></span>';

      this._led = this.querySelector('[data-led]');
      this._labelEl = this.querySelector('[data-label]');
      this._labelEl.textContent = this.getAttribute('label') || '';

      var self = this;
      var api = {
        setLed: function (on) { self._paint(!!on); },
        toggle: function () { self._paint(!self.lit); return self.lit; },
        isLit: function () { return !!self.lit; },
        onPress: function (fn) { self._cb = fn; },
        setBacklight: function (on) { self._backlight(!!on); },
        root: this
      };
      this.button = api;
      this.api = api;

      this._backlight(flag(this, 'backlit', true));
      this._paint(flag(this, 'lit', true));

      this.addEventListener('pointerdown', function () { self.style.boxShadow = down; });
      this.addEventListener('pointerup', function () {
        self.style.boxShadow = up;
        if (self._cb) self._cb(api); else api.toggle();
      });
      this.addEventListener('pointerleave', function () { self.style.boxShadow = up; });
      this.dispatchEvent(new CustomEvent('button-ready', { detail: api, bubbles: true }));
    }

    _backlight(on) {
      this.backlit = on;
      var el = this._labelEl;
      el.style.color = on ? (this.getAttribute('backlight-color') || AMBER) : (this.getAttribute('label-color') || '#e6eef1');
      el.style.textShadow = on ? GLOW_TEXT : '0 1px 1px rgba(0,0,0,.8)';
    }

    _paint(on) {
      this.lit = on;
      if (!this._led) return;
      var c = this.ledColor;
      this._led.querySelectorAll('i').forEach(function (b) {
        b.style.background = on ? c : dim(c);
        b.style.boxShadow = on ? '0 0 6px ' + dim(c, 0.8) : 'inset 0 1px 1px rgba(0,0,0,.6)';
      });
    }
  }

  /* ============================================================= lever */

  var LEVER_POS = { left: -1, center: 0, right: 1 };

  class FcuLever extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      this.dataset.lever = this.getAttribute('lever-id') || '';
      var size = num(this, 'size', 52), k = size / 52;
      this.throwPx = Math.round(15 * k);

      base(this, 'position:relative;display:block;width:' + size + 'px;height:' + size + 'px;border-radius:50%;' +
        'background:radial-gradient(circle at 50% 42%,#0c1114 0%,#151d21 55%,#232c31 100%);' +
        'box-shadow:inset 0 3px 7px rgba(0,0,0,.9), inset 0 -2px 2px rgba(190,215,225,.14), 0 3px 7px rgba(0,0,0,.5);' +
        'cursor:pointer;user-select:none;touch-action:none');
      this.style.outline = flag(this, 'ring', true) ? '2px solid ' + SILK : 'none';
      this.style.outlineOffset = '4px';

      var d = Math.round(24 * k), hh = Math.round(9 * k);
      this.innerHTML =
        '<div data-shaft style="position:absolute;left:50%;top:50%;width:0;height:' + hh + 'px;margin-top:' + (-hh / 2) + 'px;' +
          'border-radius:' + (hh / 2) + 'px;background:linear-gradient(180deg,#e6ebee 0%,#aab3b9 45%,#69737a 100%);' +
          'box-shadow:0 2px 3px rgba(0,0,0,.6);pointer-events:none"></div>' +
        '<div data-ball style="position:absolute;left:50%;top:50%;width:' + d + 'px;height:' + d + 'px;' +
          'margin:' + (-d / 2) + 'px 0 0 ' + (-d / 2) + 'px;border-radius:50%;' +
          'background:radial-gradient(circle at 34% 28%,#f2f5f7 0%,#cdd4d8 32%,#98a2a8 66%,#5d666c 100%);' +
          'box-shadow:0 3px 6px rgba(0,0,0,.65), inset 0 -2px 4px rgba(0,0,0,.3);' +
          'pointer-events:none;transition:transform .12s ease"></div>';

      this._ball = this.querySelector('[data-ball]');
      this._shaft = this.querySelector('[data-shaft]');

      var self = this;
      var api = {
        set: function (pos) { self._set(pos); },
        get: function () { return self.pos; },
        onChange: function (fn) { self._cb = fn; },
        setBacklight: function (on) {
          if (!flag(self, 'ring', true)) return;
          self.style.outline = '2px solid ' + (on ? SILK_AMBER : SILK);
          self.style.filter = on ? 'drop-shadow(0 0 5px rgba(255,140,30,.45))' : 'none';
        },
        root: this
      };
      this.lever = api;
      this.api = api;

      var pick = function (e) {
        var r = self.getBoundingClientRect();
        // vertical levers read the Y axis: up = 'right' (ON), down = 'left' (OFF)
        var t = flag(self, 'vertical', false)
          ? 1 - (e.clientY - r.top) / r.height
          : (e.clientX - r.left) / r.width;
        var pos = t < 0.38 ? 'left' : t > 0.62 ? 'right' : 'center';
        if (pos === self.pos) return;
        self._set(pos);
        if (self._cb) self._cb(self.pos);
      };
      this.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        capture(self, e.pointerId);
        self._dragging = true;
        pick(e);
      });
      this.addEventListener('pointermove', function (e) { if (self._dragging) pick(e); });
      var end = function (e) {
        self._dragging = false;
        if (self.hasPointerCapture(e.pointerId)) self.releasePointerCapture(e.pointerId);
      };
      this.addEventListener('pointerup', end);
      this.addEventListener('pointercancel', end);

      this._set(this.getAttribute('position') || 'center');
      this.dispatchEvent(new CustomEvent('lever-ready', { detail: api, bubbles: true }));
    }

    _set(pos) {
      this.pos = LEVER_POS[pos] === undefined ? 'center' : pos;
      var dir = LEVER_POS[this.pos], t = this.throwPx * dir;
      var hh = Math.round(9 * (num(this, 'size', 52) / 52));
      if (flag(this, 'vertical', false)) {
        this._ball.style.transform = 'translateY(' + (-t) + 'px)';
        this._shaft.style.left = '50%';
        this._shaft.style.right = 'auto';
        this._shaft.style.width = hh + 'px';
        this._shaft.style.marginLeft = (-hh / 2) + 'px';
        this._shaft.style.top = '50%';
        this._shaft.style.height = Math.abs(t) + 'px';
        this._shaft.style.marginTop = dir > 0 ? (-Math.abs(t)) + 'px' : '0px';
      } else {
        this._ball.style.transform = 'translateX(' + t + 'px)';
        this._shaft.style.width = Math.abs(t) + 'px';
        this._shaft.style.left = dir < 0 ? 'auto' : '50%';
        this._shaft.style.right = dir < 0 ? '50%' : 'auto';
      }
    }
  }

  /* ====================================================== panel mixin */

  function applyBacklight(root, on) {
    root.querySelectorAll('[data-cap]').forEach(function (el) {
      if (el.hasAttribute('data-cap-keep')) return;
      el.style.color = on ? AMBER : SILK_WHITE;
      el.style.textShadow = on ? GLOW_TEXT : '0 1px 1px rgba(0,0,0,.7)';
    });
    root.querySelectorAll('svg [stroke], svg [fill]').forEach(function (el) {
      if (el.hasAttribute('data-nobacklight')) return;
      if (el.getAttribute('stroke') && el.getAttribute('stroke') !== 'none')
        el.setAttribute('stroke', on ? SILK_AMBER : SILK);
      if (el.getAttribute('fill') && el.getAttribute('fill') !== 'none')
        el.setAttribute('fill', on ? SILK_AMBER : SILK);
    });
    root.querySelectorAll('svg').forEach(function (sv) {
      if (sv.querySelector('[data-nobacklight]')) return;
      sv.style.filter = on ? 'drop-shadow(0 0 5px rgba(255,140,30,.45))' : 'none';
    });
    root.querySelectorAll('[data-btn]').forEach(function (el) {
      if (el.button && el.button.setBacklight) el.button.setBacklight(on);
    });
    root.querySelectorAll('[data-knob]').forEach(function (el) {
      if (el.knob && el.knob.setGlow) el.knob.setGlow(on);
    });
    root.querySelectorAll('[data-lever]').forEach(function (el) {
      if (el.lever && el.lever.setBacklight) el.lever.setBacklight(on);
    });
  }

  function panelApi(root) {
    var find = function (s) { return root.querySelector(s); };
    var api = {
      knob: function (id) { var el = find('[data-knob="' + id + '"]'); return el && el.knob; },
      button: function (id) { var el = find('[data-btn="' + id + '"]'); return el && el.button; },
      lever: function (id) { var el = find('[data-lever="' + id + '"]'); return el && el.lever; },
      setLed: function (id, on) { var b = api.button(id); if (b && b.setLed) b.setLed(on); },
      setLeds: function (obj) { Object.keys(obj || {}).forEach(function (k) { api.setLed(k, obj[k]); }); },
      setBacklight: function (on) { applyBacklight(root, !!on); },
      root: root
    };
    return api;
  }

  /* label helper for silkscreen text */
  function cap(x, y, text, opts) {
    opts = opts || {};
    var t = opts.transform || 'translate(-50%,-50%)';
    return '<div data-cap="1" style="position:absolute;left:' + x + 'px;top:' + y + 'px;transform:' + t + ';' +
      'font-size:' + (opts.size || 13) + 'px;font-weight:700;letter-spacing:.5px;line-height:' + (opts.lh || 1.15) + ';' +
      'text-align:' + (opts.align || 'center') + ';white-space:nowrap;user-select:none;' +
      'color:' + SILK_WHITE + ';text-shadow:0 1px 1px rgba(0,0,0,.7)">' + text + '</div>';
  }

  function svgWrap(x, y, body) {
    return '<svg width="200" height="200" viewBox="0 0 200 200" style="position:absolute;left:' + x + 'px;top:' + y +
      'px;pointer-events:none;overflow:visible">' + body + '</svg>';
  }

  var RING61 = '<circle cx="100" cy="100" r="61" fill="none" stroke="' + SILK + '" stroke-width="3"></circle>';

  /* =========================================================== FCU panel */

  /* silkscreen spacer bar — same stroke as the arcs, so setBacklight picks it up */
  function divider(x, y, h) {
    return '<svg width="6" height="' + h + '" viewBox="0 0 6 ' + h + '" style="position:absolute;left:' + (x - 2) +
      'px;top:' + y + 'px;pointer-events:none;overflow:visible">' +
      '<line x1="3" y1="0" x2="3" y2="' + h + '" stroke="' + SILK + '" stroke-width="3" stroke-linecap="round"></line></svg>';
  }

  class FcuPanel extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      var scale = num(this, 'scale', 1);
      base(this, 'display:inline-block;font-family:Helvetica,Arial,sans-serif');

      this.innerHTML =
        '<div data-box style="width:' + (1266 * scale) + 'px;height:' + (442 * scale) + 'px">' +
        '<div data-panel style="position:relative;box-sizing:border-box;width:1266px;height:442px;transform-origin:top left;' +
          (scale === 1 ? '' : 'transform:scale(' + scale + ')') + '">' +
          '<panel-chassis></panel-chassis>' +

          '<div style="position:absolute;left:50%;top:26px;transform:translateX(-50%)"><fcu-display></fcu-display></div>' +

          divider(494, 176, 248) +
          divider(750, 176, 248) +

          '<fcu-round-button btn-id="spd-mach" style="position:absolute;left:27px;top:167px"></fcu-round-button>' +
          cap(56, 236, 'SPD<br>MACH', { transform: 'translateX(-50%)' }) +

          '<fcu-round-button btn-id="hdg-vs" style="position:absolute;left:604px;top:167px"></fcu-round-button>' +
          cap(583, 196, 'HDG<br>TRK', { transform: 'translate(-100%,-50%)', align: 'right' }) +
          cap(683, 196, 'V/S<br>FPA', { transform: 'translateY(-50%)', align: 'left' }) +

          '<fcu-round-button btn-id="metric-alt" style="position:absolute;left:970px;top:167px"></fcu-round-button>' +
          cap(999, 236, 'METRIC<br>ALT', { transform: 'translateX(-50%)' }) +

          '<fcu-led-button btn-id="ap1" label="AP1" width="92" height="64" style="position:absolute;left:533px;top:275px"></fcu-led-button>' +
          '<fcu-led-button btn-id="ap2" label="AP2" width="92" height="64" style="position:absolute;left:641px;top:275px"></fcu-led-button>' +
          '<fcu-led-button btn-id="athr" label="A/THR" width="104" height="64" style="position:absolute;left:581px;top:356px"></fcu-led-button>' +

          '<fcu-led-button btn-id="loc" label="LOC" style="position:absolute;left:338px;top:373px"></fcu-led-button>' +
          '<fcu-led-button btn-id="alt" label="ALT" style="position:absolute;left:836px;top:373px"></fcu-led-button>' +
          '<fcu-led-button btn-id="appr" label="APPR" style="position:absolute;left:1070px;top:373px"></fcu-led-button>' +

          svgWrap(50, 180, RING61) +
          '<fcu-knob knob-id="spd" boss="true" collar="false" ring="false" style="position:absolute;left:86px;top:216px"></fcu-knob>' +

          svgWrap(284, 180, RING61) +
          '<fcu-knob knob-id="hdg" boss="petal" collar="false" ring="false" style="position:absolute;left:320px;top:216px"></fcu-knob>' +

          svgWrap(782, 180, RING61 +
            '<g stroke="' + SILK + '" stroke-width="3" stroke-linecap="round">' +
            '<line x1="69.5" y1="47.16" x2="66.5" y2="41.96"></line>' +
            '<line x1="130.5" y1="47.16" x2="133.5" y2="41.96"></line></g>') +
          cap(840, 214, '100') + cap(927, 214, '1000') +
          '<fcu-knob knob-id="alt" boss="petal-shallow" selector-ring="true" collar="false" ring="false" ' +
            'style="position:absolute;left:818px;top:216px"></fcu-knob>' +

          svgWrap(1016, 180, RING61 +
            '<g fill="none" stroke="' + SILK + '" stroke-width="3" stroke-linecap="round">' +
            '<path d="M27.28,93.64 A73,73 0 0 1 75.03,31.40"></path>' +
            '<path d="M27.28,106.36 A73,73 0 0 0 75.03,168.60"></path></g>' +
            '<g fill="' + SILK + '">' +
            '<polygon points="0,-5 12,0 0,5" transform="translate(75.03,31.40) rotate(-20)"></polygon>' +
            '<polygon points="0,-5 12,0 0,5" transform="translate(75.03,168.60) rotate(20)"></polygon></g>') +
          '<fcu-knob knob-id="vs" boss="true" collar="false" ring="false" style="position:absolute;left:1052px;top:216px"></fcu-knob>' +
          cap(1116, 207, 'UP') + cap(1116, 353, 'DN') +
          cap(1191, 280, 'PUSH<br>TO<br>LEVEL<br>OFF', { transform: 'translateY(-50%)', size: 12, lh: 1.25 }) +
        '</div></div>';

      var self = this;
      var api = panelApi(this);
      api.display = function () { var d = self.querySelector('fcu-display'); return d && d.fcu; };
      api.setQnh = null;
      api.knobs = ['spd', 'hdg', 'alt', 'vs'];
      api.buttons = ['spd-mach', 'hdg-vs', 'metric-alt', 'ap1', 'ap2', 'athr', 'loc', 'alt', 'appr'];
      this.panel = api;
      this.api = api;
      if (typeof window !== 'undefined') {
        window.fcuPanel = api;
        var d = this.querySelector('fcu-display');
        if (d && d.fcu) window.fcu = d.fcu;
      }
      applyBacklight(this, flag(this, 'backlight', true));
      this.dispatchEvent(new CustomEvent('fcu-panel-ready', { detail: api, bubbles: true }));
    }
  }

  /* ========================================================== EFIS panel */

  class EfisPanel extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      base(this, 'display:inline-block;font-family:Helvetica,Arial,sans-serif');

      var modeSvg =
        '<path d="M51,100 A49,49 0 0 1 149,100" fill="none" stroke="' + SILK + '" stroke-width="3"></path>' +
        '<path d="M12,100 A88,88 0 0 1 27.66,52.25" fill="none" stroke="' + SILK + '" stroke-width="3"></path>' +
        '<path d="M42.71,35.79 A88,88 0 0 1 100,12" fill="none" stroke="' + SILK + '" stroke-width="3"></path>' +
        '<g stroke="' + SILK + '" stroke-width="3" stroke-linecap="round">' +
          '<line x1="12" y1="100" x2="18" y2="100"></line>' +
          '<line x1="100" y1="12" x2="100" y2="18"></line></g>' +
        '<g stroke="' + SILK + '" stroke-width="3" stroke-linecap="round">' +
          '<line x1="51" y1="100" x2="45" y2="100"></line>' +
          '<line x1="65.35" y1="65.35" x2="61.11" y2="61.11"></line>' +
          '<line x1="100" y1="51" x2="100" y2="45"></line>' +
          '<line x1="134.65" y1="65.35" x2="138.89" y2="61.11"></line>' +
          '<line x1="149" y1="100" x2="155" y2="100"></line></g>';

      var rangeSvg =
        '<path d="M51,100 A49,49 0 1 1 134.65,134.65" fill="none" stroke="' + SILK + '" stroke-width="3"></path>' +
        '<g stroke="' + SILK + '" stroke-width="3" stroke-linecap="round">' +
          '<line x1="51" y1="100" x2="45" y2="100"></line>' +
          '<line x1="65.35" y1="65.35" x2="61.11" y2="61.11"></line>' +
          '<line x1="100" y1="51" x2="100" y2="45"></line>' +
          '<line x1="134.65" y1="65.35" x2="138.89" y2="61.11"></line>' +
          '<line x1="149" y1="100" x2="155" y2="100"></line>' +
          '<line x1="134.65" y1="134.65" x2="138.89" y2="138.89"></line></g>';

      var baroSvg =
        '<path d="M63.23,63.23 A52,52 0 0 1 136.77,63.23" fill="none" stroke="' + SILK + '" stroke-width="3"></path>' +
        '<g stroke="' + SILK + '" stroke-width="3" stroke-linecap="round">' +
          '<line x1="63.23" y1="63.23" x2="57.57" y2="57.57"></line>' +
          '<line x1="136.77" y1="63.23" x2="142.43" y2="57.57"></line></g>';

      var topBtn = function (id, label, x) {
        return '<fcu-led-button btn-id="' + id + '" label="' + label + '" width="76" height="38" ' +
          'style="position:absolute;left:' + x + 'px;top:26px"></fcu-led-button>';
      };

      this.innerHTML =
        '<div style="position:relative;box-sizing:border-box;width:720px;height:370px">' +
          '<panel-chassis></panel-chassis>' +

          '<seven-seg seg-id="qnh" digits="4" value="1013" label="QNH" label-align="right" scale="0.62" ' +
            'pad-y="8" gap="3" radius="12" style="position:absolute;left:56px;top:66px"></seven-seg>' +

          topBtn('cstr', 'CSTR', 270) + topBtn('wpt', 'WPT', 356) + topBtn('vord', 'VOR.D', 442) +
          topBtn('ndb', 'NDB', 528) + topBtn('arpt', 'ARPT', 614) +

          svgWrap(28, 117, baroSvg) +
          cap(68, 168, 'in Hg', { size: 12 }) + cap(186, 168, 'hPa', { size: 12 }) +
          '<fcu-knob knob-id="baro" size="112" collar="false" ring="false" selector-ring="true" ' +
            'ring-index="1" ring-angles="-45,45" cap-label="PULL|STD" style="position:absolute;left:72px;top:161px"></fcu-knob>' +

          '<fcu-led-button btn-id="fd" label="FD" width="60" height="40" style="position:absolute;left:64px;top:283px"></fcu-led-button>' +
          '<fcu-led-button btn-id="ls" label="LS" width="60" height="40" style="position:absolute;left:132px;top:283px"></fcu-led-button>' +

          '<svg width="6" height="185" viewBox="0 0 6 185" style="position:absolute;left:232px;top:161px;pointer-events:none;overflow:visible">' +
            '<line x1="3" y1="0" x2="3" y2="185" stroke="' + SILK + '" stroke-width="3" stroke-linecap="round"></line></svg>' +

          svgWrap(260, 81, modeSvg) +
          cap(285, 124, 'ROSE') +
          '<fcu-selector-knob knob-id="nd-mode" size="112" collar="false" ring="false" angles="-90,-45,0,45,90" index="2" ' +
            'drag-invert="true" style="position:absolute;left:304px;top:125px"></fcu-selector-knob>' +
          cap(293, 181, 'LS') + cap(303, 140, 'VOR') + cap(360, 116, 'NAV') +
          cap(417, 140, 'ARC') + cap(439, 181, 'PLAN') +

          svgWrap(490, 81, rangeSvg) +
          '<fcu-selector-knob knob-id="nd-range" size="112" collar="false" ring="false" angles="-90,-45,0,45,90,135" index="2" ' +
            'drag-invert="true" style="position:absolute;left:534px;top:125px"></fcu-selector-knob>' +
          cap(525, 181, '10') + cap(538, 130, '20') + cap(590, 116, '40') +
          cap(642, 130, '80') + cap(659, 181, '160') + cap(642, 232, '320') +

          cap(360, 254, '1', { size: 12 }) +
          '<fcu-lever lever-id="bearing1" size="48" style="position:absolute;left:336px;top:272px"></fcu-lever>' +
          cap(322, 296, 'ADF', { transform: 'translate(-100%,-50%)', size: 12 }) +
          cap(398, 296, 'VOR', { transform: 'translateY(-50%)', size: 12 }) +
          cap(360, 330, 'OFF', { transform: 'translateX(-50%)', size: 12 }) +

          cap(590, 254, '2', { size: 12 }) +
          '<fcu-lever lever-id="bearing2" size="48" style="position:absolute;left:566px;top:272px"></fcu-lever>' +
          cap(552, 296, 'ADF', { transform: 'translate(-100%,-50%)', size: 12 }) +
          cap(628, 296, 'VOR', { transform: 'translateY(-50%)', size: 12 }) +
          cap(590, 330, 'OFF', { transform: 'translateX(-50%)', size: 12 }) +
        '</div>';

      var self = this;
      var api = panelApi(this);
      api.qnh = function () { var d = self.querySelector('seven-seg'); return d && d.segdisplay; };
      api.setQnh = function (v) { var d = api.qnh(); if (d) d.set(v); };
      api.knobs = ['baro', 'nd-mode', 'nd-range'];
      api.buttons = ['cstr', 'wpt', 'vord', 'ndb', 'arpt', 'fd', 'ls'];
      api.levers = ['bearing1', 'bearing2'];
      this.panel = api;
      this.api = api;
      if (typeof window !== 'undefined') window.efis = api;
      applyBacklight(this, flag(this, 'backlight', true));
      this.dispatchEvent(new CustomEvent('efis-ready', { detail: api, bubbles: true }));
    }
  }

  /* ---------------------------------------------------------- registry */

  var defs = [
    ['panel-chassis', PanelChassis],
    ['seven-seg', SevenSeg],
    ['fcu-display', FcuDisplay],
    ['fcu-knob', FcuKnob],
    ['fcu-selector-knob', FcuSelectorKnob],
    ['fcu-round-button', FcuRoundButton],
    ['fcu-led-button', FcuLedButton],
    ['fcu-lever', FcuLever],
    ['fcu-panel', FcuPanel],
    ['efis-panel', EfisPanel]
  ];
  defs.forEach(function (d) {
    if (!customElements.get(d[0])) customElements.define(d[0], d[1]);
  });
})();
