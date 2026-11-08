/** Explicit build-time preparation; interactive startup never invokes a compiler. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

if (process.platform !== 'darwin') throw Error('The kernel-witness handoff backend currently requires macOS. No process-group fallback is built.');
const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'native/project-handoff-watch.c');
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const sourceSha256 = digest(source);
for (const [arch, clangArch] of [['arm64', 'arm64'], ['x64', 'x86_64']]) {
  const directory = join(root, 'vendor/project-handoff', `darwin-${arch}`);
  mkdirSync(directory, {recursive:true});
  const temporary = join(directory, `watch.build-${process.pid}`);
  try {
    execFileSync('/usr/bin/xcrun', ['clang', '-arch', clangArch, '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', temporary], {stdio:'inherit'});
    if (digest(source) !== sourceSha256) throw Error('Handoff watcher source changed during preparation');
    const sha256 = digest(temporary);
    renameSync(temporary, join(directory, 'watch'));
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({platform:'darwin',arch,sha256,sourceSha256}, null, 2)+'\n');
    console.log(JSON.stringify({platform:'darwin',arch,sha256,sourceSha256,built:true}));
  } finally {rmSync(temporary,{force:true});}
}
