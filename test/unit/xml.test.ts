import { describe, expect, it } from "vitest";

import {
  InvalidXmlCharacterError,
  cdataSection,
  escapeXmlAttribute,
  escapeXmlText,
  normalizeLineEndings,
} from "../../src/worker/services/xml";

/** "a<char>b" where <char> is the given code unit (avoids raw control bytes in source). */
function around(codeUnit: number): string {
  return `a${String.fromCharCode(codeUnit)}b`;
}

describe("escapeXmlText", () => {
  it("escapes ampersands and angle brackets", () => {
    expect(escapeXmlText("Tom & Jerry <cat> >_<")).toBe("Tom &amp; Jerry &lt;cat&gt; &gt;_&lt;");
  });

  it("escapes an already-escaped-looking entity again", () => {
    expect(escapeXmlText("&amp;")).toBe("&amp;amp;");
  });

  it("leaves quotes and apostrophes alone in text content", () => {
    expect(escapeXmlText(`say "hi" y'all`)).toBe(`say "hi" y'all`);
  });

  it("passes emoji through unchanged", () => {
    expect(escapeXmlText("mic check 🎙️🔥")).toBe("mic check 🎙️🔥");
  });

  it("passes non-Latin text through unchanged", () => {
    expect(escapeXmlText("ポッドキャスト 播客 팟캐스트 подкаст")).toBe(
      "ポッドキャスト 播客 팟캐스트 подкаст",
    );
  });

  it("normalizes CRLF and CR line endings to LF", () => {
    expect(escapeXmlText("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("allows tab and newline control characters", () => {
    expect(escapeXmlText("a\tb\nc")).toBe("a\tb\nc");
  });

  it("rejects XML-1.0-invalid control characters", () => {
    for (const codeUnit of [0x00, 0x01, 0x08, 0x0b, 0x0c, 0x0e, 0x1f, 0xfffe, 0xffff]) {
      expect(() => escapeXmlText(around(codeUnit))).toThrow(InvalidXmlCharacterError);
    }
  });

  it("rejects lone surrogates but accepts well-formed surrogate pairs", () => {
    expect(() => escapeXmlText(around(0xd800))).toThrow(InvalidXmlCharacterError);
    expect(() => escapeXmlText(around(0xdfff))).toThrow(InvalidXmlCharacterError);
    expect(escapeXmlText("a\u{1f399}b")).toBe("a\u{1f399}b"); // studio microphone emoji
  });
});

describe("escapeXmlAttribute", () => {
  it("escapes quotes and apostrophes in addition to text escapes", () => {
    expect(escapeXmlAttribute(`a & <b> "c" 'd'`)).toBe(
      "a &amp; &lt;b&gt; &quot;c&quot; &apos;d&apos;",
    );
  });

  it("rejects invalid control characters", () => {
    expect(() => escapeXmlAttribute(around(0x00))).toThrow(InvalidXmlCharacterError);
  });
});

describe("cdataSection", () => {
  it("wraps plain content without escaping markup", () => {
    expect(cdataSection("<p>hello & bye</p>")).toBe("<![CDATA[<p>hello & bye</p>]]>");
  });

  it("splits a ]]> sequence so no section terminates early", () => {
    expect(cdataSection("a]]>b")).toBe("<![CDATA[a]]]]><![CDATA[>b]]>");
  });

  it("splits repeated ]]> sequences", () => {
    expect(cdataSection("]]>]]>")).toBe("<![CDATA[]]]]><![CDATA[>]]]]><![CDATA[>]]>");
  });

  it("rejects invalid control characters", () => {
    expect(() => cdataSection(around(0x0b))).toThrow(InvalidXmlCharacterError);
  });
});

describe("normalizeLineEndings", () => {
  it("converts CRLF and lone CR to LF", () => {
    expect(normalizeLineEndings("a\r\nb\rc\nd\r\n")).toBe("a\nb\nc\nd\n");
  });
});
