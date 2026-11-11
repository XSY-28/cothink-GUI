import {useRef,useState} from "react";
import {readGuiStorage,writeGuiStorage} from "./view.js";

const HOME="@home";
// Draft and setting mutations share one host ordering and editor version boundary.
export function useEditorPersistence({api,book,draftQueue,organizingSession,conflicts,
  home,setHome,readBootstrap,markDraftConflict,mounted,setError,onSessionSaved}) {
  const pending=useRef(null);
  if(!pending.current){
    const saved=readGuiStorage("cothink.thinking-pending",[]);
    const rows=Array.isArray(saved)?saved:[];
    pending.current=new Map(rows.filter(row=>Array.isArray(row)&&row.length===2&&
      typeof row[0]==="string"&&row[1]?.scope==="all"&&
      (row[1].level===undefined||typeof row[1].level==="string"))
      .map(([id,row])=>[id,{...row,status:"unknown"}]));
  }
  const [thinkingSaves,setThinkingSaves]=useState(()=>Object.fromEntries(pending.current));
  function putPending(id,row){
    if(row)pending.current.set(id,row);else pending.current.delete(id);
    writeGuiStorage("cothink.thinking-pending",[...pending.current]);
    if(mounted.current)setThinkingSaves(Object.fromEntries(pending.current));
  }
  function adoptReceipt(id,saved){
    if(saved?.id!==id)throw Error("思考设置回执的对话身份不匹配。");
    const snapshot=book.current.snapshot(id);
    if(snapshot.expectedDraftRevision===saved.draftRevision)book.current.rebase(id,saved);
    else markDraftConflict(id,saved);
    onSessionSaved(saved,id);
  }
  async function recoverThinkingSettings({sessionId,adoptCurrent=false}={}){
    const target=pending.current.get(sessionId);
    if(!target||target.status!=="unknown")return;
    // Read within the same queue: a draft acknowledgement cannot cross this rebase.
    const operation=draftQueue.current.catch(()=>{}).then(async()=>{
      if(pending.current.get(sessionId)!==target)return;
      const saved=await api.read("session",{id:sessionId});
      if(pending.current.get(sessionId)!==target)return;
      if(saved?.id!==sessionId)throw Error("思考设置回执的对话身份不匹配。");
      const matches=saved.thinkingScope===target.scope&&(saved.thinking??null)===(target.level??null);
      if(!matches&&!adoptCurrent){
        onSessionSaved(saved,sessionId);
        putPending(sessionId,{...target,observed:true});
        return saved;
      }
      adoptReceipt(sessionId,saved);
      putPending(sessionId,null);
      return saved;
    });
    draftQueue.current=operation;
    return operation;
  }
  function saveThinking(args,sessionId){
    if(pending.current.has(sessionId))return Promise.resolve();
    const target={scope:"all",...(args.level?{level:args.level}:{}),status:"saving"};
    // This ref changes before any await, including before the first queue turn.
    putPending(sessionId,target);
    const operation=draftQueue.current.catch(()=>{}).then(async()=>{
      if(pending.current.get(sessionId)!==target)return;
      try{
        const saved=await api.action("session.thinking",{scope:"all",...(target.level?{level:target.level}:{}),sessionId});
        if(pending.current.get(sessionId)!==target)return;
        adoptReceipt(sessionId,saved);
        putPending(sessionId,null);
        return saved;
      }catch(error){
        if(pending.current.get(sessionId)!==target)return;
        if(!error.unknown){putPending(sessionId,null);throw error;}
        const unknown={...target,status:"unknown"};
        putPending(sessionId,unknown);
        // A lost response is never a reason to repeat the mutation.
        let saved;
        try{saved=await api.read("session",{id:sessionId});}catch{return;}
        if(pending.current.get(sessionId)!==unknown)return;
        if(saved?.id===sessionId&&saved.thinkingScope===target.scope&&(saved.thinking??null)===(target.level??null)){
          adoptReceipt(sessionId,saved);putPending(sessionId,null);return saved;
        }
        if(saved?.id===sessionId){onSessionSaved(saved,sessionId);putPending(sessionId,{...target,status:"unknown",observed:true});}
      }
    });
    draftQueue.current=operation;
    return operation;
  }
  function saveDraft(snapshot) {
    if (!snapshot?.sessionId || !snapshot.editId) return Promise.resolve();
    const operation = draftQueue.current.catch(() => {}).then(async () => {
      if(organizingSession.current===snapshot.sessionId)return;
      const latest=book.current.snapshot(snapshot.sessionId);
      if (conflicts.current.has(snapshot.sessionId)) throw Error("草稿存在保存冲突，请先读取保存稿或明确使用本机稿。");
      // A deferred caller may enqueue an obsolete cleanup after a newer edit.
      // Only the current editor can borrow the latest acknowledged host version.
      // In-flight writes still acknowledge normally; newer snapshots stay queued.
      if (latest.editId !== snapshot.editId || latest.revision !== snapshot.revision ||
          latest.savedEditId === snapshot.editId) return;
      const editor={editorVersion:2,text:snapshot.text,workRequest:snapshot.workRequest,
        selectionId:snapshot.selectionId,editId:snapshot.editId,materials:snapshot.materials??[],
        ...(snapshot.turnOptions!==undefined?{turnOptions:snapshot.turnOptions}:{})};
      const isHome=snapshot.sessionId===HOME;
      const args=isHome?{draftId:home.current?.draftId??crypto.randomUUID(),expectedRevision:latest.expectedDraftRevision,editor}:
        {sessionId:snapshot.sessionId,...editor,expectedDraftRevision:latest.expectedDraftRevision,branchAnchor:latest.branchAnchor};
      const homeAck=saved=>{setHome(saved);return {editor:saved.editor,draftRevision:saved.revision,branchAnchor:null};};
      try {
        const row=await api.action(isHome?"home.draft":"session.draft",args);
        const saved=isHome?homeAck(row):row;
        book.current.confirmed(snapshot,saved);
        return saved;
      } catch(error) {
        if (error.unknown || error.code === "DRAFT_CONFLICT") {
          const row=await (isHome?readBootstrap().then(b=>b.homeDraft):api.read("session",{id:snapshot.sessionId})).catch(()=>null);
          const saved=isHome?{editor:row?.editor,draftRevision:row?.revision??null,branchAnchor:null}:row;
          if (error.unknown && saved?.editor?.editId === snapshot.editId) {
            if(isHome)homeAck(row);
            book.current.confirmed(snapshot,saved); return saved;
          }
          markDraftConflict(snapshot.sessionId,saved);
        }
        throw error;
      }
    });
    draftQueue.current = operation;
    operation.catch(e => {
      if (mounted.current) setError("草稿未保存到宿主：" + e.message + " 当前页面仍保留输入。");
    });
    return operation;
  }
  return {saveDraft,saveThinking,recoverThinkingSettings,thinkingSaves,
    thinkingPending:id=>pending.current.has(id)};
}
