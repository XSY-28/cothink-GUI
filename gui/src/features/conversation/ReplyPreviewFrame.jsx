import React, {useRef} from "react";

export function ReplyPreviewFrame({source}) {
  const sent=useRef(false);
  function load(event) {
    if(sent.current)return;
    sent.current=true;
    // The sandbox has an opaque origin. Only send the selected block, once.
    event.currentTarget.contentWindow.postMessage(source,"*");
  }
  return <iframe className="reply-preview-frame" title="网页预览" sandbox="allow-scripts"
    referrerPolicy="no-referrer" src="/reply-preview.html" onLoad={load}/>;
}
