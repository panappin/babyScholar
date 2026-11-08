# Round 1 development evaluation

Command, before the full comparison run:

```powershell
npm.cmd test -- --reporter=default --reporter=json --outputFile=artifacts/hw2-development/round-1/tests-1.json
```

Exit 0; 106/106 tests passed in four files. The 82 added cases passed on their
first focused invocation. [Structured test results](tests-1.json) retain every
test name and status; [console output](tests-1.log) retains the execution log.
There were no failed development assertions to suppress or reclassify here.
Coverage and legacy stage comparison use the subsequent full `npm.cmd run
baseline` invocation, not this focused run.
