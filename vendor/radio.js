/* ============================================================================
   radio.js — generic COM/NAV radio stack panel (vanilla custom element)

   Requires fcu-instruments.js to be loaded first (panel-chassis, seven-seg,
   fcu-knob, fcu-selector-knob, fcu-lever).

     <script src="fcu-instruments.js"></script>
     <script src="radio.js"></script>
     <radio-panel></radio-panel>

   No dependencies, no build step, no network.
   ========================================================================== */
(function () {
  'use strict';

  var SILK = '#cfd5d8';
  var SILK_DIM = 'rgba(207,213,216,.4)';
  var LIT = '#eef2f4';
  var UNLIT = 'rgba(207,213,216,.3)';
  var W = 1112, H = 500;
  var ROW = { 1: 108, 2: 266 };

  /* selector positions, in knob order (0 = straight up, negative = ccw) */
  /* 45deg spacing puts ADF at straight west on both knobs */
  var ANGLES = [0, -45, -90, -135];

  /* fine=5 matches X-Plane's real 8.33kHz-spacing standby-tune commands
     (sim/radios/stby_com{1,2}_fine_up/down_833) -- confirmed live against
     X-Plane 12.4.3 2026-08-11: isolated single presses stepped the
     standby dataref by exactly 5 every time (e.g. 123305 -> 123310),
     never 25. The previous 25 was the "everywhere but this sim" 25kHz
     default step; this sim exposes true 8.33kHz-precision tuning.
     max=136990, not 136975 -- walking the real fine_up_833 command
     through the 136 decade live (2026-08-12) showed it reaches
     136980/136985/136990 exactly like every other decade; 975 was
     simply wrong (probably copied from the real-world ICAO ceiling for
     the *old* 25kHz-spacing COM band, which doesn't apply once this
     sim's true 8.33kHz-precision datarefs are in play). */
  var COM = { dp: 3, min: 118000, max: 136990, fine: 5, coarse: 1000, zero: true };
  var NAV = { dp: 3, min: 108000, max: 117950, fine: 50, coarse: 1000, zero: true };
  var ADF = { dp: -1, min: 190, max: 1750, fine: 1, coarse: 100, zero: false };

  function band(k, label, spec) {
    return { k: k, label: label, dp: spec.dp, min: spec.min, max: spec.max,
             fine: spec.fine, coarse: spec.coarse, zero: spec.zero };
  }

  /* unit 2 carries one extra notch (DME) at the same angular spacing */
  var BANDS = {
    1: [band('COM1', 'COM 1', COM), band('NAV1', 'NAV 1', NAV), band('ADF1', 'ADF 1', ADF)],
    2: [band('COM2', 'COM 2', COM), band('NAV2', 'NAV 2', NAV), band('ADF2', 'ADF 2', ADF),
        band('DME', 'DME', NAV)]
  };

  var SEED = {
    1: { COM1: [118000, 121500], NAV1: [110500, 113900], ADF1: [350, 525] },
    2: { COM2: [119100, 135275], NAV2: [109300, 112400], ADF2: [410, 690],
         DME: [115200, 110900] }
  };

  var AUDIO = [
    { id: 'aud-com1', label: 'COM 1', x: 136, on: true },
    { id: 'aud-com2', label: 'COM 2', x: 286 },
    { id: 'aud-nav1', label: 'NAV 1', x: 436 },
    { id: 'aud-nav2', label: 'NAV 2', x: 586 },
    { id: 'aud-adf1', label: 'ADF 1', x: 736 },
    { id: 'aud-adf2', label: 'ADF 2', x: 886 },
    { id: 'aud-dme', label: 'DME', x: 1036 }
  ];

  function cap(x, y, text, opts) {
    opts = opts || {};
    var t = opts.transform || 'translate(-50%,-50%)';
    return '<div data-cap="1" style="position:absolute;left:' + x + 'px;top:' + y + 'px;transform:' + t + ';' +
      'font-size:' + (opts.size || 11) + 'px;font-weight:700;letter-spacing:' + (opts.ls || '.6') + 'px;' +
      'white-space:nowrap;user-select:none;color:' + SILK + ';' +
      'text-shadow:0 1px 1px rgba(0,0,0,.85)">' + text + '</div>';
  }

  function rule(x, y, w) {
    return '<div style="position:absolute;left:' + x + 'px;top:' + y + 'px;width:' + w +
      'px;height:1px;background:' + SILK_DIM + '"></div>';
  }

  /* selector cluster: 85px knob (33% up from 64 for touch), centred at SEL_CX */
  var SEL_SIZE = 85, SEL_CX = 158, SEL_LABEL_R = 70;

  function unitAngles(u) { return ANGLES.slice(0, BANDS[u].length); }

  /* detent ticks around a selector knob */
  function ticks(u, cx, cy) {
    var out = '<div style="position:absolute;left:' + cx + 'px;top:' + cy + 'px;width:0;height:0;pointer-events:none">';
    unitAngles(u).forEach(function (a) {
      out += '<i style="position:absolute;left:-1px;top:-5.5px;width:2px;height:11px;border-radius:1px;' +
        'background:rgba(207,213,216,.75);transform:rotate(' + a + 'deg) translateY(-54px)"></i>';
    });
    return out + '</div>';
  }

  /* band names ringed around the knob, one per detent */
  function selLabels(u, cx, cy) {
    var out = '';
    unitAngles(u).forEach(function (a, i) {
      var rad = a * Math.PI / 180;
      var x = Math.round(cx + SEL_LABEL_R * Math.sin(rad));
      var y = Math.round(cy - SEL_LABEL_R * Math.cos(rad));
      out += a === 0
        ? cap(cx, cy - SEL_LABEL_R, BANDS[u][i].label)
        : cap(x, y, BANDS[u][i].label, { transform: 'translate(-100%,-50%)' });
    });
    return out;
  }

  var SWAP_UP = '0 4px 9px rgba(0,0,0,.6), inset 0 1px 1px rgba(255,255,255,.9), inset 0 -3px 6px rgba(0,0,0,.28)';
  var SWAP_DOWN = '0 1px 3px rgba(0,0,0,.6), inset 0 1px 1px rgba(255,255,255,.7), inset 0 -2px 5px rgba(0,0,0,.35)';

  function swapButton(u, cy) {
    return cap(1014, cy - 46, 'ACT / STBY') +
      '<div data-swap="' + u + '" style="position:absolute;left:970px;top:' + (cy - 24) + 'px;width:88px;height:48px;' +
      'border-radius:4px;display:flex;align-items:center;justify-content:center;' +
      'background:linear-gradient(180deg,#eef1f2 0%,#ccd1d3 55%,#a9b0b3 100%);box-shadow:' + SWAP_UP + ';' +
      'cursor:pointer;user-select:none;touch-action:manipulation">' +
        '<svg width="44" height="16" viewBox="0 0 54 18" style="pointer-events:none">' +
          '<line x1="10" y1="9" x2="44" y2="9" stroke="#20262a" stroke-width="3" stroke-linecap="round" data-nobacklight="1"></line>' +
          '<polygon points="2,9 14,3 14,15" fill="#20262a" data-nobacklight="1"></polygon>' +
          '<polygon points="52,9 40,3 40,15" fill="#20262a" data-nobacklight="1"></polygon>' +
        '</svg>' +
      '</div>';
  }

  function seg(id, cy, left, value) {
    return '<seven-seg data-disp="' + id + '" digits="6" value="' + value + '" label="" bezel-tone="black" ' +
      'on-color="#ff2f22" scale="0.8" pad-x="26" pad-y="16" ' +
      'style="position:absolute;left:' + left + 'px;top:' + (cy - 37.5) + 'px"></seven-seg>';
  }

  function unit(u, cy) {
    var b0 = BANDS[u][0];
    var pair = SEED[u][b0.k];
    return ticks(u, SEL_CX, cy) +
      '<fcu-selector-knob knob-id="sel' + u + '" size="' + SEL_SIZE + '" index="0" ' +
        'angles="' + unitAngles(u).join(',') + '" style="position:absolute;left:' + (SEL_CX - SEL_SIZE / 2) +
        'px;top:' + (cy - SEL_SIZE / 2) + 'px"></fcu-selector-knob>' +
      selLabels(u, SEL_CX, cy) +

      seg('r' + u + 'a', cy, 240, pair[0]) +
      seg('r' + u + 's', cy, 520, pair[1]) +

      '<fcu-knob knob-id="tune' + u + '" size="124" boss="true" ring="false" detent="12" knurl="false" ' +
        'bezel-mark="true" cap-inset="30" style="position:absolute;left:818px;top:' + (cy - 62) + 'px"></fcu-knob>' +
      cap(797, cy - 30, '+', { size: 15 }) +
      cap(797, cy + 30, '&minus;', { size: 15 }) +
      '<div data-mode="' + u + '-coarse" style="position:absolute;left:856px;top:' + (cy + 72) + 'px;' +
        'transform:translate(-50%,-50%);font-size:10px;font-weight:700;letter-spacing:.6px;user-select:none;color:' + UNLIT + '">MHz</div>' +
      '<div data-mode="' + u + '-fine" style="position:absolute;left:906px;top:' + (cy + 72) + 'px;' +
        'transform:translate(-50%,-50%);font-size:10px;font-weight:700;letter-spacing:.6px;user-select:none;color:' + LIT + '">kHz</div>' +

      swapButton(u, cy);
  }

  /* transmit selector — horizontal lever between the COM1 and COM2 audio switches.
     left = COM1, right = COM2. Labelled MIC SEL, as on a real audio panel. */
  function micSel() {
    return '<fcu-lever lever-id="mic-sel" size="44" position="left" ' +
      'style="position:absolute;left:189px;top:402px"></fcu-lever>' +
      cap(172, 424, '1') +
      cap(250, 424, '2') +
      cap(211, 462, 'MIC SEL');
  }

  function audioRow() {
    var out = rule(40, 352, 1032) + cap(556, 372, 'AUDIO SELECT', { ls: '2.4' }) + micSel();
    AUDIO.forEach(function (a) {
      out += '<fcu-lever lever-id="' + a.id + '" vertical="true" size="44" position="' + (a.on ? 'right' : 'left') + '" ' +
        'style="position:absolute;left:' + (a.x - 22) + 'px;top:402px"></fcu-lever>' +
        cap(a.x, 462, a.label);
    });
    return out;
  }

  class RadioPanel extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;

      this.sel = { 1: 0, 2: 0 };
      this.mode = { 1: 'fine', 2: 'fine' };
      this.bezelAngle = { 1: 0, 2: 0 };
      this.fineAngle = { 1: 0, 2: 0 };
      this.audio = {};
      this.mic = 1;
      this.freq = JSON.parse(JSON.stringify(SEED));

      var scale = parseFloat(this.getAttribute('scale') || '1') || 1;
      var own = this.getAttribute('style') || '';
      this.style.cssText = 'display:inline-block;font-family:Helvetica,Arial,sans-serif' + (own ? ';' + own : '');

      this.innerHTML =
        '<div data-box style="width:' + (W * scale) + 'px;height:' + (H * scale) + 'px">' +
          '<div data-panel style="position:relative;box-sizing:border-box;width:' + W + 'px;height:' + H + 'px;' +
            'transform-origin:top left' + (scale === 1 ? '' : ';transform:scale(' + scale + ')') + '">' +
            '<panel-chassis tone="dark"></panel-chassis>' +
            unit(1, ROW[1]) +
            rule(250, 187, 80) + rule(396, 187, 88) +
            cap(362, 187, 'ACTIVE', { size: 12, ls: '1.2' }) +
            rule(530, 187, 70) + rule(686, 187, 78) +
            cap(642, 187, 'STANDBY', { size: 12, ls: '1.2' }) +
            unit(2, ROW[2]) +
            '<div data-audio>' + audioRow() + '</div>' +
          '</div>' +
        '</div>';

      this._collectDisplays();
      this._wireKnobs();
      this._wireLevers();
      this._wireSwaps();
      this._paint();
      this._paintMode();
      if (this.getAttribute('audio-row') === 'false') this.querySelector('[data-audio]').style.display = 'none';

      var self = this;
      var api = {
        knob: function (id) { var el = self.querySelector('[data-knob="' + id + '"]'); return el && el.knob; },
        lever: function (id) { var el = self.querySelector('[data-lever="' + id + '"]'); return el && el.lever; },
        display: function (id) { return self.disp[id] || null; },
        /* unit is 1 (upper) or 2 (lower) */
        band: function (u) { return self._band(u).k; },
        bands: function (u) { return BANDS[u].map(function (b) { return b.k; }); },
        setBand: function (u, i) {
          var k = api.knob('sel' + u);
          if (k) k.setIndex(i);
          self.sel[u] = Math.max(0, Math.min(BANDS[u].length - 1, i));
          self._paint();
        },
        onBand: function (fn) { self._bandCb = fn; },
        freq: function (u) { return self.freq[u][self._band(u).k].slice(); },
        setFreq: function (u, active, standby) {
          var p = self.freq[u][self._band(u).k];
          if (active !== null && active !== undefined) p[0] = active;
          if (standby !== null && standby !== undefined) p[1] = standby;
          self._paint();
        },
        onFreq: function (fn) { self._freqCb = fn; },
        swap: function (u) { self._swap(u); },
        onSwap: function (fn) { self._swapCb = fn; },
        tuneMode: function (u) { return self.mode[u]; },
        audioState: function () { var o = {}; Object.keys(self.audio).forEach(function (k) { o[k] = self.audio[k]; }); return o; },
        setAudio: function (id, on) { var l = api.lever(id); if (l) { self.audio[id] = !!on; l.set(on ? 'right' : 'left'); } },
        onAudio: function (fn) { self._audioCb = fn; },
        /* transmit selector: 1 = COM1, 2 = COM2 */
        micSel: function () { return self.mic; },
        setMic: function (n) {
          self.mic = n === 2 ? 2 : 1;
          var l = api.lever('mic-sel');
          if (l) l.set(self.mic === 2 ? 'right' : 'left');
        },
        onMic: function (fn) { self._micCb = fn; },
        setBacklight: function (on) { self._backlight(!!on); },
        setColor: function (hex) { Object.keys(self.disp).forEach(function (k) { self.disp[k].setColor(hex); }); },
        root: this
      };
      this.panel = api;
      this.api = api;
      if (typeof window !== 'undefined') window.radioPanel = api;
      this.dispatchEvent(new CustomEvent('radio-panel-ready', { detail: api, bubbles: true }));
    }

    /* ------------------------------------------------------------ wiring */

    _collectDisplays() {
      var self = this;
      this.disp = {};
      this.querySelectorAll('[data-disp]').forEach(function (el) {
        if (el.segdisplay) self.disp[el.dataset.disp] = el.segdisplay;
      });
    }

    _wireKnobs() {
      var self = this;
      [1, 2].forEach(function (u) {
        var sel = self.querySelector('[data-knob="sel' + u + '"]');
        if (sel && sel.knob) {
          sel.knob.setGlow(false);
          sel.knob.onChange(function (i) {
            self.sel[u] = i;
            self._paint();
            if (self._bandCb) self._bandCb(u, BANDS[u][i].k);
          });
        }
        var t = self.querySelector('[data-knob="tune' + u + '"]');
        if (!t || !t.knob) return;
        t.knob.setGlow(false);
        t.knob.onTurn(function (dir) { self._tune(u, dir); });
        t.knob.onPush(function () { self._swap(u); });
        /* concentric rings: the outer ring tunes MHz, the inner boss kHz */
        var pickRing = function (e) {
          var b = t.getBoundingClientRect();
          var d = Math.sqrt(Math.pow(e.clientX - (b.left + b.width / 2), 2) +
                            Math.pow(e.clientY - (b.top + b.height / 2), 2));
          self.mode[u] = d > b.width * 0.30 ? 'coarse' : 'fine';
          self._paintMode();
        };
        t.addEventListener('pointerdown', pickRing, true);
        t.addEventListener('wheel', pickRing, true);
      });
    }

    _wireLevers() {
      var self = this;
      var mic = this.querySelector('[data-lever="mic-sel"]');
      if (mic && mic.lever) {
        this.mic = mic.lever.get() === 'right' ? 2 : 1;
        mic.lever.onChange(function (pos) {
          var next = pos === 'center' ? (self.mic === 1 ? 2 : 1) : (pos === 'right' ? 2 : 1);
          self.mic = next;
          mic.lever.set(next === 2 ? 'right' : 'left');
          if (self._micCb) self._micCb(next);
        });
      }
      AUDIO.forEach(function (a) {
        var el = self.querySelector('[data-lever="' + a.id + '"]');
        if (!el || !el.lever) return;
        self.audio[a.id] = el.lever.get() === 'right';
        el.lever.onChange(function (pos) {
          /* two-position switch: a tap in the middle flips to the other side */
          var next = pos === 'center' ? !self.audio[a.id] : pos === 'right';
          self.audio[a.id] = next;
          el.lever.set(next ? 'right' : 'left');
          if (self._audioCb) self._audioCb(a.id, next);
        });
      });
    }

    _wireSwaps() {
      var self = this;
      this.querySelectorAll('[data-swap]').forEach(function (btn) {
        var up = function () { btn.style.transform = ''; btn.style.boxShadow = SWAP_UP; };
        btn.addEventListener('pointerdown', function () {
          btn.style.transform = 'translateY(2px)';
          btn.style.boxShadow = SWAP_DOWN;
        });
        btn.addEventListener('pointerup', up);
        btn.addEventListener('pointercancel', up);
        btn.addEventListener('pointerleave', up);
        btn.addEventListener('click', function () { self._swap(Number(btn.dataset.swap)); });
      });
    }

    /* ------------------------------------------------------------- tuning */

    _band(u) { return BANDS[u][this.sel[u]]; }

    _tune(u, dir) {
      var b = this._band(u);
      var t = this.querySelector('[data-knob="tune' + u + '"]');
      if (t && t.knob) {
        if (this.mode[u] === 'coarse') {
          /* the knob rotated its cap on the way in — hand that turn to the outer ring */
          t.knob.setAngle(this.fineAngle[u] || 0);
          this.bezelAngle[u] = (this.bezelAngle[u] || 0) + dir * 12;
          t.knob.setBezelAngle(this.bezelAngle[u]);
        } else {
          this.fineAngle[u] = t.knob.getAngle();
        }
      }
      var step = this.mode[u] === 'coarse' ? b.coarse : b.fine;
      var v = this.freq[u][b.k][1] + dir * step;
      var span = b.max - b.min + step;
      if (v > b.max) v -= span;
      if (v < b.min) v += span;
      this.freq[u][b.k][1] = v;
      this._paint();
      if (this._freqCb) this._freqCb(u, b.k, this.freq[u][b.k].slice());
    }

    _swap(u) {
      var b = this._band(u), p = this.freq[u][b.k];
      this.freq[u][b.k] = [p[1], p[0]];
      this._paint();
      if (this._swapCb) this._swapCb(u, b.k, this.freq[u][b.k].slice());
    }

    _fmt(b, v) {
      var s = String(v);
      var pad = b.zero ? 6 : 4, ch = b.zero ? '0' : ' ';
      while (s.length < pad) s = ch + s;
      while (s.length < 6) s = ' ' + s;
      return s;
    }

    _paint() {
      var self = this;
      [1, 2].forEach(function (u) {
        var b = self._band(u), pair = self.freq[u][b.k];
        ['a', 's'].forEach(function (suffix, i) {
          var d = self.disp['r' + u + suffix];
          if (!d) return;
          d.set(self._fmt(b, pair[i]));
          for (var k = 0; k < 6; k++) d.setDecimal(k, false);
          if (b.dp > 0) d.setDecimal(b.dp, true);
        });
      });
    }

    _paintMode() {
      var self = this;
      [1, 2].forEach(function (u) {
        ['fine', 'coarse'].forEach(function (m) {
          var el = self.querySelector('[data-mode="' + u + '-' + m + '"]');
          if (el) el.style.color = self.mode[u] === m ? LIT : UNLIT;
        });
      });
    }

    _backlight(on) {
      this.querySelectorAll('[data-cap]').forEach(function (el) {
        el.style.color = on ? '#ffb15a' : SILK;
        el.style.textShadow = on
          ? '0 0 7px rgba(255,150,40,.55), 0 0 14px rgba(255,130,20,.28), 0 1px 1px rgba(0,0,0,.8)'
          : '0 1px 1px rgba(0,0,0,.85)';
      });
      this.querySelectorAll('[data-lever]').forEach(function (el) {
        if (el.lever && el.lever.setBacklight) el.lever.setBacklight(on);
      });
    }
  }

  if (!customElements.get('radio-panel')) customElements.define('radio-panel', RadioPanel);
})();
