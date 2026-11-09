import React from "react";

// Selected Lucide glyphs, https://lucide.dev (ISC).
// Copyright (c) 2022 Lucide Contributors.
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
// OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
// CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
const shapes = {
  search: [["circle",{cx:11,cy:11,r:8}],["path",{d:"m21 21-4.3-4.3"}]],
  plus: [["path",{d:"M12 5v14M5 12h14"}]],
  send: [["path",{d:"m5 12 7-7 7 7M12 19V5"}]],
  panel: [["rect",{x:3,y:3,width:18,height:18,rx:2}],["path",{d:"M9 3v18"}]],
  compose: [["path",{d:"M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M16 3l5 5M9 15l1-5L18 2a2.1 2.1 0 0 1 3 3l-8 8Z"}]],
  conversations: [["path",{d:"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"}]],
  team: [["path",{d:"M18 21a8 8 0 0 0-16 0"}],["circle",{cx:10,cy:8,r:5}],["path",{d:"M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"}]],
  settings: [["path",{d:"M20 7h-9M7 7H4M20 17h-3M13 17H4"}],["circle",{cx:9,cy:7,r:2}],["circle",{cx:15,cy:17,r:2}]],
  process: [["path",{d:"M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"}]],
  copy: [["rect",{x:8,y:8,width:12,height:12,rx:2}],["path",{d:"M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"}]],
  fork: [["circle",{cx:6,cy:6,r:2}],["circle",{cx:18,cy:6,r:2}],["circle",{cx:6,cy:18,r:2}],["path",{d:"M6 8v8M18 8a6 6 0 0 1-6 6H6"}]],
  more: [["circle",{cx:5,cy:12,r:1}],["circle",{cx:12,cy:12,r:1}],["circle",{cx:19,cy:12,r:1}]],
};

export function Icon({name, className = ""}) {
  return React.createElement("svg",{className:`ui-icon ${className}`,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:1.65,strokeLinecap:"round",strokeLinejoin:"round","aria-hidden":true,focusable:false},
    shapes[name].map(([tag,props],key)=>React.createElement(tag,{...props,key})));
}
