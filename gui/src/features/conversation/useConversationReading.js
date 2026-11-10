import { useEffect, useLayoutEffect, useRef } from "react";

export function useConversationReading({session,inert,readingPosition,recordView}) {
  const scroll = useRef(null);
  const reading = useRef({position:null,following:true,seen:new Set()});
  const anchorTimer = useRef(null), writeView = useRef(recordView);
  writeView.current = recordView;
  function recordVisible() {
    const root = scroll.current;
    if (!root || !session || inert || document.visibilityState !== "visible" || root.closest("[inert]") || !root.clientHeight) return;
    const viewport = root.getBoundingClientRect();
    for (const node of root.querySelectorAll("[data-result-revision]")) {
      const box = node.getBoundingClientRect();
      if (box.bottom <= viewport.top || box.top >= viewport.bottom || box.height === 0) continue;
      const {taskId,resultRevision} = node.dataset;
      const key = taskId + resultRevision;
      if (session.view?.seenResults[taskId] === resultRevision || reading.current.seen.has(key)) continue;
      reading.current.seen.add(key);
      void writeView.current(session.id,{seen:{taskId,resultRevision}});
    }
  }
  function onScroll() {
    const root = scroll.current;
    if (!root || !session || inert || document.visibilityState !== "visible") return;
    reading.current.following = root.scrollHeight - root.clientHeight - root.scrollTop <= 36;
    recordVisible();
    const top = root.getBoundingClientRect().top;
    const region = [...root.querySelectorAll("[data-reading-part]")].find(node=>node.getBoundingClientRect().bottom > top);
    if (!region) return;
    const {taskId,readingPart:part} = region.dataset;
    const rect = region.getBoundingClientRect();
    const offsetPx = Math.round(Math.max(0,Math.min(top-rect.top,rect.height,2048)));
    if (anchorTimer.current) clearTimeout(anchorTimer.current.timer);
    const save = () => {void writeView.current(session.id,{anchor:{taskId,part,offsetPx}});};
    anchorTimer.current = {save,timer:setTimeout(()=>{
      anchorTimer.current=null;
      save();
    },250)};
  }
  useLayoutEffect(()=>{
    const root = scroll.current, position = readingPosition;
    if (!root || !session || position?.sessionId !== session.id) return;
    if (reading.current.position !== position) {
      const target = position.target;
      const node = target && [...root.querySelectorAll("[data-reading-part]")].find(node=>
        node.dataset.taskId === target.taskId && node.dataset.readingPart === target.part);
      if (target && !node) return;
      reading.current = {position,following:!target,seen:new Set()};
      root.scrollTop = node ? node.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop + target.offsetPx : root.scrollHeight;
      if (node && position.jump) node.focus({preventScroll:true});
    } else if (reading.current.following) root.scrollTop = root.scrollHeight;
  },[session?.id,session?.turns,readingPosition]);
  useLayoutEffect(()=>()=>{
    const queued=anchorTimer.current;
    if (!queued) return;
    clearTimeout(queued.timer);
    anchorTimer.current=null;
    queued.save();
  },[session?.id,readingPosition]);
  useEffect(()=>{
    if (!session || !scroll.current) return;
    const root=scroll.current;
    const frame=window.requestAnimationFrame(recordVisible);
    const observer=typeof ResizeObserver !== "undefined" ? new ResizeObserver(()=>{
      if (reading.current.following && reading.current.position === readingPosition) root.scrollTop=root.scrollHeight;
      recordVisible();
    }) : null;
    if (root.firstElementChild) observer?.observe(root.firstElementChild);
    document.addEventListener("visibilitychange",recordVisible);
    return ()=>{
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      document.removeEventListener("visibilitychange",recordVisible);
    };
  },[session?.id,session?.turns,session?.view,inert,readingPosition]);
  return {scroll,onScroll};
}
