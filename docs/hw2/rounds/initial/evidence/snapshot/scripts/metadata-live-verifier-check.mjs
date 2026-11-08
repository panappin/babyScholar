import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const verifier = resolve(root, "scripts/metadata-live-check.mjs");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runScenario(scenario, expectedExitCode) {
  const child = spawn(process.execPath, [verifier, `--offline=${scenario}`], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exitCode = await new Promise((done, fail) => { child.once("error", fail); child.once("close", done); });
  assert.equal(exitCode, expectedExitCode, `Offline ${scenario} verifier exit code.`);
  const evidencePath = /Metadata live-check evidence: (.+)$/mu.exec(output)?.[1]?.trim();
  assert.ok(evidencePath, `Offline ${scenario} verifier did not report an evidence path.`);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(await exists(resolve(dirname(evidencePath), "state")), false, `Offline ${scenario} retained its owned runtime state.`);
  return { evidence, evidencePath };
}

const success = await runScenario("success", 0);
assert.equal(success.evidence.result, "passed");
assert.equal(success.evidence.offlineProviderRequests, 1);
assert.deepEqual(success.evidence.diagnostics.persistence, {
  postStatus: 201,
  postErrorKind: null,
  getStatus: 200,
  getErrorKind: null,
  getMatchesPostMetadata: true,
});
assert.deepEqual(success.evidence.diagnostics.cache, {
  keyDisabledByCli: true,
  getStatus: 200,
  getErrorKind: null,
  cachedPostStatus: 200,
  cachedPostErrorKind: null,
  cachedPostCreated: false,
  cachedPostMatchesInitial: true,
});

const fieldMismatch = await runScenario("field-mismatch", 1);
assert.equal(fieldMismatch.evidence.result, "failed");
assert.deepEqual(fieldMismatch.evidence.failure, { name: "AssertionError", stage: "fixture-field-comparison" });
assert.equal(fieldMismatch.evidence.diagnostics.fieldMismatch, "title");
assert.equal(fieldMismatch.evidence.diagnostics.persistence.getStatus, 200);
assert.equal(fieldMismatch.evidence.diagnostics.persistence.getMatchesPostMetadata, true);
assert.equal(fieldMismatch.evidence.diagnostics.lastAssertion.name, "fixture-field-match:title");

const applicationError = await runScenario("application-error", 0);
assert.equal(applicationError.evidence.result, "passed");
assert.deepEqual(applicationError.evidence.diagnostics.persistence, {
  postStatus: 502,
  postErrorKind: "metadata_provider_failure",
  getStatus: 404,
  getErrorKind: "metadata_not_found",
  getMatchesPostMetadata: false,
});
assert.equal(applicationError.evidence.offlineProviderRequests, 1);

console.log(JSON.stringify({
  check: "metadata-live-verifier-offline",
  scenarios: ["success", "field-mismatch", "application-error"],
  successEvidence: success.evidencePath,
  fieldMismatchEvidence: fieldMismatch.evidencePath,
  applicationErrorEvidence: applicationError.evidencePath,
}));
