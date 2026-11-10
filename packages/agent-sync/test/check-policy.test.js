import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAgentSync } from "../src/index.js";
import { backend, begin, replace, accept } from "./helpers/repository.js";

const { execution, imageId } = JSON.parse(
  readFileSync(new URL("../execution-manifest.json", import.meta.url)),
);
const nodeCheck = (source) => [{ command: "node", args: ["-e", source] }];
const choose = (id, digest) => ({ id, digest });

test("one owner checks overlapping drafts with distinct frozen policies on the latest composition", async (t) => {
  const checkPolicies = {
    A: nodeCheck("process.exit(require('node:fs').readFileSync('a.txt','utf8') === 'ready A' ? 0 : 17)"),
    B: nodeCheck("const fs = require('node:fs'); process.exit(fs.readFileSync('a.txt','utf8') === 'ready A' && fs.readFileSync('b.txt','utf8') !== 'fixed B' ? 41 : 0)"),
  };
  const { v, baseVersion } = await backend(t, { execution, checkPolicies });
  const policies = (await v.inspect()).checkPolicies ?? {};
  const aPolicy = choose("A", policies.A);
  const bPolicy = choose("B", policies.B);
  // A caller mutating the constructor input cannot replace approved check commands.
  checkPolicies.B[0].args[1] = "process.exit(0)";
  const [a, b] = await Promise.all([
    begin(v, "a", ["a.txt"], { readScope: ["a.txt"], checkPolicy: aPolicy }),
    begin(v, "b", ["b.txt"], { readScope: ["b.txt"], checkPolicy: bPolicy }),
  ]);
  assert.equal(a.baseVersion, baseVersion);
  assert.equal(b.baseVersion, baseVersion);
  assert.notEqual(a.changeId, b.changeId);
  await Promise.all([
    replace(v, a, "a.txt", "ready A", "edit-a"),
    replace(v, b, "b.txt", "bad B", "edit-b"),
  ]);
  const pb = await v.prepareChange(b.changeId, { requestId: "pb", check: true });
  const ra = await accept(v, a, "aa");
  assert.equal(ra.status, "accepted");
  const denied = await v.acceptChange({
    changeId: b.changeId,
    candidateVersion: pb.candidateVersion,
    requestId: "ab",
  });
  assert.equal(denied.status, "check_failed");
  assert.equal(denied.checks[0].exitCode, 41);
  assert.equal(denied.binding.expectedTip, ra.acceptedVersion);
  assert.equal(denied.binding.policy, bPolicy.digest);
  assert.equal(denied.binding.image, imageId);
  assert.equal((await v.inspect()).version, ra.acceptedVersion);
  assert.equal(pb.candidates.at(-1).precheck.verification, "passed");
  assert.equal(pb.candidates.at(-1).precheck.binding.policy, bPolicy.digest);
  assert.equal(ra.verification, "passed");
  assert.deepEqual(ra.checkPolicy, aPolicy);
  assert.deepEqual(await v.inspect({ requestId: "aa" }), ra);

  const defaultCheck = await v.checkCurrent({ requestId: "default-check" });
  assert.equal(defaultCheck.verification, "unverified");
  const checked = await v.checkCurrent({ requestId: "check-b", checkPolicy: bPolicy });
  assert.equal(checked.status, "check_failed");
  assert.equal(checked.checks[0].exitCode, 41);
  assert.equal(checked.version, ra.acceptedVersion);
  await assert.rejects(v.checkCurrent({ requestId: "check-b", checkPolicy: aPolicy }), { code: "REQUEST_MISMATCH" });

  await replace(v, b, "b.txt", "fixed B", "repair-b");
  const rb = await accept(v, b, "ab-fixed");
  assert.equal(rb.status, "accepted");
  assert.equal(rb.verification, "passed");
  assert.deepEqual(rb.checkPolicy, bPolicy);
  assert.equal(rb.expectedTip, ra.acceptedVersion);
  assert.equal((await v.inspect()).version, rb.acceptedVersion);
  for (const [path, expected] of [["a.txt", "ready A"], ["b.txt", "fixed B"]]) {
    const file = await v.read({ version: rb.acceptedVersion, path });
    assert.equal(Buffer.from(file.contentBase64, "base64").toString(), expected);
  }
  assert.deepEqual(await v.checkCurrent({ requestId: "check-b", checkPolicy: bPolicy }), checked);
  const after = await v.checkCurrent({ requestId: "check-b-after", checkPolicy: bPolicy });
  assert.equal(after.status, "passed");
  assert.equal(after.version, rb.acceptedVersion);
});

test("request identity binds approved policy IDs and digests, and changed owner configuration fails closed", async (t) => {
  const checkPolicies = { A: nodeCheck("process.exit(0)") };
  const { v, project, home, baseVersion } = await backend(t, { execution, checkPolicies });
  await assert.rejects(
    begin(v, "unknown-policy", ["a.txt"], { checkPolicy: choose("unknown", "0".repeat(64)) }),
    { code: "CHECK_POLICY" },
  );
  const aPolicy = choose("A", (await v.inspect()).checkPolicies.A);
  await assert.rejects(
    begin(v, "forged-policy", ["a.txt"], { checkPolicy: choose("A", "0".repeat(64)) }),
    { code: "CHECK_POLICY" },
  );
  await assert.rejects(
    begin(v, "raw-policy", ["a.txt"], { checkPolicy: { ...aPolicy, checks: checkPolicies.A } }),
    { code: "CHECK_POLICY" },
  );
  const a = await begin(v, "fixed-policy", ["a.txt"], { checkPolicy: aPolicy });
  assert.deepEqual(await begin(v, "fixed-policy", ["a.txt"], { checkPolicy: aPolicy }), a);
  await assert.rejects(
    begin(v, "fixed-policy", ["a.txt"], { checkPolicy: choose("A", "0".repeat(64)) }),
    { code: "REQUEST_MISMATCH" },
  );
  await replace(v, a, "a.txt", "draft", "edit");
  const p = await v.prepareChange(a.changeId, { requestId: "prepare" });
  assert.equal(p.candidates.at(-1).policy, aPolicy.digest);
  await v.close();

  const next = await createAgentSync({
    project, home, execution, checkPolicies: { A: nodeCheck("process.exit(9)") },
  });
  t.after(() => next.close());
  assert.notEqual((await next.inspect()).checkPolicies.A, aPolicy.digest);
  assert.deepEqual(
    await begin(next, "fixed-policy", ["a.txt"], { checkPolicy: aPolicy }),
    JSON.parse(JSON.stringify(a)),
  );
  await next.refreshChange(a.changeId, { requestId: "refresh", reason: "explicitly resume frozen draft" });
  await assert.rejects(next.prepareChange(a.changeId, { requestId: "prepare-drift" }), { code: "CHECK_POLICY" });
  await assert.rejects(next.acceptChange({
    changeId: a.changeId,
    candidateVersion: p.candidateVersion,
    requestId: "accept-drift",
  }), { code: "CHECK_POLICY" });
  await assert.rejects(next.checkCurrent({ requestId: "check-drift", checkPolicy: aPolicy }), { code: "CHECK_POLICY" });
  assert.equal((await next.inspect()).version, baseVersion);
});
