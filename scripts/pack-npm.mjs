/** Build a consumer tarball without leaking development-root override references. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.argv[2] ?? 'dist');
const npm = process.env.npm_execpath;
if (!npm) throw Error('Use npm run pack:npm -- <output-directory>');
const scratch = mkdtempSync(join(tmpdir(), 'cothink-npm-pack-'));
const run = (command, args, cwd) => execFileSync(command, args, {
  cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  // macOS bsdtar otherwise stores extended attributes as ._* AppleDouble files.
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});
try {
  if (process.platform === 'darwin') {
    execFileSync(process.execPath, [join(root, 'scripts/build-project-handoff.mjs')], {cwd:root,stdio:['ignore',2,2]});
  }
  // Fresh assets are mandatory, including when a previous dist already exists.
  execFileSync(process.execPath, [npm, 'run', 'build:skills'], { cwd: root, stdio: ['ignore', 2, 2] });
  execFileSync(process.execPath, [npm, 'run', 'build:gui'], { cwd: root, stdio: ['ignore', 2, 2] });
  mkdirSync(output, { recursive: true });
  const [packed] = JSON.parse(run(process.execPath,
    [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', scratch], root));
  run('tar', ['-xzf', packed.filename], scratch);
  const manifestPath = join(scratch, 'package', 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath));
  // These references are necessary when npm ci builds the locked SDK tree, but
  // npm 10 resolves them against the consumer's root during installation.
  // All dependencies have already been bundled; their bytes remain unchanged.
  delete manifest.overrides;
  // Optional explicitly prepared Linux runtime: ship the verified platform bytes,
  // never the source checkout, user data root, environment or authentication files.
  if(process.env.COTHINK_PACK_PLUGIN_RUNTIME) {
    const prepared=resolve(process.env.COTHINK_PACK_PLUGIN_RUNTIME);
    const proof=JSON.parse(readFileSync(join(prepared,'cothink-runtime.json')));
    if(proof.pi!=='1.4.0-cothink.3'||!/^linux\/(?:arm64|amd64)$/.test(proof.platform))throw Error('Unsupported prepared PROJECT runtime');
    if(createHash('sha256').update(readFileSync(join(prepared,'package-lock.json'))).digest('hex')!==proof.lockSha256)throw Error('Prepared runtime lock changed');
    const destination=join(scratch,'package/vendor/project-runtime');mkdirSync(destination,{recursive:true});
    run('tar',['-czf',join(destination,'runtime.tgz'),'node_modules','package.json','package-lock.json','cothink-runtime.json'],prepared);
    const archiveSha256=createHash('sha256').update(readFileSync(join(destination,'runtime.tgz'))).digest('hex');
    writeFileSync(join(destination,'manifest.json'),JSON.stringify({...proof,archiveSha256},null,2)+'\n');
  }
  // These platform artifacts are optional in the source template. The consumer
  // manifest describes the actual candidate, so absent artifacts are not claimed.
  const optionalArtifacts = new Set(['vendor/project-runtime', 'vendor/project-handoff']);
  manifest.files = manifest.files.filter(path => !optionalArtifacts.has(path) || existsSync(join(scratch, 'package', path)));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  run('tar', ['-czf', 'consumer.tgz', 'package'], scratch);
  const destination = join(output, basename(packed.filename));
  copyFileSync(join(scratch, 'consumer.tgz'), destination);
  const bytes = readFileSync(destination);
  console.log(JSON.stringify([{ filename: basename(destination), version: manifest.version,
    size: statSync(destination).size,
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    shasum: createHash('sha1').update(bytes).digest('hex'),
    sha256: createHash('sha256').update(bytes).digest('hex') }]));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
