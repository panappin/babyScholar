import { getDocumentProxy, getResolvedPDFJS } from "unpdf";

const parserOptions = {
  disableAutoFetch: true,
  disableFontFace: true,
  disableRange: true,
  disableWorker: true,
  enableXfa: false,
  isEvalSupported: false,
  maxImageSize: 16_777_216,
  stopAtErrors: true,
  useSystemFonts: false,
};

function textFromContent(content) {
  return content.items.map((item) => {
    const value = typeof item.str === "string" ? item.str : "";
    return item.hasEOL ? `${value}\n` : value;
  }).join("");
}

export default {
  async fetch(request) {
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    let pdf;
    try {
      pdf = await getDocumentProxy(new Uint8Array(await request.arrayBuffer()), parserOptions);
      const pages = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        pages.push({ pageNumber, text: textFromContent(await page.getTextContent()) });
        page.cleanup();
      }
      const pdfjs = await getResolvedPDFJS();
      return Response.json({ pageCount: pdf.numPages, pages, parserVersion: pdfjs.version });
    } finally {
      await pdf?.loadingTask.destroy();
    }
  },
};
