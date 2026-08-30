// Bridges an XPlaneClient to MCDU-shaped concepts: a grid of styled
// characters for the screen, and named keys that map to commands.
//
// Knows the *profile* format (config/profiles/*.json) but nothing about
// rendering or DOM — see mcdu-screen.js / mcdu-keypad.js for that.

import { base64ToBytes, bytesToUtf8 } from "./xplane-client.js";

const STYLE_BIT = {
  LARGE: 1 << 7,
  REVERSE: 1 << 6,
  FLASH: 1 << 5,
  UNDERLINE: 1 << 4,
};
const COLOR_MASK = 0x0f;
export const STYLE_COLORS = [
  "black", "cyan", "red", "yellow", "green", "magenta", "amber", "white",
];

export class McduAdapter {
  /**
   * @param {import('./xplane-client.js').XPlaneClient} client
   * @param {object} profile parsed profile JSON (config/profiles/*.json)
   * @param {number} cduIndex 1 (captain) or 2 (first officer)
   */
  constructor(client, profile, cduIndex = 1) {
    this.client = client;
    this.profile = profile;
    this.cduIndex = cduIndex;

    const { lines, cols } = profile.screen;
    this.lines = lines;
    this.cols = cols;

    // blank screen model: array of lines, each an array of {char, large, reverse, flash, underline, color}
    this.screen = Array.from({ length: lines }, () => blankLine(cols));

    /** @type {Map<number,'text'|'style'> } dataref id -> what it feeds, plus which line */
    this._lineTextIds = new Array(lines).fill(null);
    this._lineStyleIds = new Array(lines).fill(null);
    /** raw bytes cache so we can recompute a line when either half updates independently */
    this._rawText = new Array(lines).fill(null);
    this._rawStyle = new Array(lines).fill(null);

    /** @type {Map<string, number>} logical key name -> command id, only entries that resolved */
    this.keyCommandIds = new Map();
    /** @type {Set<string>} logical key names present in the profile but unresolved on this sim */
    this.unresolvedKeys = new Set();
    /** @type {Map<string, object>} logical key name -> its profile definition, flattened across all `keys` groups (grouping there is just command-resolution bookkeeping, not meaningful here) */
    this._keyDefsByName = new Map();
    for (const group of Object.values(profile.keys)) {
      for (const [keyName, def] of Object.entries(group)) this._keyDefsByName.set(keyName, def);
    }

    this.onScreenUpdate = null; // () => void, called whenever a line changes
    this.onVertSlewChange = null; // (upGlyph, downGlyph) => void, called whenever the up/down scroll-availability indicator changes — see _applyVertSlewKeys()'s own comment for why this is a separate callback rather than part of the character grid
  }

  /** Resolve all datarefs/commands for the current cduIndex against the live sim. */
  async connect() {
    // ToLiss (config/profiles/mcdu-toliss-airbus.json) exposes its screen as
    // many separate per-line, per-color plain-text datarefs rather than the
    // stock aircraft's one text array + one style-bitfield array per line —
    // a genuinely different shape, not just different names, so it gets its
    // own connect path entirely (_connectColoredLinesScreen below) rather
    // than being squeezed into the byte/style decoding below. Every other
    // profile (default-fms.json, b738-fms.json) has no `kind` field at all,
    // so this check — and everything below it — is unreached and unchanged
    // for them.
    if (this.profile.screen.kind === "coloredLines") {
      await this._connectColoredLinesScreen();
      await this._resolveKeys();
      return;
    }

    const { textDatarefTemplate, styleDatarefTemplate } = this.profile.screen;
    const textNames = [];
    const styleNames = [];
    for (let line = 0; line < this.lines; line++) {
      textNames.push(fillTemplate(textDatarefTemplate, this.cduIndex, line));
      styleNames.push(fillTemplate(styleDatarefTemplate, this.cduIndex, line));
    }

    const [textIds, styleIds] = await Promise.all([
      this.client.resolveDatarefIds(textNames),
      this.client.resolveDatarefIds(styleNames),
    ]);

    for (let line = 0; line < this.lines; line++) {
      const textId = textIds.get(textNames[line]);
      const styleId = styleIds.get(styleNames[line]);
      if (textId == null || styleId == null) {
        console.warn(
          `[mcdu-adapter] line ${line}: missing dataref (text=${textNames[line]} -> ${textId}, style=${styleNames[line]} -> ${styleId}). ` +
            `Screen will show blank for this line.`
        );
        continue;
      }
      this._lineTextIds[line] = textId;
      this._lineStyleIds[line] = styleId;
      this.client.subscribeDataref(textId, (raw) => this._onRaw(line, "text", raw));
      this.client.subscribeDataref(styleId, (raw) => this._onRaw(line, "style", raw));
    }

    await this._resolveKeys();
  }

  /**
   * ToLiss's screen shape (config/profiles/mcdu-toliss-airbus.json's
   * `screen.rows`): each row is one or two "sources" (e.g. a row pairs a
   * large-font `cont3` with a small-font `scont3` — confirmed live these
   * are mutually exclusive per row, one real Airbus MCDU page never shows
   * both at once, though nothing here assumes that and would still cope
   * if it were ever wrong). Each source is itself split across up to 7
   * separate same-length plain-text datarefs, one per color letter
   * (`profile.screen.colors`) — confirmed live only one color's copy is
   * ever non-blank at a given character position, the rest hold spaces.
   * So: resolve every (row, source, color) combination against
   * `screen.datarefTemplate`, skip whichever don't exist for this
   * particular row (most rows only ever populate 1-2 of the 7 — e.g.
   * `title` has no amber/magenta variant at all, confirmed live), and
   * recompute the whole row by overlaying every color's text onto a blank
   * line whenever any of its sources' datarefs push a new value.
   */
  async _connectColoredLinesScreen() {
    const { rows, colors, colorMap, datarefTemplate, vertSlewKeysDataref } = this.profile.screen;
    /** @type {Array<Array<Object<string,string[]>>>} [row][sourceIndex] -> {colorLetter: chars[]} */
    this._coloredRaw = rows.map((row) => row.sources.map(() => ({})));
    // The up/down scroll-availability arrows (see _applyVertSlewKeys()'s
    // own comment) live entirely outside the row/color grid above — a
    // single extra scalar dataref, not part of any row's sources or the
    // 24x14 character grid at all.
    this._vertSlewKeys = 0;

    const nameInfo = [];
    rows.forEach((row, r) => {
      row.sources.forEach((source, s) => {
        for (const color of colors) {
          const name = datarefTemplate
            .replace("{cdu}", String(this.cduIndex))
            .replace("{prefix}", source.prefix)
            .replace("{color}", color);
          nameInfo.push({ name, row: r, sourceIndex: s, color });
        }
      });
    });
    const vertSlewKeysName = vertSlewKeysDataref?.replace("{cdu}", String(this.cduIndex));

    // fallback: false -- most of these (row, source, color) combinations
    // are absent from the bulk dataref list *by design* (most rows only
    // ever populate 1-2 of the 7 color channels), not because they're a
    // rare alias the bulk list happens to miss (see
    // XPlaneClient.resolveDatarefIds()'s own comment on what the fallback
    // is actually for). Confirmed live 2026-08-30 that leaving it on here
    // meant 100+ sequential one-at-a-time 404 lookups on every connect —
    // slow, and console-flooding for no benefit, since none of these were
    // ever going to turn out to be an alias.
    const ids = await this.client.resolveDatarefIds(vertSlewKeysName ? [...nameInfo.map((i) => i.name), vertSlewKeysName] : nameInfo.map((i) => i.name), { fallback: false });
    let resolvedCount = 0;
    for (const info of nameInfo) {
      const id = ids.get(info.name);
      if (id == null) continue; // this row doesn't use this color — normal, not every row uses all 7
      resolvedCount++;
      this.client.subscribeDataref(id, (raw) => {
        this._coloredRaw[info.row][info.sourceIndex][info.color] = decodeColoredChars(raw);
        this._recomputeColoredRow(info.row);
      });
    }
    if (vertSlewKeysName) {
      const vskId = ids.get(vertSlewKeysName);
      if (vskId == null) {
        console.warn(`[mcdu-adapter] vertSlewKeysDataref "${vertSlewKeysName}" did not resolve — scroll arrows won't show`);
      } else {
        this.client.subscribeDataref(vskId, (raw) => {
          this._vertSlewKeys = Number(raw) || 0;
          this._applyVertSlewKeys();
        });
      }
    }
    if (resolvedCount === 0) {
      console.warn("[mcdu-adapter] coloredLines screen: nothing resolved at all — wrong aircraft, or profile.screen.datarefTemplate/rows is wrong?");
    }
  }

  /**
   * Reports the up/down scroll-availability indicator via a dedicated
   * callback rather than the character grid. Added for ToLiss's
   * AirbusFBW/MCDU{cdu}VertSlewKeys — confirmed live 2026-08-30 against a
   * real F-PLN page with scrollable content: `0` = neither arrow, `1` =
   * both, `3` = down only. `2` (up only) is inferred by elimination, not
   * independently confirmed — flag if it turns out to mean something else.
   * First implementation overwrote the last two columns of the last
   * content row directly, on the assumption that corner was always blank
   * — wrong: a real Airbus MCDU can show real right-aligned text there
   * too (e.g. "INSERT*" on F-PLN when there's a pending revision to
   * confirm), confirmed live 2026-08-30 when it came through as "INSER"
   * with the arrows stomping its last two characters instead of "INSERT*".
   * Reporting this through its own callback instead — leaving the
   * character grid alone entirely — means it can never collide with real
   * screen content regardless of what any row happens to show.
   */
  _applyVertSlewKeys() {
    const [up, down] = VERT_SLEW_GLYPHS[this._vertSlewKeys] ?? VERT_SLEW_GLYPHS[0];
    this.onVertSlewChange?.(up, down);
  }

  /** Rebuilds one row of `this.screen` from every color/source currently cached for it — see _connectColoredLinesScreen()'s own comment for the shape. */
  _recomputeColoredRow(rowIndex) {
    const row = this.profile.screen.rows[rowIndex];
    const { colorMap } = this.profile.screen;
    const line = blankLine(this.cols);
    for (let s = 0; s < row.sources.length; s++) {
      const source = row.sources[s];
      const byColor = this._coloredRaw[rowIndex][s];
      for (const [colorLetter, chars] of Object.entries(byColor)) {
        const colorName = colorMap[colorLetter] ?? "white";
        for (let i = 0; i < this.cols; i++) {
          let ch = chars[i];
          if (!ch || ch === " ") continue; // blank at this position in this color -- some other color (or nothing) owns it
          let color = colorName;
          // Confirmed live 2026-08-29 (E/A/B) and 2026-08-30 (2/3): the
          // 's' channel isn't a text color at all -- it's a small symbol
          // font. Specific characters render as placeholder/navigation
          // glyphs instead of themselves: "E" repeated is a row of small
          // amber boxes (e.g. empty CO RTE/FROM-TO on INIT/A), "A"/"B" are
          // the left/right halves of a bracket placeholder (e.g. empty
          // V1/VR/FLAPS-THS on TAKEOFF PERF, seen live as literal "A B"
          // rendering as "[ ]"), and "2"/"3" in the title row's top-right
          // corner are left/right page-navigation arrows (e.g. DATA
          // INDEX's "2""3" pair) -- previously misread as a literal page
          // "2 of 3" counter (a plausible-looking coincidence, since DATA
          // INDEX genuinely does paginate) until a user confirmed live
          // they're real arrow icons on the actual cockpit texture, not
          // digits at all. Only these exact characters are special-cased,
          // regardless of what colorMap.s says otherwise -- an actual
          // typed digit 2 or 3 elsewhere in a different color still
          // renders as itself.
          const symbolGlyph = colorLetter === "s" ? SYMBOL_FONT_GLYPHS[ch] : undefined;
          let align;
          if (symbolGlyph) {
            ch = symbolGlyph.char;
            color = symbolGlyph.color;
            align = symbolGlyph.align;
          }
          line[i] = { char: ch, large: source.large, reverse: false, flash: false, underline: false, color, align };
        }
      }
    }
    this.screen[rowIndex] = line;
    this.onScreenUpdate?.(rowIndex);
  }

  async _resolveKeys() {
    // Command names are stored as a suffix in the profile because the same
    // key set lives under a different prefix per CDU (sim/FMS, sim/FMS2,
    // sim/CDU3 on the aircraft this was verified against) — not a simple
    // {cdu} substitution like the screen datarefs.
    const prefix = this.profile.commandPrefixByCdu?.[String(this.cduIndex)];
    if (!prefix) {
      console.warn(`[mcdu-adapter] profile has no commandPrefixByCdu entry for CDU ${this.cduIndex}; no keys will resolve`);
    }
    const allEntries = [];
    for (const [keyName, def] of this._keyDefsByName) {
      // Most keys: suffix composed with the CDU's command prefix. A few
      // (e.g. brightness) are aircraft-specific commands that already
      // vary by CDU in an irregular way and just substitute {cdu} directly.
      const fullCommand = def.commandTemplate
        ? def.commandTemplate.replace("{cdu}", String(this.cduIndex))
        : prefix
          ? `${prefix}/${def.command}`
          : def.command;
      allEntries.push([keyName, fullCommand]);
    }
    const ids = await this.client.resolveCommandIds(allEntries.map(([, cmd]) => cmd));
    for (const [keyName, cmd] of allEntries) {
      const id = ids.get(cmd);
      if (id == null) {
        this.unresolvedKeys.add(keyName);
      } else {
        this.keyCommandIds.set(keyName, id);
      }
    }
    if (this.unresolvedKeys.size > 0) {
      console.warn(
        `[mcdu-adapter] ${this.unresolvedKeys.size} key(s) did not resolve to a command on this sim ` +
          `(profile guesses may be wrong for this aircraft): ${[...this.unresolvedKeys].join(", ")}`
      );
    }
  }

  _onRaw(line, which, raw) {
    if (which === "text") this._rawText[line] = raw;
    else this._rawStyle[line] = raw;

    if (this._rawText[line] == null || this._rawStyle[line] == null) return; // wait for both halves

    this.screen[line] = decodeLine(this._rawText[line], this._rawStyle[line], this.cols);
    this.onScreenUpdate?.(line);
  }

  /**
   * Press a named key (must exist in the profile, e.g. "1", "A", "L1",
   * "CLR", "LEGS" — see config/profiles/default-fms.json for the full set).
   * No-ops (with a console warning) if the key didn't resolve to a live
   * command on connect.
   */
  pressKey(keyName) {
    const id = this.keyCommandIds.get(keyName);
    if (id == null) {
      console.warn(`[mcdu-adapter] key "${keyName}" has no resolved command; ignoring press`);
      return false;
    }
    this.client.activateCommand(id);
    return true;
  }

  isKeyAvailable(keyName) {
    return this.keyCommandIds.has(keyName);
  }

  /**
   * A profile-specific button label, for keys whose real keycap text
   * differs from mcdu-keypad.js's own shared default for that key name
   * (e.g. the 737's "RTE" vs the Airbus's "F-PLN", both the same
   * underlying `fpln` key) — see config/profiles/b738-fms.json's
   * `keys.*.*.label`. Returns null (fall back to the shared default) when
   * a profile doesn't specify one.
   */
  getKeyLabel(keyName) {
    return this._keyDefsByName.get(keyName)?.label ?? null;
  }
}

function blankLine(cols) {
  return Array.from({ length: cols }, () => ({
    char: " ",
    large: false,
    reverse: false,
    flash: false,
    underline: false,
    color: "white",
  }));
}

/**
 * @param {string} textB64
 * @param {string} styleB64
 * @param {number} cols
 */
function decodeLine(textB64, styleB64, cols) {
  const textBytes = base64ToBytes(textB64 ?? "");
  const styleBytes = base64ToBytes(styleB64 ?? "");
  const text = bytesToUtf8(textBytes);
  // Style is documented as one byte per *character*, so split the decoded
  // string by codepoint (not by UTF-8 byte) to line up with styleBytes.
  const chars = Array.from(text);

  const out = blankLine(cols);
  for (let i = 0; i < cols; i++) {
    const ch = chars[i] ?? " ";
    const style = styleBytes[i] ?? 0;
    out[i] = {
      char: ch === " " ? " " : ch,
      large: Boolean(style & STYLE_BIT.LARGE),
      reverse: Boolean(style & STYLE_BIT.REVERSE),
      flash: Boolean(style & STYLE_BIT.FLASH),
      underline: Boolean(style & STYLE_BIT.UNDERLINE),
      color: STYLE_COLORS[style & COLOR_MASK] ?? "white",
    };
  }
  return out;
}

function fillTemplate(template, cdu, line) {
  return template.replace("{cdu}", String(cdu)).replace("{line}", String(line));
}

// ToLiss's 's' screen color doubles as a small symbol font -- see the long
// comment in _recomputeColoredRow(). Each entry carries its own color:
// E/A/B are "mandatory field" placeholders (amber, matching real hardware's
// warning convention), 2/3 are plain page-navigation chrome (white, not a
// warning) -- unlike the shared "amber" this table used to hardcode for
// every entry.
const SYMBOL_FONT_GLYPHS = {
  E: { char: "▯", color: "amber" },
  // Confirmed live 2026-08-30: the bracket placeholder renders cyan on the
  // real sim display, not amber -- amber here was carried over from the
  // box-glyph's own confirmed amber on the (unverified) assumption both
  // are the same "mandatory field" warning color; they aren't. Matches
  // colorMap.b (Airbus's cyan-ish "blue"), suggesting this placeholder is
  // really rendered in the 'b' hue on real hardware, just delivered
  // through the 's' text channel like the other symbol-font characters.
  A: { char: "[", color: "cyan" },
  B: { char: "]", color: "cyan" },
  // Plain U+2190/U+2192 "arrows" block, not the U+25C0/U+25B6 "triangle"
  // block first tried here -- B612 Mono (this screen's own font, see
  // css/mcdu.css's .ch) has no glyphs for either, but the triangle pair
  // fell back to two genuinely *different* fonts in the fallback chain
  // (confirmed live 2026-08-30: the left one rendered noticeably larger
  // than the right, a font-substitution mismatch, not a sizing bug in
  // this app) and looked like solid triangles rather than arrows anyway.
  // Plain directional arrows are common enough to resolve consistently
  // from whichever single fallback font covers them. They sit in adjacent
  // columns with no blank column between them (that's just where ToLiss's
  // own raw text puts the two characters they replace), and each glyph's
  // ink already reaches close to its own cell's edge, so the screen's
  // usual 1px column-gap (see css/mcdu.css's .mcdu-screen) reads as the
  // two arrows touching -- align nudges each one toward its own cell's
  // *outer* edge (away from the other arrow) to open up a visible gap
  // between them without changing column-gap globally for every other
  // character on the whole screen.
  2: { char: "←", color: "white", align: "start" },
  3: { char: "→", color: "white", align: "end" },
  // A second, unrelated left/right arrow pair -- confirmed live
  // 2026-08-30 on an F-PLN page: "0" immediately before a waypoint name
  // (e.g. "0RUNGA", the 'b'/cyan-colored name right after it) is really a
  // left arrow, and "1" immediately after one (e.g. "ABEAM PTS" + "1") is
  // a right arrow -- both colored cyan, matching the adjacent waypoint
  // text, not white like the title's page-nav arrows above. These are
  // inline route-editing chrome (direct-to / abeam-point style markers),
  // a different real concept from the title's page-turn arrows, which is
  // presumably why ToLiss encodes them as different characters entirely
  // rather than reusing 2/3. The same "'s' isn't a color, it's a symbol
  // font" caution applies here too: 0/1 are common digits, so this is a
  // wider net than E/A/B/2/3's less-common characters -- flag if a real
  // numeric 0 or 1 ever legitimately shows up in the 's' color somewhere.
  0: { char: "←", color: "cyan" },
  1: { char: "→", color: "cyan" },
  // A third arrow, confirmed live 2026-08-30: "4" immediately before
  // ERASE (cont6s="4 ", cont6a=" ERASE...") is a left arrow pointing at
  // the ERASE prompt's own LSK, colored amber to match ERASE itself --
  // this app's own SYMBOL_FONT_GLYPHS entry had flagged "4" as an
  // unmapped, unexplained sighting before this was confirmed. No matching
  // right-arrow character found yet for the equivalent INSERT* prompt on
  // the same row -- it uses a literal "*" instead, not an arrow, so
  // there may not be one to find.
  4: { char: "←", color: "amber" },
};

// AirbusFBW/MCDU{cdu}VertSlewKeys -> [up glyph, down glyph] -- see
// _applyVertSlewKeys()'s own comment for what's confirmed vs inferred.
// Plain U+2191/U+2193 arrows, not solid triangles -- same reasoning as
// SYMBOL_FONT_GLYPHS's own 2/3 entries (a triangle pair risks falling
// back to two visibly different fonts/sizes; these render consistently).
const VERT_SLEW_GLYPHS = {
  0: [" ", " "],
  1: ["↑", "↓"],
  2: [" ", "↑"],
  3: [" ", "↓"],
};

/**
 * Decodes one of ToLiss's screen-content datarefs: base64 -> UTF-8 ->
 * trailing-NUL trimmed -> split into codepoints (not UTF-8 bytes, same
 * reasoning as decodeLine() above — keeps a multi-byte character aligned
 * to one screen column instead of several). Confirmed live 2026-08-28:
 * these are plain fixed-width space-padded ASCII strings, not a byte/style
 * pair like the stock aircraft's screen datarefs.
 * @param {string} b64
 * @returns {string[]}
 */
function decodeColoredChars(b64) {
  // ToLiss's screen text uses the classic Airbus/Boeing CDU font convention
  // where a literal backtick (0x60) is the degree symbol, not a backtick --
  // confirmed live 2026-08-29 on the PROG page's BRG/DIST field
  // (cont4w = " ---`  /----.-", i.e. "---°/----.-").
  const text = bytesToUtf8(base64ToBytes(b64 ?? ""))
    .replace(/\0+$/, "")
    .replace(/`/g, "°");
  return Array.from(text);
}
