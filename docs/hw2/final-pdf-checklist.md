# Final review and submission

Use [report.pdf](report.pdf) for submission and [report.md](report.md) as the
editable source. The report includes the six supplied rubric sections, the
verified name **Pranav Anappindi**, course **CS593 ASE**, and the author's
revised reflection. The original supplied revision remains unchanged in
[author-revision.md](rounds/final-review/author-revision.md).

Before submitting:

- Read the PDF, particularly the first-person reflection, independent terminal
  rerun account and AI disclosure. Confirm these represent your experience.
- Confirm the report identity/course and any submission-portal requirements.
  The available assignment record is the six-section rubric in
  [improvement-request.md](improvement-request.md); no separate original
  assignment document was supplied for this final pass.
- Retain the distinction between three confirmed, fixed product defects,
  corrected test weaknesses, unresolved earlier browser intermittency,
  selected artificial faults, and the separate dependency audit. Eight affected
  development-package entries are not eight new bugs found by the HW2 tests.
- Confirm the final branch and report are visible on GitHub. Submit the PDF
  yourself before **10:30 PM EST, November 8, 2026**. The agent neither submits
  the assignment nor merges to main.

The final PDF uses the repository renderer, with locked Marked and installed
Chromium. [pdf-verification.json](pdf-verification.json) records the exact
source/PDF hashes, render command, page count, portable links, automated bounds
checks and visual inspection of every page. Relative repository links are
validated before rendering and resolve to the HW2 branch on GitHub.

If you change the editable source, regenerate and reinspect the PDF:

```powershell
node scripts/baseline/render-report.mjs
py scripts/baseline/verify-report.py docs/hw2/report.pdf artifacts/hw2-report-verification/my-review artifacts/hw2-pdf-tools
```

Use a fresh verification output directory. This checkout already has the
verification-only Python packages under ignored `artifacts/hw2-pdf-tools`;
on another machine, install `pypdf==6.7.3` and `PyMuPDF==2.1` separately from
application dependencies. Inspect all generated page PNGs after regeneration.

Historical prompts, failed runs, per-file coverage, selected faults and bug
reproductions remain unchanged. New review/evaluation records are under
`rounds/final-review/`. Raw runtime directories, generated HTML coverage,
user-supplied ZIPs and original transfer files are not part of the final commit.
