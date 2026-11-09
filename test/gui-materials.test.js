import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuiMaterialStore, GUI_MATERIAL_CAPABILITIES as limits } from "../src/gui-materials.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR42mNklAtgYGBgYmBgQFAACEIAdYij2wsAAAAASUVORK5CYII=", "base64");
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AI0AbHP/2Q==", "base64");
const webp = Buffer.from("UklGRjYAAABXRUJQVlA4ICoAAACwAQCdASoCAAMAAUAmJZgCdLoABGaAAP77jUv7g5cuIKMv3QZZwzmAAAA=", "base64");

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "cothink-material-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const ownerId = randomUUID();
  const store = createGuiMaterialStore(home);
  const descriptor = (bytes, mediaType = "text/plain") =>
    ({ ownerId, uploadId: randomUUID(), name: "同名附件", mediaType, byteLength: bytes.length, sha256: sha(bytes) });
  const put = async (bytes, mediaType) => {
    const request = descriptor(bytes, mediaType);
    store.begin(request);
    return store.publish({ ...request, body: bytes });
  };
  return { home, ownerId, store, descriptor, put };
}

test("lost begin/publish responses are recoverable by owner and original upload ID", async (t) => {
  const { home, ownerId, store, descriptor, put } = fixture(t);
  const bytes = Buffer.from("原样保存\r\n");
  const intent = descriptor(bytes);
  store.begin(intent);
  const reopened = createGuiMaterialStore(home);
  const [pending] = reopened.list({ ownerId });
  assert.equal(pending.status, "pending");
  assert.equal(pending.uploadId, intent.uploadId);
  assert.equal(reopened.begin(intent).id, pending.id);
  assert.throws(() => reopened.begin({ ...intent, sha256: sha(Buffer.from("changed")) }), { code: "MATERIAL_CONFLICT" });
  assert.throws(() => reopened.read({ ownerId, id: pending.id }), { code: "MATERIAL_NOT_FOUND" });
  await reopened.publish({ ...intent, body: bytes });
  const recovered = createGuiMaterialStore(home);
  const ready = recovered.query(intent);
  assert.equal(ready.status, "ready");
  assert.equal(ready.id, pending.id);
  assert.equal(ready.sha256, sha(bytes));
  assert.deepEqual(recovered.read({ ownerId, id: ready.id, sha256: ready.sha256 }).bytes, bytes);
  assert.deepEqual(await recovered.publish({ ...intent, body: bytes }), ready);
  await assert.rejects(recovered.publish({ ...intent, body: Buffer.alloc(bytes.length, 0x61) }), { code: "MATERIAL_CONFLICT" });
  const other = await put(Buffer.from("同名不同内容"));
  assert.equal(other.name, ready.name);
  assert.notEqual(other.id, ready.id);
  assert.deepEqual(recovered.resolve({ ownerId, materials: [other, ready] }).map((item) => item.manifest.id), [other.id, ready.id]);
});

test("owner isolation and cancellation never remove published bytes", async (t) => {
  const { home, ownerId, store, descriptor, put } = fixture(t);
  const ready = await put(Buffer.from("history"));
  const foreign = { ...ready, ownerId: randomUUID() };
  assert.equal(store.query(foreign), null);
  assert.deepEqual(store.list(foreign), []);
  assert.throws(() => store.read(foreign), { code: "MATERIAL_NOT_FOUND" });
  await assert.rejects(store.publish({ ...foreign, body: Buffer.from("history") }), { code: "MATERIAL_NOT_FOUND" });
  assert.equal(store.cancel(ready).status, "ready");
  assert.deepEqual(store.read(ready).bytes, Buffer.from("history"));

  const bytes = Buffer.from("late");
  const intent = descriptor(bytes);
  store.begin(intent);
  let unblock;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const sending = store.publish({ ...intent, body: (async function* () {
    yield bytes.subarray(0, 1);
    entered();
    await blocked;
    yield bytes.subarray(1);
  })() });
  await started;
  assert.equal(store.cancel(intent).status, "cancelled");
  unblock();
  await assert.rejects(sending, { code: "MATERIAL_CANCELLED" });
  const afterRestart = createGuiMaterialStore(home);
  const cancelled = afterRestart.query(intent);
  assert.equal(cancelled.status, "cancelled");
  assert.throws(() => afterRestart.read({ ownerId, id: cancelled.id }), { code: "MATERIAL_NOT_FOUND" });
});

test("failed or interrupted binary writes never create a readable attachment", async (t) => {
  const { store, descriptor } = fixture(t);
  const bytes = Buffer.from("text");
  const intent = descriptor(bytes);
  const pending = store.begin(intent);
  let pulls = 0;
  await assert.rejects(store.publish({ ...intent, body: (async function* () {
    pulls++;
    yield Buffer.from("excess");
    pulls++;
    yield bytes;
  })() }), { code: "MATERIAL_LIMIT" });
  assert.equal(pulls, 1);
  await assert.rejects(store.publish({ ...intent, body: bytes.subarray(0, 2) }), { code: "MATERIAL_CONFLICT" });
  const signal = new AbortController();
  await assert.rejects(store.publish({ ...intent, signal: signal.signal, body: (async function* () {
    yield bytes;
    signal.abort();
  })() }), { code: "MATERIAL_INTERRUPTED" });
  assert.equal(store.query(intent).status, "pending");
  assert.throws(() => store.read(pending), { code: "MATERIAL_NOT_FOUND" });
  assert.equal((await store.publish({ ...intent, body: [bytes.subarray(0, 1), bytes.subarray(1)] })).status, "ready");
});

test("only supported UTF-8 and decodable PNG/JPEG/WebP can publish", async (t) => {
  const { store, descriptor, put } = fixture(t);
  const bigPng = Buffer.from(png);
  bigPng.writeUInt32BE(5001, 16);
  bigPng.writeUInt32BE(5000, 20);
  for (const [bytes, type, code] of [
    [Buffer.from([0xff]), "text/plain", "MATERIAL_FORMAT"],
    [png, "image/jpeg", "MATERIAL_FORMAT"],
    [png.subarray(0, 24), "image/png", "MATERIAL_FORMAT"],
    [bigPng, "image/png", "MATERIAL_LIMIT"],
  ]) {
    const intent = descriptor(bytes, type);
    store.begin(intent);
    await assert.rejects(store.publish({ ...intent, body: bytes }), { code });
    assert.equal(store.query(intent).status, "pending");
  }
  assert.throws(() => store.begin(descriptor(png, "image/svg+xml")), { code: "MATERIAL_FORMAT" });
  for (const [bytes, type] of [[png, "image/png"], [jpeg, "image/jpeg"], [webp, "image/webp"]]) {
    const ready = await put(bytes, type);
    assert.deepEqual([ready.width, ready.height], [2, 3]);
    assert.deepEqual(store.read(ready).bytes, bytes);
  }
});

test("single-material and ordered draft limits use original byte counts", async (t) => {
  const { ownerId, store, descriptor, put } = fixture(t);
  assert.equal(limits.textBytes, 512 * 1024);
  assert.equal(limits.imageBytes, 4 * 1024 * 1024);
  const bytes = Buffer.from("one");
  const intent = descriptor(bytes);
  assert.throws(() => store.begin({ ...intent, byteLength: limits.textBytes + 1 }), { code: "MATERIAL_LIMIT" });
  assert.throws(() => store.begin({ ...intent, mediaType: "image/png", byteLength: limits.imageBytes + 1 }), { code: "MATERIAL_LIMIT" });
  const ready = await put(bytes);
  assert.throws(() => store.resolve({ ownerId, materials: Array(9).fill(ready) }), { code: "MATERIAL_LIMIT" });
  assert.throws(() => store.resolve({ ownerId, materials: [{ ...ready, sha256: sha(png) }] }), { code: "MATERIAL_CONFLICT" });
  const padded = Buffer.alloc(limits.imageBytes);
  png.copy(padded);
  const large = await put(padded, "image/png");
  assert.equal(store.resolve({ ownerId, materials: Array(4).fill(large) }).length, 4);
  assert.throws(() => store.resolve({ ownerId, materials: [...Array(4).fill(large), ready] }), { code: "MATERIAL_LIMIT" });
});

test("failed disk publication and corrupted retained bytes cannot masquerade as a ready material", async (t) => {
  const { home, store, descriptor } = fixture(t);
  const bytes = Buffer.from("persistent input");
  const intent = descriptor(bytes);
  const pending = store.begin(intent);

  // Inject one filesystem failure at the immutable publication boundary;
  // use the real store again when querying or explicitly retrying.
  const fs = createRequire(import.meta.url)("node:fs");
  const link = fs.linkSync;
  fs.linkSync = (from, to) => {
    if (to.includes(pending.id)) throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
    return link(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.publish({ ...intent, body: bytes }), { code: "MATERIAL_STORAGE" });
  } finally {
    fs.linkSync = link;
    syncBuiltinESMExports();
  }
  assert.equal(store.query(intent).status, "pending");
  assert.throws(() => store.read(pending), { code: "MATERIAL_NOT_FOUND" });
  const ready = await store.publish({ ...intent, body: bytes });
  const object = readdirSync(home, { recursive: true }).find((name) => name.endsWith(ready.id + ".material"));
  const location = join(home, object);
  const damaged = readFileSync(location);
  damaged[damaged.length - 1] ^= 1;
  writeFileSync(location, damaged);
  assert.throws(() => store.read(ready), { code: "MATERIAL_CORRUPT" });
  await assert.rejects(store.publish({ ...intent, body: bytes }), { code: "MATERIAL_CORRUPT" });
});

test("an error after atomic publication is unknown until the same upload is queried", async (t) => {
  const { home, store, descriptor } = fixture(t);
  const bytes = Buffer.from("commit acknowledgement");
  const intent = descriptor(bytes);
  const pending = store.begin(intent);
  const fs = createRequire(import.meta.url)("node:fs");
  const { linkSync, fsyncSync } = fs;
  let linked = false;
  fs.linkSync = (from, to) => {
    linkSync(from, to);
    if (to.includes(pending.id)) linked = true;
  };
  fs.fsyncSync = (fd) => {
    if (linked) throw Object.assign(new Error("fixture uncertain flush"), { code: "EIO" });
    return fsyncSync(fd);
  };
  syncBuiltinESMExports();
  try {
    if (process.platform === "win32") {
      // Windows has no directory flush in this storage contract.
      assert.equal((await store.publish({ ...intent, body: bytes })).status, "ready");
    } else {
      await assert.rejects(store.publish({ ...intent, body: bytes }), { code: "MATERIAL_UNKNOWN" });
    }
  } finally {
    Object.assign(fs, { linkSync, fsyncSync });
    syncBuiltinESMExports();
  }
  const reopened = createGuiMaterialStore(home);
  const ready = reopened.query(intent);
  assert.equal(ready.status, "ready");
  assert.equal(ready.id, pending.id);
  assert.deepEqual(reopened.read(ready).bytes, bytes);
});
