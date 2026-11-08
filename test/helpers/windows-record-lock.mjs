// Run the real OS boundary in a fresh process, independent of test-runner fs/platform mocks.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const helperStarted = performance.now(), holdMs = Number(process.argv[2]);
const powershell = process.env.COTHINK_TEST_POWERSHELL || 'powershell.exe';
const trace = (phase, detail = {}) => process.stderr.write(JSON.stringify({
  fixture: 'windows-record-lock', phase, holdMs, elapsedMs: performance.now() - helperStarted, ...detail,
}) + '\n');
trace('helper-start', { platform: process.platform, powershell });
const { writePrivateJson } = await import(process.env.COTHINK_TEST_CLI
  ? pathToFileURL(resolve(dirname(process.env.COTHINK_TEST_CLI), '../src/storage.js')).href
  : new URL('../../src/storage.js', import.meta.url).href);
trace('storage-loaded');
assert.equal(process.platform, 'win32');
assert.ok([400, 3000].includes(holdMs));
const dir = fs.mkdtempSync(join(tmpdir(), 'cothink-native-record-'));
const dest = join(dir, '中文 request.json');
fs.writeFileSync(dest, JSON.stringify({ text: 'old saved answer' }));
// Resolve the sleep API before taking the handle: first-use PowerShell cmdlet
// loading after LOCKED would make a nominal 400ms hold last much longer.
const script = "[Console]::Error.WriteLine('LOCKER_SCRIPT_READY'); $duration=[int]$env:COTHINK_TEST_LOCK_MS; [Threading.Thread]::Sleep(0); $clock=[Diagnostics.Stopwatch]::new(); $s=[IO.File]::Open($env:COTHINK_TEST_LOCK_PATH,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); $clock.Start(); [Console]::WriteLine('LOCKED'); [Threading.Thread]::Sleep($duration); $s.Dispose(); $clock.Stop(); [Console]::WriteLine('RELEASED:'+$clock.ElapsedMilliseconds)";
trace('locker-starting');
const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
  env: { ...process.env, COTHINK_TEST_LOCK_PATH: dest, COTHINK_TEST_LOCK_MS: String(holdMs) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '', stderr = '', lockError;
child.once('spawn', () => trace('locker-spawned', { pid: child.pid }));
child.once('exit', (code, signal) => trace('locker-exited', { code, signal }));
const closed = new Promise(resolve => child.once('close', (code, signal) => {
  trace('locker-closed', { code, signal }); resolve(code);
}));
child.stderr.on('data', d => { stderr += d; trace('locker-stderr', { text: String(d) }); });
try {
  await new Promise((resolve, reject) => {
    child.once('error', error => { trace('locker-error', { message: error.message }); reject(error); });
    child.stdout.on('data', d => {
      stdout += d; trace('locker-stdout', { text: String(d) });
      if (stdout.includes('LOCKED')) resolve();
    });
    child.once('close', () => { if (!stdout.includes('LOCKED')) reject(Error(stderr || 'locker exited before ready')); });
  });
  trace('lock-observed');
  assert.throws(() => fs.renameSync(dest, dest + '.probe'), e => {
    lockError = e.code;
    return ['EPERM', 'EACCES', 'EBUSY'].includes(e.code);
  }, 'the actual OS must reject rename while the lock is held');
  trace('save-starting');
  const started = performance.now();
  let saveError;
  try {
    if (holdMs === 400) writePrivateJson(dest, { text: '完整新回答' });
    else assert.throws(() => writePrivateJson(dest, { text: 'not published' }), e => ['EPERM', 'EACCES', 'EBUSY'].includes(e.code));
  } catch (error) { saveError = error; }
  const operationMs = performance.now() - started;
  trace('save-finished', { operationMs, error: saveError?.code });
  if (holdMs === 400) { trace('waiting-for-locker-close'); await closed; }
  const observedHoldMs = Number(stdout.match(/RELEASED:(\d+)/)?.[1]) || null;
  console.log(JSON.stringify({ platform: process.platform, holdMs, observedHoldMs,
    lockError, operationMs, updated: !saveError && holdMs === 400,
    oldBytesPreserved: !saveError && holdMs === 3000 }));
  if (saveError) throw saveError;
  if (holdMs === 400) assert.ok(observedHoldMs >= 400 && observedHoldMs < 1060,
    'short lock fixture must actually release within the unchanged rename budget');
  const text = JSON.parse(fs.readFileSync(dest)).text;
  assert.equal(text, holdMs === 400 ? '完整新回答' : 'old saved answer');
  assert.deepEqual(fs.readdirSync(dir), ['中文 request.json']);
} finally {
  trace('cleanup-starting');
  child.kill();
  await closed;
  fs.rmSync(dir, { recursive: true, force: true });
  trace('cleanup-finished');
}
