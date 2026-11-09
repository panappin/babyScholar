# Final PDF handoff

The [editable report](report.md) and [verified PDF](report.pdf) use the six sections supplied by the user:

1. Test Generation Approach
2. Initial Test Evaluation
3. Iterative Test Improvement
4. Final Evaluation
5. Reflection
6. GitHub Repository

Before submitting the PDF:

- Review the findings and supply your own personal reflection, especially why
  you chose to continue beyond the initial low-coverage result. The analysis
  is agent-authored; it does not invent your experience or motives.
- Keep the initial/round-1/final comparison, the strong versus weak UTF-8
  examples, representative prompts, and the distinction between product bugs,
  stale tests, test syntax/fixture errors, selected artificial faults, the two
  confirmed local-probe defects, and the unresolved earlier browser stalls.
- Review the browser qualification: a successful normal baseline and the
  earlier preview pass do not explain intermittent development-server stalls.
- Add your verified name and course identifiers. Git author metadata alone
  does not establish the required formal report identity or course section.
  The supplied rubric specifies no page count, template or extra formatting.
- After editing the reflection or other text, regenerate the PDF with
  `node scripts/baseline/render-report.mjs` and inspect the updated pages.
- Confirm the HW2 branch and final test suite are visible in the Homework 1
  GitHub repository, and submit the reviewed PDF yourself by **10 PM EST on
  November 8, 2026**, the cutoff you supplied. Confirm any portal requirements.

The current PDF has 7 pages. Every page was visually inspected; the tables,
code blocks, Unicode text and page numbers are legible, with no clipping or
overlap. Automated checks confirmed all six rubric sections, extracted text,
23 portable hyperlink annotations and no text outside page bounds. The
[verification record](pdf-verification.json) contains the PDF/source hashes,
renderer command, library versions, link targets and visual-review record.
Relative repository targets exist locally and are converted to branch URLs.

Optional repeatable PDF verification (Python 3.13 was used; these are separate
from app/test dependencies):

```powershell
py -m pip install --target artifacts/hw2-pdf-tools pypdf==6.7.3 PyMuPDF==2.1
py scripts/baseline/verify-report.py docs/hw2/report.pdf artifacts/hw2-report-verification/my-review artifacts/hw2-pdf-tools
```

Use a fresh verification output directory; the script refuses to overwrite
one. Inspect its page PNGs after regeneration. No assignment submission or
merge to `main` is performed. Committed evidence includes per-file CSV/JSON,
LCOV, raw coverage, logs, profiles, snapshots and integrity manifests; complete
HTML coverage and transient runtime fixtures remain in ignored local artifacts.
