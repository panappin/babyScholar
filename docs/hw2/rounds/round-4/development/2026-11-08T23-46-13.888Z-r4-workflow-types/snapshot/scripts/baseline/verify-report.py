"""Check PDF text/links/page bounds and render every page for visual review.

Verification-only dependencies: pypdf and PyMuPDF. An optional third argument
adds a task-local pip --target directory to sys.path. No OCR/model is used.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

if len(sys.argv) > 3:
    sys.path.insert(0, str(Path(sys.argv[3]).resolve()))
import pypdf
import pymupdf

root = Path(__file__).resolve().parents[2]
source = (root / (sys.argv[1] if len(sys.argv) > 1 else "docs/hw2/report.pdf")).resolve()
output = (root / (sys.argv[2] if len(sys.argv) > 2 else "artifacts/hw2-report-verification")).resolve()
output.mkdir(parents=True, exist_ok=False)
reader = pypdf.PdfReader(source)
document = pymupdf.open(source)
pages = []
links = []
outside = []
for index, page in enumerate(document):
    text = reader.pages[index].extract_text()
    assert len(text.strip()) > 80, f"Blank or almost empty page {index + 1}"
    assert not re.search(r"\{\{[A-Z_]+\}\}", text), "Unresolved report placeholder"
    for word in page.get_text("words"):
        rectangle = pymupdf.Rect(word[:4])
        if not (page.rect + (-1, -1, 1, 1)).contains(rectangle):
            outside.append({"page": index + 1, "text": word[4], "rectangle": list(rectangle)})
    for link in page.get_links():
        if link.get("uri"):
            assert link["uri"].startswith("https://"), f"Nonportable PDF link: {link['uri']}"
            links.append({"page": index + 1, "uri": link["uri"]})
    filename = f"page-{index + 1:02}.png"
    page.get_pixmap(dpi=120).save(output / filename)
    pages.append({"page": index + 1, "characters": len(text), "image": filename, "width": page.rect.width, "height": page.rect.height})
    (output / f"page-{index + 1:02}.txt").write_text(text, encoding="utf-8")

all_text = "\n".join(page.extract_text() for page in reader.pages)
for section in ["1. Test Generation Approach", "2. Initial Test Evaluation", "3. Iterative Test Improvement",
                "4. Final Evaluation", "5. Reflection", "6. GitHub Repository"]:
    assert section in all_text, f"Missing section: {section}"
for required in ["260", "55.64%", "3.51%", "hw2/initial-baseline", "852eb2c", "2c83268"]:
    assert required in all_text, f"Missing final report evidence: {required}"
assert not outside, f"Text outside page bounds: {outside}"
assert len(links) >= 10, "Expected report evidence/repository hyperlinks"
result = {"result": "passed", "pdf": str(source.relative_to(root)), "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
          "pages": pages, "links": links, "outsidePageWords": outside,
          "pypdf": pypdf.__version__, "pymupdf": pymupdf.VersionBind,
          "note": "Text, portable link annotations, section presence and page bounds checked. Every rendered page still needs visual review."}
(output / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"result": "passed", "pages": len(pages), "links": len(links), "evidence": str(output)}))
