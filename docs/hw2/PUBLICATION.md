# Publication note

This branch publishes the complete baseline code and assessment from local commit
`12cf96c8aea564355e86c96b4d2493e4ad00d23e`, with one evidence-file exception:
`docs/hw2/evidence/coverage-final.json` (787,075 bytes) is not included in the
remote branch because the large connector request could not complete reliably.
The complete file is preserved in that local commit and can be regenerated with
`npm run test:coverage`. The published per-file `coverage-summary.json`,
`lcov.info`, test logs, CPU profile, and all other assessment evidence are retained.
No application source or test behavior was changed for publication.
