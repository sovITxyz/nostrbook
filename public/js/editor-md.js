// DOM-free markdown text-manipulation core for the editor toolbar. Every
// helper takes (value, selStart, selEnd, ...) and returns a replacement
// instruction — { start, end, text, selStart, selEnd }: splice `text` over
// [start, end) and place the selection at [selStart, selEnd] — or null,
// meaning "not applicable, let the browser's native behavior run".
// insertFootnote additionally carries an `append` string the caller adds at
// the END of the document as a SECOND replacement (two undo steps, accepted
// trade-off for keeping every instruction a single contiguous splice).
//
// public/js/editor-toolbar.js owns the DOM side (one execCommand seam so
// native undo survives); test/unit/editor-md.spec.ts exercises this file
// directly — keep it free of document/window references.
(function () {
  "use strict";

  // "Word" for caret expansion: ASCII alphanumerics plus anything non-ASCII
  // (so accented and CJK text expands too); punctuation and spaces break.
  var WORD_CHAR = /[A-Za-z0-9_\u00C0-\uFFFF]/;

  var BULLET_RE = /^(\s*)([-*+])\s+/;
  var TASK_RE = /^(\s*)([-*+])\s+\[[ xX]\]\s+/;
  var QUOTE_RE = /^>\s?/;
  var ORDERED_RE = /^(\s*)(\d+)([.)])\s+/;
  // List-continuation shape shared by Enter and Tab handling: indent, bullet
  // or ordered marker, optional task box, then at least one space.
  var LIST_RE = /^(\s*)([-*+]|\d+[.)])(\s+\[[ xX]\])?\s+/;
  var URL_RE = /^https?:\/\/\S+$/;

  function wordRangeAt(value, pos) {
    var start = pos;
    var end = pos;
    while (start > 0 && WORD_CHAR.test(value.charAt(start - 1))) start--;
    while (end < value.length && WORD_CHAR.test(value.charAt(end))) end++;
    return { start: start, end: end };
  }

  function lineRangeAt(value, pos) {
    var start = value.lastIndexOf("\n", pos - 1) + 1;
    var end = value.indexOf("\n", pos);
    if (end === -1) end = value.length;
    return { start: start, end: end };
  }

  // Full lines intersecting [s, e]. A selection ending exactly at a line
  // start (just past a "\n") does NOT pull that next line in.
  function coveredLineRange(value, s, e) {
    var endRef = e;
    if (e > s && e > 0 && value.charAt(e - 1) === "\n") endRef = e - 1;
    return {
      start: lineRangeAt(value, s).start,
      end: lineRangeAt(value, endRef).end,
    };
  }

  // --- Inline wrapping -------------------------------------------------------

  function wrapInline(value, s, e, marker) {
    var m = marker.length;
    if (s === e) {
      // Second press on a just-inserted empty pair deletes it again.
      if (
        s >= m &&
        value.slice(s - m, s) === marker &&
        value.slice(s, s + m) === marker
      ) {
        return { start: s - m, end: s + m, text: "", selStart: s - m, selEnd: s - m };
      }
      var word = wordRangeAt(value, s);
      if (word.start === word.end) {
        // Caret on whitespace: insert an empty pair with the caret inside.
        return {
          start: s,
          end: s,
          text: marker + marker,
          selStart: s + m,
          selEnd: s + m,
        };
      }
      // No selection: operate on the word under the caret.
      s = word.start;
      e = word.end;
    }
    var sel = value.slice(s, e);
    var inner;
    // Unwrap a space-padded double-backtick code span selected whole.
    if (
      marker === "`" &&
      sel.length >= 6 &&
      sel.slice(0, 3) === "`` " &&
      sel.slice(-3) === " ``"
    ) {
      inner = sel.slice(3, -3);
      return { start: s, end: e, text: inner, selStart: s, selEnd: s + inner.length };
    }
    // Unwrap when the selection itself is exactly wrapped…
    if (
      sel.length >= 2 * m &&
      sel.slice(0, m) === marker &&
      sel.slice(-m) === marker
    ) {
      inner = sel.slice(m, sel.length - m);
      return { start: s, end: e, text: inner, selStart: s, selEnd: s + inner.length };
    }
    // …or when its immediate surroundings are — including the space-padded
    // double-backtick form a backtick-containing wrap produced, so a second
    // press round-trips instead of double-wrapping.
    if (
      marker === "`" &&
      s >= 3 &&
      value.slice(s - 3, s) === "`` " &&
      value.slice(e, e + 3) === " ``"
    ) {
      return {
        start: s - 3,
        end: e + 3,
        text: sel,
        selStart: s - 3,
        selEnd: s - 3 + sel.length,
      };
    }
    if (
      s >= m &&
      value.slice(s - m, s) === marker &&
      value.slice(e, e + m) === marker
    ) {
      return {
        start: s - m,
        end: e + m,
        text: sel,
        selStart: s - m,
        selEnd: s - m + sel.length,
      };
    }
    // Wrap. Inline code containing a backtick needs a longer, space-padded
    // delimiter (CommonMark) so the inner backticks survive.
    var open = marker;
    var close = marker;
    if (marker === "`" && sel.indexOf("`") !== -1) {
      open = "`` ";
      close = " ``";
    }
    return {
      start: s,
      end: e,
      text: open + sel + close,
      selStart: s + open.length,
      selEnd: s + open.length + sel.length,
    };
  }

  // --- Line-prefix toggles -----------------------------------------------------

  // Indexes of the lines a toggle should touch: non-empty lines, or ALL lines
  // when every covered line is empty (so pressing a list button on a blank
  // line still starts a list).
  function targetIndexes(lines) {
    var targets = [];
    var i;
    for (i = 0; i < lines.length; i++) {
      if (lines[i] !== "") targets.push(i);
    }
    if (targets.length === 0) {
      for (i = 0; i < lines.length; i++) targets.push(i);
    }
    return targets;
  }

  function fullLineInstruction(region, text) {
    return {
      start: region.start,
      end: region.end,
      text: text,
      selStart: region.start,
      selEnd: region.start + text.length,
    };
  }

  // Add-if-any-missing / remove-if-all-present toggle for "> ", "- " and
  // "- [ ] " (bullets recognize * and + as already-bulleted; removing a task
  // box keeps the text whether the box was checked or not).
  function toggleLinePrefix(value, s, e, prefix) {
    var region = coveredLineRange(value, s, e);
    var lines = value.slice(region.start, region.end).split("\n");
    var quote = prefix === "> ";
    var task = prefix === "- [ ] ";
    var bullet = prefix === "- ";

    function has(line) {
      if (quote) return QUOTE_RE.test(line);
      if (task) return TASK_RE.test(line);
      if (bullet) return BULLET_RE.test(line);
      return line.slice(0, prefix.length) === prefix;
    }
    function add(line) {
      if (has(line)) return line;
      if (task) {
        var bm = line.match(BULLET_RE);
        if (bm) return bm[1] + bm[2] + " [ ] " + line.slice(bm[0].length);
        return "- [ ] " + line;
      }
      return prefix + line;
    }
    function remove(line) {
      if (quote) return line.replace(QUOTE_RE, "");
      if (task) {
        var tm = line.match(TASK_RE);
        return tm ? tm[1] + line.slice(tm[0].length) : line;
      }
      if (bullet) {
        var bm = line.match(BULLET_RE);
        return bm ? bm[1] + line.slice(bm[0].length) : line;
      }
      return line.slice(0, prefix.length) === prefix
        ? line.slice(prefix.length)
        : line;
    }

    var targets = targetIndexes(lines);
    var allHave = true;
    var i;
    for (i = 0; i < targets.length; i++) {
      if (!has(lines[targets[i]])) {
        allHave = false;
        break;
      }
    }
    var out = lines.slice();
    for (i = 0; i < targets.length; i++) {
      out[targets[i]] = allHave ? remove(lines[targets[i]]) : add(lines[targets[i]]);
    }
    return fullLineInstruction(region, out.join("\n"));
  }

  // Caret line: none -> "## " -> "### " -> "#### " -> none; an existing
  // "# " (and any level 5+) folds into the cycle. Caret keeps its offset
  // within the heading text.
  function cycleHeading(value, s, e) {
    var line = lineRangeAt(value, s);
    var text = value.slice(line.start, line.end);
    var m = text.match(/^(#{1,6})[ \t]+/);
    var rest = m ? text.slice(m[0].length) : text;
    var level = m ? m[1].length : 0;
    var next;
    if (level === 0 || level === 1) next = "## ";
    else if (level === 2) next = "### ";
    else if (level === 3) next = "#### ";
    else next = "";
    var oldPrefixLen = m ? m[0].length : 0;
    var offset = Math.max(0, Math.min(s - line.start - oldPrefixLen, rest.length));
    var caret = line.start + next.length + offset;
    return {
      start: line.start,
      end: line.end,
      text: next + rest,
      selStart: caret,
      selEnd: caret,
    };
  }

  // Number covered lines 1. 2. 3.; renumber when only partially numbered
  // (existing bullets convert); toggle off when every line is numbered.
  function orderedList(value, s, e) {
    var region = coveredLineRange(value, s, e);
    var lines = value.slice(region.start, region.end).split("\n");
    var targets = targetIndexes(lines);
    var allNumbered = true;
    var i;
    for (i = 0; i < targets.length; i++) {
      if (!ORDERED_RE.test(lines[targets[i]])) {
        allNumbered = false;
        break;
      }
    }
    var out = lines.slice();
    // Per-indent counters so nested lists number independently; a shallower
    // line pops (resets) every deeper counter.
    var stack = [];
    for (i = 0; i < targets.length; i++) {
      var line = lines[targets[i]];
      var om = line.match(ORDERED_RE);
      if (allNumbered) {
        out[targets[i]] = om[1] + line.slice(om[0].length);
      } else {
        var bm = line.match(BULLET_RE);
        var indent = "";
        var stripped = line;
        if (om) {
          indent = om[1];
          stripped = line.slice(om[0].length);
        } else if (bm) {
          indent = bm[1];
          stripped = line.slice(bm[0].length);
        } else {
          indent = (line.match(/^\s*/) || [""])[0];
          stripped = line.slice(indent.length);
        }
        while (
          stack.length > 0 &&
          stack[stack.length - 1].indent.length > indent.length
        ) {
          stack.pop();
        }
        var top = stack.length > 0 ? stack[stack.length - 1] : null;
        if (top && top.indent === indent) {
          top.n += 1;
        } else {
          if (top && top.indent.length === indent.length) stack.pop();
          top = { indent: indent, n: 1 };
          stack.push(top);
        }
        out[targets[i]] = indent + top.n + ". " + stripped;
      }
    }
    return fullLineInstruction(region, out.join("\n"));
  }

  // --- Block inserts -------------------------------------------------------------

  // Insert `block` as its own blank-line-separated paragraph at pos, reusing
  // up to two newlines already present on each side instead of stacking new
  // ones. caretOffset (into the block) + selLen place the selection; when
  // caretOffset is absent the caret lands after the whole insertion.
  function blockInsert(value, pos, block, caretOffset, selLen) {
    var start = pos;
    var end = pos;
    while (start > 0 && pos - start < 2 && value.charAt(start - 1) === "\n") start--;
    while (end < value.length && end - pos < 2 && value.charAt(end) === "\n") end++;
    var pre = start === 0 ? "" : "\n\n";
    var post = end === value.length ? "\n" : "\n\n";
    var text = pre + block + post;
    var selStart;
    var selEnd;
    if (typeof caretOffset === "number") {
      selStart = start + pre.length + caretOffset;
      selEnd = selStart + (selLen || 0);
    } else {
      selStart = start + text.length;
      selEnd = selStart;
    }
    return { start: start, end: end, text: text, selStart: selStart, selEnd: selEnd };
  }

  // Selection: fence the covered lines, caret right after the opening ```
  // so a language can be typed. No selection: empty fence block, same caret.
  function codeFence(value, s, e) {
    if (s === e) {
      return blockInsert(value, s, "```\n\n```", 3);
    }
    var region = coveredLineRange(value, s, e);
    var body = value.slice(region.start, region.end);
    return {
      start: region.start,
      end: region.end,
      text: "```\n" + body + "\n```",
      selStart: region.start + 3,
      selEnd: region.start + 3,
    };
  }

  var TABLE_SKELETON =
    "| Column 1 | Column 2 |\n| --- | --- |\n|   |   |";

  function insertTable(value, s, e) {
    // Select "Column 1" (offset 2 = past "| ") so typing names the column.
    return blockInsert(value, s, TABLE_SKELETON, 2, "Column 1".length);
  }

  function insertRule(value, s, e) {
    return blockInsert(value, s, "---");
  }

  // Marker [^N] at the caret, N = 1 + the highest [^digits] anywhere in the
  // document. The `append` part is the definition stub the CALLER must add
  // at end-of-document as a second replacement (second undo step, see top).
  function insertFootnote(value, s, e) {
    var re = /\[\^(\d+)\]/g;
    var max = 0;
    var m;
    while ((m = re.exec(value)) !== null) {
      var n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
    var label = "[^" + (max + 1) + "]";
    return {
      start: s,
      end: e,
      text: label,
      selStart: s + label.length,
      selEnd: s + label.length,
      append: "\n\n" + label + ": ",
    };
  }

  // --- Links / images ---------------------------------------------------------

  function makeLink(value, s, e) {
    var sel = value.slice(s, e);
    var text;
    var selStart;
    var selEnd;
    if (s !== e && URL_RE.test(sel)) {
      // A bare URL becomes the target; the placeholder label gets selected.
      text = "[text](" + sel + ")";
      selStart = s + 1;
      selEnd = s + 5;
    } else if (s !== e) {
      // The selection becomes the label; the url placeholder gets selected.
      text = "[" + sel + "](url)";
      selStart = s + sel.length + 3;
      selEnd = selStart + 3;
    } else {
      text = "[text](url)";
      selStart = s + 1;
      selEnd = s + 5;
    }
    return { start: s, end: e, text: text, selStart: selStart, selEnd: selEnd };
  }

  function makeImage(value, s, e) {
    var alt = s === e ? "alt" : value.slice(s, e);
    var text = "![" + alt + "](https://)";
    var urlStart = s + 2 + alt.length + 2; // past "![" + alt + "]("
    return {
      start: s,
      end: e,
      text: text,
      selStart: urlStart,
      selEnd: urlStart + "https://".length,
    };
  }

  // --- List Enter / Tab behavior --------------------------------------------------

  // Enter on a list line: item with content continues the list (ordered
  // increments, task inserts an unchecked box); a marker-only item deletes
  // its marker (exit the list); a non-list line returns null (native Enter).
  function listContinuation(value, selStart) {
    var line = lineRangeAt(value, selStart);
    var text = value.slice(line.start, line.end);
    var m = text.match(LIST_RE);
    if (!m) return null;
    // Caret before or inside the indent/marker: native Enter (splicing a
    // continuation marker mid-marker would corrupt the line).
    if (selStart < line.start + m[0].length) return null;
    if (text.slice(m[0].length) === "") {
      return {
        start: line.start,
        end: line.end,
        text: "",
        selStart: line.start,
        selEnd: line.start,
      };
    }
    var marker = m[2];
    var om = marker.match(/^(\d+)([.)])$/);
    var next = om ? parseInt(om[1], 10) + 1 + om[2] : marker;
    var insert = "\n" + m[1] + next + " " + (m[3] ? "[ ] " : "");
    return {
      start: selStart,
      end: selStart,
      text: insert,
      selStart: selStart + insert.length,
      selEnd: selStart + insert.length,
    };
  }

  // Tab / Shift-Tab: indent or outdent list lines by their marker width
  // (2 for "- ", 3 for "1. ", 4 for "10. "). Null when ANY covered line is
  // not a list line — the caller must then let native Tab move focus (a11y).
  function listIndent(value, s, e, dir) {
    var region = coveredLineRange(value, s, e);
    var lines = value.slice(region.start, region.end).split("\n");
    var out = [];
    var firstDelta = 0;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(LIST_RE);
      if (!m) return null;
      var width = m[2].length + 1;
      if (dir > 0) {
        out.push(" ".repeat(width) + lines[i]);
        if (i === 0) firstDelta = width;
      } else {
        var strip = 0;
        while (strip < width && lines[i].charAt(strip) === " ") strip++;
        out.push(lines[i].slice(strip));
        if (i === 0) firstDelta = -strip;
      }
    }
    var text = out.join("\n");
    // Outdent that strips nothing (all lines already at zero indent) must
    // fall through to native Shift+Tab, or keyboard users have no way to
    // move focus out of an all-list document (and the no-op replacement
    // would burn an undo step).
    if (dir < 0 && text === value.slice(region.start, region.end)) return null;
    if (s === e) {
      var caret = Math.max(region.start, s + firstDelta);
      return {
        start: region.start,
        end: region.end,
        text: text,
        selStart: caret,
        selEnd: caret,
      };
    }
    return fullLineInstruction(region, text);
  }

  // --- Draft storage key -----------------------------------------------------------

  function draftKey(pubkey, mode, slug) {
    // Mode is namespaced into the key: a post whose d-tag happens to be
    // "new" must never share draft storage with the new-post composer.
    return (
      "nb-draft:v1:" + pubkey + ":" + (mode === "edit" ? "edit:" + slug : "new")
    );
  }

  globalThis.NbreadEditorMd = {
    wrapInline: wrapInline,
    toggleLinePrefix: toggleLinePrefix,
    cycleHeading: cycleHeading,
    orderedList: orderedList,
    codeFence: codeFence,
    insertTable: insertTable,
    insertFootnote: insertFootnote,
    insertRule: insertRule,
    makeLink: makeLink,
    makeImage: makeImage,
    listContinuation: listContinuation,
    listIndent: listIndent,
    wordRangeAt: wordRangeAt,
    lineRangeAt: lineRangeAt,
    draftKey: draftKey,
  };
})();
