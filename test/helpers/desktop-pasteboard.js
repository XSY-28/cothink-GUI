import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

export async function preservePasteboard(marker, run) {
 // Keep every representation in memory, including images and Finder items.
 // Restore only if our unique fixture text is still on the pasteboard.
 const helper = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
  ObjC.import('AppKit');
  function run(argv) {
   const pasteboard = $.NSPasteboard.generalPasteboard;
   const saved = $.NSMutableArray.alloc.init;
   for (const original of pasteboard.pasteboardItems.js || []) {
    const item = $.NSPasteboardItem.alloc.init;
    for (const type of original.types.js) {
     if (!item.setDataForType(original.dataForType(type), type))
      throw Error('Cannot preserve this pasteboard representation');
    }
    saved.addObject(item);
   }
   $.NSFileHandle.fileHandleWithStandardOutput.writeData($('ready\\n').dataUsingEncoding($.NSUTF8StringEncoding));
   $.NSFileHandle.fileHandleWithStandardInput.readDataOfLength(1);
   if (ObjC.unwrap(pasteboard.stringForType($.NSPasteboardTypeString))?.includes(argv[0])) {
    pasteboard.clearContents;
    if (saved.count && !pasteboard.writeObjects(saved)) throw Error('Could not restore the pasteboard');
   }
  }
 `, marker], {stdio:['pipe','pipe','inherit']});
 const exited = once(helper, 'exit');
 await Promise.race([
  once(helper.stdout, 'data'),
  exited.then(([code]) => { throw Error(`Pasteboard preservation could not start (${code})`); }),
 ]);
 try {
  await run();
 } finally {
  helper.stdin.end();
  assert.deepEqual(await exited, [0, null], 'the original pasteboard was preserved');
 }
}
