/**
 * Small original PDF fixtures for local Worker checks. They are generated here
 * instead of copied from a corpus, so their source is this file and their
 * license is CC0-1.0. They deliberately use only basic PDF 1.4 constructs.
 */
import { createHash } from "node:crypto";

const encoder = new TextEncoder();
const PASSWORD_PADDING = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41,
  0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
  0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function bytes(value) {
  return typeof value === "string" ? encoder.encode(value) : value;
}

function concat(parts) {
  const normalized = parts.map(bytes);
  const size = normalized.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of normalized) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function latin1(value) {
  const output = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) output[index] = value.charCodeAt(index) & 0xff;
  return output;
}

function hex(value) {
  return Array.from(value, (item) => item.toString(16).padStart(2, "0")).join("");
}

function md5(value) {
  return new Uint8Array(createHash("md5").update(value).digest());
}

function rc4(key, value) {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  let cursor = 0;
  for (let index = 0; index < 256; index += 1) {
    cursor = (cursor + state[index] + key[index % key.length]) & 0xff;
    [state[index], state[cursor]] = [state[cursor], state[index]];
  }
  const output = new Uint8Array(value.length);
  let left = 0;
  let right = 0;
  for (let index = 0; index < value.length; index += 1) {
    left = (left + 1) & 0xff;
    right = (right + state[left]) & 0xff;
    [state[left], state[right]] = [state[right], state[left]];
    output[index] = value[index] ^ state[(state[left] + state[right]) & 0xff];
  }
  return output;
}

function paddedPassword(password) {
  const raw = encoder.encode(password);
  return concat([raw.slice(0, 32), PASSWORD_PADDING.slice(0, Math.max(0, 32 - raw.length))]);
}

function objectKey(encryptionKey, objectNumber) {
  return md5(concat([
    encryptionKey,
    Uint8Array.of(objectNumber & 0xff, (objectNumber >> 8) & 0xff, (objectNumber >> 16) & 0xff, 0, 0),
  ])).slice(0, Math.min(encryptionKey.length + 5, 16));
}

function streamObject(content) {
  return concat([`<< /Length ${content.byteLength} >>\nstream\n`, content, "\nendstream"]);
}

function buildPdf(objects, trailer = "") {
  const chunks = [latin1("%PDF-1.4\n%\xff\xff\xff\xff\n")];
  const offsets = [0];
  let offset = chunks[0].byteLength;
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(offset);
    const object = concat([`${index + 1} 0 obj\n`, objects[index], "\nendobj\n"]);
    chunks.push(object);
    offset += object.byteLength;
  }
  const xrefOffset = offset;
  const xref = ["xref\n", `0 ${objects.length + 1}\n`, "0000000000 65535 f \n"];
  for (let index = 1; index < offsets.length; index += 1) xref.push(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`);
  xref.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailer} >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return concat([...chunks, xref.join("")]);
}

function textStream(value) {
  const literal = value.replace(/[\\()]/g, "\\$&");
  return streamObject(latin1(`BT /F1 18 Tf 72 720 Td (${literal}) Tj ET`));
}

function multiLineTextStream(lines) {
  const operators = lines.map((line) => `(${line.replace(/[\\()]/g, "\\$&")}) Tj 0 -22 Td`).join(" ");
  return streamObject(latin1(`BT /F1 14 Tf 72 720 Td ${operators} ET`));
}

export function createTextPdfFixture() {
  const first = "First page phrase: alpha";
  const second = "Second page phrase: Caf\u00e9";
  const secondContent = concat([
    "BT /F1 18 Tf 72 720 Td (Second page phrase: Caf",
    Uint8Array.of(0xe9),
    ") Tj ET",
  ]);
  return {
    bytes: buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
      textStream(first),
      streamObject(secondContent),
    ]),
    expected: { first, second },
  };
}

export function createMetadataPdfFixture() {
  // Exactly 600 UTF-8 bytes: a boundary fixture for short evidence quotes.
  const multibyteEvidenceWords = [...Array(198).fill("\u00e9"), "\u00e9abcd"];
  const multibyteEvidenceQuote = multibyteEvidenceWords.join(" ");
  // Keep individual PDF text-showing operations short so the fixture exercises
  // the application's whitespace normalization rather than PDF layout width.
  const multibyteEvidenceLines = Array.from(
    { length: Math.ceil(multibyteEvidenceWords.length / 16) },
    (_, index) => multibyteEvidenceWords.slice(index * 16, (index + 1) * 16).join(" "),
  );
  const expected = {
    title: "Source-Grounded Metadata Fixture",
    authors: ["Avery Example", "Bao Example"],
    year: 2024,
    abstract: "This controlled fixture evaluates source-grounded bibliographic metadata extraction.",
  };
  return {
    bytes: buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
      multiLineTextStream([
        expected.title,
        "Authors: Avery Example; Bao Example",
        "Published: 2024",
        "Abstract: This controlled fixture evaluates",
        "source-grounded bibliographic metadata extraction.",
        ...multibyteEvidenceLines,
      ]),
      multiLineTextStream(["This second page is retained as ordered source text."]),
    ]),
    expected,
    multibyteEvidenceQuote,
  };
}

/** A CC0 fixture with presentation-only line-end hyphens and a real compound. */
export function createWrappedMetadataPdfFixture() {
  const expected = {
    title: "Wrapped Metadata Fixture",
    authors: ["Avery Example", "Bao Example"],
    year: 2024,
    abstract: "This controlled interpretation evaluates state-of-the-art performance on 17 source-grounded records.",
  };
  return {
    bytes: buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
      multiLineTextStream([
        expected.title,
        "Authors: Avery Example; Bao Example",
        "Published: 2024",
        "Abstract: This controlled interpreta-",
        "tion evaluates state-of-the-art per-",
        "formance on 17 source-grounded records.",
      ]),
    ]),
    expected,
  };
}

/** CC0 fixture whose WinAnsi line-end en/em dashes must remain literal. */
export function createDashBoundaryPdfFixture() {
  const expected = {
    title: "Dash Boundary Fixture",
    authors: ["Avery Example"],
    year: 2024,
    abstract: "This en–\ndash and em—\ndash remain literal.",
  };
  return {
    bytes: buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
      multiLineTextStream([
        expected.title,
        "Authors: Avery Example",
        "Published: 2024",
        "Abstract: This en\x96",
        "dash and em\x97",
        "dash remain literal.",
      ]),
    ]),
    expected,
  };
}

export function createMetadataClippedPdfFixture() {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 8 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 9 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 10 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 11 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    textStream("Clipping fixture page one"),
    textStream("Clipping fixture page two"),
    textStream("Clipping fixture page three"),
    textStream("Clipping fixture page four must not reach metadata"),
  ]);
}

export function createImageOnlyPdfFixture() {
  const image = Uint8Array.of(0xff);
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
    concat(["<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n", image, "\nendstream"]),
    streamObject("q 100 0 0 100 72 600 cm /Im0 Do Q"),
  ]);
}

export function createPageLimitPdfFixture(pageCount = 101) {
  const firstPageObject = 4;
  const pageReferences = Array.from({ length: pageCount }, (_, index) => `${firstPageObject + index} 0 R`).join(" ");
  const pages = Array.from({ length: pageCount }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 3 0 R >>");
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageReferences}] /Count ${pageCount} >>`,
    streamObject(""),
    ...pages,
  ]);
}

export function createTextLimitPdfFixture() {
  // PDF.js deliberately caps a *single* simple-font text operator without
  // standard-font data. Many ordinary operators prove the accumulated UTF-8
  // limit instead of relying on that parser-specific per-item behavior.
  const operators = Array.from({ length: 13_000 }, (_unused, index) => {
    const x = 72 + index / 10_000;
    return `1 0 0 1 ${x} 720 Tm (AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA) Tj`;
  }).join(" ");
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    streamObject(latin1(`BT /F1 12 Tf 72 720 Td ${operators} ET`)),
  ]);
}

export function createEncryptedPdfFixture() {
  const fileId = md5(encoder.encode("babyScholar-phase-3b-encrypted-fixture"));
  const ownerKey = md5(paddedPassword("owner")).slice(0, 5);
  const owner = rc4(ownerKey, paddedPassword("user"));
  const permissions = -4;
  const permissionBytes = Uint8Array.of(0xfc, 0xff, 0xff, 0xff);
  const encryptionKey = md5(concat([paddedPassword("user"), owner, permissionBytes, fileId])).slice(0, 5);
  const user = rc4(encryptionKey, PASSWORD_PADDING);
  const protectedContent = rc4(objectKey(encryptionKey, 6), latin1("BT /F1 18 Tf 72 720 Td (Protected text) Tj ET"));
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Producer (fixture) >>",
    streamObject(protectedContent),
    `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${hex(owner)}> /U <${hex(user)}> /P ${permissions} >>`,
  ], ` /Encrypt 7 0 R /ID [<${hex(fileId)}> <${hex(fileId)}>]`);
}

export function createCorruptPdfFixture() {
  return latin1("%PDF-1.4\nthis is not a valid PDF body\n%%EOF\n");
}

export function createSignatureOnlyPdfFixture() {
  return latin1("%PDF-1.7\n");
}
