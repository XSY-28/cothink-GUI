// File execution commands use the workspace hook's original refs and callbacks.
// No pending state, submission queue or recovery store is created here.
export function createGuiFileCommands({
  api,bootstrap,session,pendingRef,submissionBusy,setSubmitting,storePending,selectTask,refresh,setError,
}) {
  async function confirmWork(turn) {
    if(bootstrap.active||pendingRef.current||submissionBusy.current)return;
    submissionBusy.current=true;setSubmitting(true);
    const association={sessionId:session.id,submissionId:crypto.randomUUID(),proposalRef:turn.proposalRef,kind:'confirmation'};
    storePending(association);
    try{const result=await api.action('task.confirmWork',{sessionId:session.id,submissionId:association.submissionId,proposalRef:turn.proposalRef,protocolVersion:1});storePending(null);await selectTask(result.taskId,session.id);await refresh();return result;}
    catch(error){if(!error.unknown)storePending(null);setError(error.message);}
    finally{submissionBusy.current=false;setSubmitting(false);}
  }
  async function inspectFileContinuation(turn,draft) {
    if(bootstrap.protocol?.fileContinuation!==1)throw Error('此宿主尚不支持从保存成果继续，请重新打开新版应用。');
    return api.action('task.inspectContinuation',{sessionId:session.id,sourceRootTaskId:turn.taskId,
      ...(draft!==undefined?{draft}:{})});
  }
  async function continueFileWork(turn,facts) {
    if(bootstrap.active||pendingRef.current||submissionBusy.current)return;
    if(bootstrap.protocol?.fileContinuation!==1)throw Error('此宿主尚不支持从保存成果继续。');
    submissionBusy.current=true;setSubmitting(true);
    const association={sessionId:session.id,sourceRootTaskId:turn.taskId,submissionId:crypto.randomUUID(),kind:'file_continuation'};
    storePending(association);
    try{
      const result=await api.action('task.continueWork',{sessionId:association.sessionId,sourceRootTaskId:association.sourceRootTaskId,submissionId:association.submissionId,protocolVersion:1,
        draft:facts.draft,expectedRevision:facts.revision,expectedFormalVersion:facts.formalVersion});
      storePending(null);await selectTask(result.taskId,association.sessionId);await refresh();return result;
    }catch(error){if(!error.unknown)storePending(null);setError(error.message);throw error;}
    finally{submissionBusy.current=false;setSubmitting(false);}
  }
  const exportDraft=draft=>api.action("work.exportDraft",{taskId:draft.taskId,draft});
  return {confirmWork,inspectFileContinuation,continueFileWork,exportDraft};
}
