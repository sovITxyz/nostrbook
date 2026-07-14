// Redesign: the DOM-free markdown text-manipulation core behind the editor
// toolbar (public/js/editor-md.js). The IIFE is imported for its side effect
// (it assigns globalThis.NbreadEditorMd) and exercised directly — every
// returned instruction also goes through apply(), which asserts the
// byte-identity property: splicing `text` over [start, end) must leave every
// byte outside that range untouched.
import { describe, expect, it } from "vitest";
// @ts-ignore — plain browser IIFE, intentionally shipped without types
import "../../public/js/editor-md.js";

type Instr = {
  start: number;
  end: number;
  text: string;
  selStart: number;
  selEnd: number;
  append?: string;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const md = (globalThis as any).NbreadEditorMd as {
  wrapInline: (v: string, s: number, e: number, marker: string) => Instr | null;
  toggleLinePrefix: (v: string, s: number, e: number, prefix: string) => Instr;
  cycleHeading: (v: string, s: number, e: number) => Instr;
  orderedList: (v: string, s: number, e: number) => Instr;
  codeFence: (v: string, s: number, e: number) => Instr;
  insertTable: (v: string, s: number, e: number) => Instr;
  insertFootnote: (v: string, s: number, e: number) => Instr;
  insertRule: (v: string, s: number, e: number) => Instr;
  makeLink: (v: string, s: number, e: number) => Instr;
  makeImage: (v: string, s: number, e: number) => Instr;
  listContinuation: (v: string, selStart: number) => Instr | null;
  listIndent: (v: string, s: number, e: number, dir: number) => Instr | null;
  wordRangeAt: (v: string, pos: number) => { start: number; end: number };
  lineRangeAt: (v: string, pos: number) => { start: number; end: number };
  draftKey: (pubkey: string, mode: string, slug: string) => string;
};

/**
 * Splice an instruction into its input and assert the byte-identity
 * property: everything outside [start, end) survives unchanged.
 */
function apply(value: string, instr: Instr): string {
  expect(instr.start).toBeGreaterThanOrEqual(0);
  expect(instr.end).toBeGreaterThanOrEqual(instr.start);
  expect(instr.end).toBeLessThanOrEqual(value.length);
  const out = value.slice(0, instr.start) + instr.text + value.slice(instr.end);
  expect(out.slice(0, instr.start)).toBe(value.slice(0, instr.start));
  expect(out.slice(instr.start + instr.text.length)).toBe(value.slice(instr.end));
  // The final selection must land inside the new document.
  expect(instr.selStart).toBeGreaterThanOrEqual(0);
  expect(instr.selEnd).toBeGreaterThanOrEqual(instr.selStart);
  expect(instr.selEnd).toBeLessThanOrEqual(out.length);
  return out;
}

describe("editor-md is loaded", () => {
  it("assigns the API to globalThis", () => {
    expect(md).toBeDefined();
    expect(typeof md.wrapInline).toBe("function");
  });
});

describe("wrapInline", () => {
  const MARKERS = ["**", "_", "~~", "==", "`"];

  for (const marker of MARKERS) {
    it(`wraps and unwraps a selection with ${JSON.stringify(marker)}`, () => {
      const wrap = md.wrapInline("hello world", 0, 5, marker)!;
      expect(apply("hello world", wrap)).toBe(`${marker}hello${marker} world`);
      // Selection covers the inner text.
      expect(wrap.selStart).toBe(marker.length);
      expect(wrap.selEnd).toBe(marker.length + 5);

      // Selecting the wrapped run whole toggles it back off.
      const wrapped = `${marker}hello${marker} world`;
      const unwrap = md.wrapInline(wrapped, 0, 5 + 2 * marker.length, marker)!;
      expect(apply(wrapped, unwrap)).toBe("hello world");
    });

    it(`unwraps via immediate surroundings for ${JSON.stringify(marker)}`, () => {
      const m = marker.length;
      const value = `${marker}hello${marker} world`;
      const instr = md.wrapInline(value, m, m + 5, marker)!; // "hello" selected
      expect(instr.start).toBe(0);
      expect(instr.end).toBe(5 + 2 * m);
      expect(apply(value, instr)).toBe("hello world");
    });
  }

  it("expands a collapsed caret to the word under it", () => {
    const instr = md.wrapInline("hello world", 2, 2, "**")!;
    expect(instr).toMatchObject({ start: 0, end: 5, text: "**hello**" });
    expect(apply("hello world", instr)).toBe("**hello** world");
  });

  it("caret inside an already-wrapped word unwraps it", () => {
    const instr = md.wrapInline("**hello**", 4, 4, "**")!;
    expect(apply("**hello**", instr)).toBe("hello");
  });

  it("inserts an empty pair on whitespace and removes it on second press", () => {
    const first = md.wrapInline("a  b", 2, 2, "**")!;
    expect(first).toMatchObject({ start: 2, end: 2, text: "****", selStart: 4 });
    const afterFirst = apply("a  b", first);
    expect(afterFirst).toBe("a **** b");

    const second = md.wrapInline(afterFirst, 4, 4, "**")!;
    expect(second).toMatchObject({ start: 2, end: 6, text: "" });
    expect(apply(afterFirst, second)).toBe("a  b");
  });

  it("inline code goes backtick-aware when the selection contains a backtick", () => {
    const value = "run `x` now";
    const instr = md.wrapInline(value, 0, value.length, "`")!;
    // Double-backtick delimiters, space-padded per CommonMark.
    expect(instr.text).toBe("`` run `x` now ``");
    expect(instr.selStart).toBe(3);
    expect(instr.selEnd).toBe(3 + value.length);
  });

  it("unwraps a space-padded double-backtick code span", () => {
    const value = "`` a`b ``";
    const instr = md.wrapInline(value, 0, value.length, "`")!;
    expect(apply(value, instr)).toBe("a`b");
  });

  it("code toggle round-trips a backtick-containing selection", () => {
    const value = "run a`b now";
    const wrap = md.wrapInline(value, 4, 7, "`")!;
    const wrapped = apply(value, wrap);
    expect(wrapped).toBe("run `` a`b `` now");
    // Second press on the (still-selected) inner text must unwrap via the
    // padded surroundings, not double-wrap.
    const unwrap = md.wrapInline(wrapped, wrap.selStart, wrap.selEnd, "`")!;
    expect(apply(wrapped, unwrap)).toBe(value);
  });

  it("plain inline code keeps single backticks", () => {
    const instr = md.wrapInline("word", 0, 4, "`")!;
    expect(instr.text).toBe("`word`");
  });
});

describe("cycleHeading", () => {
  it("cycles none -> ## -> ### -> #### -> none", () => {
    let v = "text";
    v = apply(v, md.cycleHeading(v, 0, 0));
    expect(v).toBe("## text");
    v = apply(v, md.cycleHeading(v, 0, 0));
    expect(v).toBe("### text");
    v = apply(v, md.cycleHeading(v, 0, 0));
    expect(v).toBe("#### text");
    v = apply(v, md.cycleHeading(v, 0, 0));
    expect(v).toBe("text");
  });

  it("enters the cycle from an existing '# '", () => {
    expect(apply("# text", md.cycleHeading("# text", 3, 3))).toBe("## text");
  });

  it("clears level-5+ headings back to body text", () => {
    expect(apply("##### deep", md.cycleHeading("##### deep", 0, 0))).toBe("deep");
  });

  it("only touches the caret's line", () => {
    const v = "a\nb\nc";
    expect(apply(v, md.cycleHeading(v, 2, 2))).toBe("a\n## b\nc");
  });
});

describe("toggleLinePrefix", () => {
  it("quotes every covered line and unquotes when all are quoted", () => {
    const on = md.toggleLinePrefix("a\nb", 0, 3, "> ");
    expect(apply("a\nb", on)).toBe("> a\n> b");
    const off = md.toggleLinePrefix("> a\n> b", 0, 7, "> ");
    expect(apply("> a\n> b", off)).toBe("a\nb");
  });

  it("adds only to the missing lines of a mixed selection", () => {
    const instr = md.toggleLinePrefix("> a\nb", 0, 5, "> ");
    expect(apply("> a\nb", instr)).toBe("> a\n> b");
  });

  it("bullets recognize * and + as already-bulleted", () => {
    const v = "* a\n+ b";
    const instr = md.toggleLinePrefix(v, 0, v.length, "- ");
    expect(apply(v, instr)).toBe("a\nb"); // all present -> remove
  });

  it("bullet add skips already-bulleted lines", () => {
    const instr = md.toggleLinePrefix("- a\nb", 0, 5, "- ");
    expect(apply("- a\nb", instr)).toBe("- a\n- b");
  });

  it("task toggle converts existing bullets and boxes plain lines", () => {
    const v = "- a\nb";
    const instr = md.toggleLinePrefix(v, 0, v.length, "- [ ] ");
    expect(apply(v, instr)).toBe("- [ ] a\n- [ ] b");
  });

  it("removing task boxes preserves text for checked AND unchecked items", () => {
    const v = "- [x] done\n- [ ] todo";
    const instr = md.toggleLinePrefix(v, 0, v.length, "- [ ] ");
    expect(apply(v, instr)).toBe("done\ntodo");
  });

  it("skips blank lines inside the selection", () => {
    const v = "a\n\nb";
    const instr = md.toggleLinePrefix(v, 0, v.length, "> ");
    expect(apply(v, instr)).toBe("> a\n\n> b");
  });

  it("a selection ending at a line start does not drag the next line in", () => {
    const v = "a\nb";
    const instr = md.toggleLinePrefix(v, 0, 2, "> "); // ends just past "a\n"
    expect(apply(v, instr)).toBe("> a\nb");
  });
});

describe("orderedList", () => {
  it("numbers plain lines 1. 2. 3.", () => {
    const v = "a\nb\nc";
    expect(apply(v, md.orderedList(v, 0, v.length))).toBe("1. a\n2. b\n3. c");
  });

  it("renumbers a partially/gappily numbered selection", () => {
    const v = "1. a\n5. b\nc";
    expect(apply(v, md.orderedList(v, 0, v.length))).toBe("1. a\n2. b\n3. c");
  });

  it("toggles off when every line is numbered, even with gaps", () => {
    const v = "2. a\n7. b";
    expect(apply(v, md.orderedList(v, 0, v.length))).toBe("a\nb");
  });

  it("converts bullets into numbers", () => {
    const v = "- a\n- b";
    expect(apply(v, md.orderedList(v, 0, v.length))).toBe("1. a\n2. b");
  });

  it("numbers nested lists independently per indent level", () => {
    const v = "- a\n- b\n  - b1\n  - b2\n- c";
    expect(apply(v, md.orderedList(v, 0, v.length))).toBe(
      "1. a\n2. b\n  1. b1\n  2. b2\n3. c",
    );
  });

  it("a shallower line resets deeper counters", () => {
    const v = "- a\n  - a1\n- b\n  - b1";
    expect(apply(v, md.orderedList(v, 0, v.length))).toBe(
      "1. a\n  1. a1\n2. b\n  1. b1",
    );
  });
});

describe("listContinuation (Enter)", () => {
  it("continues an ordered list with the incremented number", () => {
    const instr = md.listContinuation("1. one", 6)!;
    expect(instr.text).toBe("\n2. ");
    expect(apply("1. one", instr)).toBe("1. one\n2. ");
  });

  it("keeps the ) delimiter and the indent", () => {
    expect(md.listContinuation("3) x", 4)!.text).toBe("\n4) ");
    expect(md.listContinuation("  - a", 5)!.text).toBe("\n  - ");
  });

  it("task items continue with an UNCHECKED box", () => {
    const instr = md.listContinuation("- [x] done", 10)!;
    expect(instr.text).toBe("\n- [ ] ");
  });

  it("a marker-only item exits the list by deleting its marker", () => {
    const instr = md.listContinuation("x\n- ", 4)!;
    expect(instr).toMatchObject({ start: 2, end: 4, text: "" });
    expect(apply("x\n- ", instr)).toBe("x\n");
  });

  it("returns null on a non-list line", () => {
    expect(md.listContinuation("hello", 3)).toBeNull();
  });

  it("returns null with the caret before or inside the marker", () => {
    // "- foo": marker span is [0, 2). Caret at line start, mid-marker, and
    // at the last marker byte must all fall through to native Enter.
    expect(md.listContinuation("- foo", 0)).toBeNull();
    expect(md.listContinuation("- foo", 1)).toBeNull();
    expect(md.listContinuation("x\n  10. y", 6)).toBeNull();
    // First position AFTER the marker is a normal continuation again.
    expect(md.listContinuation("- foo", 2)).not.toBeNull();
  });
});

describe("listIndent (Tab / Shift-Tab)", () => {
  it("indents by 2 for '- '", () => {
    const instr = md.listIndent("- a", 0, 0, 1)!;
    expect(apply("- a", instr)).toBe("  - a");
  });

  it("indents by 4 for '10. '", () => {
    const instr = md.listIndent("10. a", 0, 0, 1)!;
    expect(apply("10. a", instr)).toBe("    10. a");
  });

  it("outdents by up to the marker width", () => {
    const instr = md.listIndent("  - a", 4, 4, -1)!;
    expect(apply("  - a", instr)).toBe("- a");
  });

  it("Tab on a non-list line returns null (native focus behavior)", () => {
    expect(md.listIndent("hello", 0, 0, 1)).toBeNull();
  });

  it("returns null when ANY covered line is not a list line", () => {
    const v = "- a\nplain";
    expect(md.listIndent(v, 0, v.length, 1)).toBeNull();
  });

  it("Shift+Tab at zero indent returns null (keyboard exit, no no-op undo)", () => {
    expect(md.listIndent("- a", 3, 3, -1)).toBeNull();
    expect(md.listIndent("- a\n- b", 0, 7, -1)).toBeNull();
    // Mixed depths still outdent: at least one line strips spaces.
    const v = "- a\n  - b";
    expect(apply(v, md.listIndent(v, 0, v.length, -1)!)).toBe("- a\n- b");
  });
});

describe("insertFootnote", () => {
  it("numbers from 1 with no existing footnotes", () => {
    const instr = md.insertFootnote("hello", 5, 5);
    expect(instr.text).toBe("[^1]");
    expect(instr.append).toBe("\n\n[^1]: ");
    expect(apply("hello", instr)).toBe("hello[^1]");
  });

  it("uses max existing + 1, tolerating gaps", () => {
    const v = "x [^1] y [^7]";
    const instr = md.insertFootnote(v, v.length, v.length);
    expect(instr.text).toBe("[^8]");
    expect(instr.append).toBe("\n\n[^8]: ");
  });
});

describe("block inserts — hr / table / fence", () => {
  it("hr in the middle claims exactly one blank line each side", () => {
    const instr = md.insertRule("a\nb", 1, 1);
    expect(apply("a\nb", instr)).toBe("a\n\n---\n\nb");
  });

  it("hr at document start has nothing above it", () => {
    expect(apply("abc", md.insertRule("abc", 0, 0))).toBe("---\n\nabc");
  });

  it("hr at document end trails a single newline", () => {
    expect(apply("abc", md.insertRule("abc", 3, 3))).toBe("abc\n\n---\n");
  });

  it("hr reuses existing newlines instead of stacking more", () => {
    expect(apply("a\n\n", md.insertRule("a\n\n", 3, 3))).toBe("a\n\n---\n");
  });

  it("hr keeps bytes outside the splice on input starting with a newline", () => {
    const v = "\nabc";
    const instr = md.insertRule(v, 0, 0);
    expect(apply(v, instr)).toBe("---\n\nabc"); // apply() asserts byte identity
  });

  it("table inserts the 2-col skeleton with the first header cell selected", () => {
    const instr = md.insertTable("", 0, 0);
    expect(apply("", instr)).toBe(
      "| Column 1 | Column 2 |\n| --- | --- |\n|   |   |\n",
    );
    expect(instr.selStart).toBe(2);
    expect(instr.selEnd).toBe(2 + "Column 1".length);
  });

  it("empty fence puts the caret after the opening backticks for a language", () => {
    const instr = md.codeFence("", 0, 0);
    expect(apply("", instr)).toBe("```\n\n```\n");
    expect(instr.selStart).toBe(3);
    expect(instr.selEnd).toBe(3);
  });

  it("fence with a selection wraps the covered lines", () => {
    const v = "a\ncode\nb";
    const instr = md.codeFence(v, 2, 6);
    expect(apply(v, instr)).toBe("a\n```\ncode\n```\nb");
    expect(instr.selStart).toBe(5); // right after the opening ```
  });
});

describe("makeLink / makeImage", () => {
  it("a bare URL selection becomes the target with the label selected", () => {
    const v = "https://a.example/x";
    const instr = md.makeLink(v, 0, v.length);
    expect(apply(v, instr)).toBe("[text](https://a.example/x)");
    expect(instr.selStart).toBe(1);
    expect(instr.selEnd).toBe(5); // "text"
  });

  it("a text selection becomes the label with the url placeholder selected", () => {
    const instr = md.makeLink("read this", 5, 9);
    expect(apply("read this", instr)).toBe("read [this](url)");
    expect(instr.selEnd - instr.selStart).toBe(3); // "url"
  });

  it("no selection inserts the full placeholder with the label selected", () => {
    const instr = md.makeLink("", 0, 0);
    expect(apply("", instr)).toBe("[text](url)");
  });

  it("image uses the selection as alt and selects the URL slot", () => {
    const instr = md.makeImage("cat pic", 0, 7);
    expect(apply("cat pic", instr)).toBe("![cat pic](https://)");
    expect(instr.selStart).toBe(11);
    expect(instr.selEnd).toBe(11 + "https://".length);
  });
});

describe("wordRangeAt / lineRangeAt", () => {
  it("finds the word around a position", () => {
    expect(md.wordRangeAt("foo bar", 5)).toEqual({ start: 4, end: 7 });
    expect(md.wordRangeAt("foo bar", 3)).toEqual({ start: 0, end: 3 });
  });

  it("finds line boundaries excluding the newline", () => {
    expect(md.lineRangeAt("a\nbc\nd", 3)).toEqual({ start: 2, end: 4 });
    expect(md.lineRangeAt("a\nbc\nd", 0)).toEqual({ start: 0, end: 1 });
    expect(md.lineRangeAt("a\nbc\nd", 6)).toEqual({ start: 5, end: 6 });
  });
});

describe("draftKey", () => {
  it("edit mode namespaces the slug under 'edit:'", () => {
    expect(md.draftKey("pk123", "edit", "my-slug")).toBe(
      "nb-draft:v1:pk123:edit:my-slug",
    );
  });

  it("new mode always keys on the literal 'new'", () => {
    expect(md.draftKey("pk123", "new", "")).toBe("nb-draft:v1:pk123:new");
    expect(md.draftKey("pk123", "new", "ignored")).toBe("nb-draft:v1:pk123:new");
  });

  it("a post whose d-tag is 'new' cannot collide with the composer", () => {
    expect(md.draftKey("pk123", "edit", "new")).not.toBe(
      md.draftKey("pk123", "new", ""),
    );
  });
});

describe("byte-identity property on newline-leading inputs", () => {
  it("holds for every action on a document starting with \\n", () => {
    const v = "\nfirst\n- item\n";
    const instrs = [
      md.wrapInline(v, 2, 2, "**"),
      md.toggleLinePrefix(v, 1, 6, "> "),
      md.cycleHeading(v, 1, 1),
      md.orderedList(v, 1, 6),
      md.codeFence(v, 1, 6),
      md.insertTable(v, 6, 6),
      md.insertFootnote(v, 6, 6),
      md.insertRule(v, 6, 6),
      md.makeLink(v, 1, 6),
      md.makeImage(v, 1, 6),
      md.listContinuation(v, 13),
      md.listIndent(v, 8, 8, 1),
    ];
    for (const instr of instrs) {
      expect(instr).not.toBeNull();
      apply(v, instr as Instr); // asserts identity outside [start, end)
    }
  });
});
