/**
 * XML string helpers (mvp-design.md section 13.4).
 *
 * Every string that enters the generated RSS document passes through one of
 * these helpers; nothing is ever concatenated into XML unescaped. Input line
 * endings are normalized to "\n" and characters that are invalid in XML 1.0
 * are rejected rather than silently dropped.
 */

/**
 * Characters that may never appear in an XML 1.0 document: C0 controls other
 * than tab/LF/CR, the non-characters U+FFFE/U+FFFF, and lone surrogates.
 * With the `u` flag the surrogate range matches only unpaired surrogates;
 * well-formed pairs are seen as single supplementary code points.
 */
const INVALID_XML_CHARS = new RegExp(
  // eslint-disable-next-line no-control-regex
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u{D800}-\\u{DFFF}\\u{FFFE}\\u{FFFF}]",
  "u",
);

/** Thrown when input contains a character that XML 1.0 cannot represent. */
export class InvalidXmlCharacterError extends Error {
  constructor() {
    super("Input contains a character that is not valid in XML 1.0");
    this.name = "InvalidXmlCharacterError";
  }
}

/** Normalizes CRLF and lone CR line endings to LF. */
export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/** Line-normalizes, then rejects XML-1.0-invalid characters. */
function prepare(value: string): string {
  const normalized = normalizeLineEndings(value);
  if (INVALID_XML_CHARS.test(normalized)) {
    throw new InvalidXmlCharacterError();
  }
  return normalized;
}

/** Escapes a string for use as XML element text content. */
export function escapeXmlText(value: string): string {
  return prepare(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Escapes a string for use inside a double- or single-quoted XML attribute. */
export function escapeXmlAttribute(value: string): string {
  return prepare(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Wraps a string in a CDATA section. A literal "]]>" inside the content
 * would terminate the section early, so it is split across two sections
 * ("]]" ends the first, ">" starts the second).
 */
export function cdataSection(value: string): string {
  return `<![CDATA[${prepare(value).replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}
