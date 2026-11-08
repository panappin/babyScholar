# HW2 improvement request and protocol

User instruction, received November 8, 2026 (verbatim):

```text
Read docs/hw2/README.md and docs/hw2/initial-assessment.md. This is for HW2 on the BabyScholar repo.

First verify we are on the branch containing the initial baseline. Run npm ci and npm run baseline, preserving its timestamped results. The existing metadata verifier has a stale version expectation; the browser check may depend on the environment. Diagnose actual failures instead of treating them automatically as product bugs.

Then perform two distinct, guided test-improvement rounds:
1. Use the initial results and source coverage to choose important missing behavior and edge cases. Add tests and rerun the evaluation.
2. Use round 1's actual results and remaining coverage gaps to guide a different second improvement. Add tests and rerun.

Preserve the exact prompts/instructions, test results, per-file coverage and explanations for each round. Use the same coverage scope and commands for a fair comparison. Review whether tests assert the real product requirements, and report genuine existing bugs separately from test or environment failures. Do not invent defects or require citations where the app contract does not.

Summarize initial vs final coverage, test correctness and fault detection, plus limitations. Commit the changes and tell me what remains for the final PDF. Don't submit the assignment or merge into main.
```

## Execution protocol

- Baseline branch: `hw2/initial-baseline`; initial commit
  `e2f5c9768aaef353156cbb8249df804383d58da8`.
- Application source tree: `2b735d17bc59c5e714dee91c837f05ead0a5d30d`.
- Run `npm.cmd ci`, then `npm.cmd run baseline` on Windows. Each invocation
  uses the harness's new timestamped directory; do not overwrite a prior run.
- Keep `vitest.config.ts`, dependency versions, source scope, profile inputs,
  and baseline stage commands unchanged. Run the full baseline after each
  round; label focused diagnostics separately.
- Freeze a round's instruction before implementing it. The instructions are
  the primary agent's recorded self-guidance, not additional user messages or
  retrospective claims about an unseen model prompt. No agents are delegated.
- Use native Request/ReadableStream and deterministic fake clocks where useful.
  Test literal limits and independently specified outputs, including success
  and rejection cases. Keep all provider/runtime integration fixtures offline.
- Archive raw logs, exact test snapshots, configuration, per-file coverage,
  profile output, and verifier diagnostics. Preserve the prior Linux evidence
  unchanged and compare the three new runs on this Windows machine.
- Report stale assertions and environment failures separately from product
  defects. A passing regression or seeded fault is not a discovered product bug.
- Current README and source contracts take precedence over superseded entries
  in the development history, especially optional citations and quote matching.
- Commit only this task's changes. Leave unrelated untracked hosting artifacts
  alone. The subsequent rubric clarification requires the final suite on GitHub;
  push only this HW2 branch. Do not submit, deploy, or merge into `main`.

## Rubric clarification (verbatim)

Agent question:

```text
If the HW2 rubric specifies the six report sections or PDF formatting requirements, please share that text. I’ll continue the test rounds and evidence collection in the meantime.
```

User reply:

```text
Yes. The assignment specifies these six PDF report sections. You can pass this directly to Codex:
1. Test Generation Approach: Describe the initial instructions to the agent, the number and types of tests, and functionality targeted.
2. Initial Test Evaluation: Report coverage and execution results; discuss incorrect tests, weak assertions and missed functionality; document detected bugs or explicitly state none were found.
3. Iterative Test Improvement: Explain how the agent was guided in each iteration, give representative prompts/context or execution feedback, and explain the test changes and why they were needed.
4. Final Evaluation: Report final coverage, correctness and detected bugs; compare initial and final results, preferably in a table; discuss which improvements worked and which did not.
5. Reflection: Discuss the agent’s understanding, what tests it generated well or struggled with, the value of extra context and feedback, and lessons about coding agents’ strengths and limitations.
6. GitHub Repository: Link the repo, identify the final test suite’s location, and provide dependency installation, test execution and coverage reproduction instructions.
The report must be a PDF, but the assignment does not specify a page count, template or other formatting. It requires concrete evidence, including results, coverage and examples of agent interactions. Significant manual interventions should be described. The final test suite must be pushed to the Homework 1 repository by the deadline.
```
