# Final PDF handoff

The [editable report](report.md) and [verified PDF](report.pdf) use the six sections supplied by the user:

1. Test Generation Approach
2. Initial Test Evaluation
3. Iterative Test Improvement
4. Final Evaluation
5. Reflection
6. GitHub Repository

Before submitting the PDF:

- Review the findings and personalize the reflection. It is currently an
  agent-authored account, not a claim about the student's personal experience.
- Keep the initial/round-1/final comparison, the strong versus weak UTF-8
  examples, representative prompts, and the distinction between product bugs,
  stale tests, a test syntax error, seeded faults, and the local proxy timeout.
- Review the browser qualification: the final normal baseline and separate
  preview both passed, while earlier development-server stalls remain unexplained.
- Add course/student identifiers if required by the submission portal. The
  supplied rubric specifies no page count, template or additional formatting.
- After editing the reflection or other text, regenerate the PDF with
  `node scripts/baseline/render-report.mjs` and inspect the updated pages.
- Confirm the HW2 branch and final test suite are visible in the Homework 1
  GitHub repository, and submit the PDF yourself by the course deadline.

The current PDF has six pages. All six were visually inspected; both tables,
code blocks, Unicode text and page numbers are legible, with no clipping or
overlap. Automated checks confirmed all six rubric sections, extracted text,
18 portable hyperlink annotations and no text outside page bounds. The
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
