import { basename } from "node:path";
import { loadConfig } from "./config.js";
import { conversationMaterialRefs, conversationTaskIds, normalizeConversationEditor, readConversationMetadata, readSessionProject } from "./conversation.js";
import { GUI_MATERIAL_CAPABILITIES, listGuiProjectMaterials, readGuiProjectMaterial } from "./gui-materials.js";
import { inspectGuiDirectory, inspectGuiProject } from "./gui-work.js";
import { isWorkspaceId } from "./gui-workspace-state.js";
import { freezeReadAuthorization } from "./project-turn.js";
import { readHomeDraft } from "./session-ui-state.js";

export function createGuiMaterialActions({
  home,materials,uploads,emit,reader,rawTask,readSessionHomeOrigin,assertSessionUnarchived,assertWorkspaceWritable,
  conversationDirectoryAvailable,directoryIdentity,getActive,isShuttingDown,
}) {
  const materialError=(code,message)=>Object.assign(Error(message),{code});
  const keyOf=ref=>`${ref.id}:${ref.sha256}`;
  const matchRef=(left,right)=>left.id===right.id&&(right.sha256===undefined||left.sha256===right.sha256);
  function materialSources(manager){
    const inherited=conversationMaterialRefs(manager);
    const origin=readSessionHomeOrigin(manager);
    for(const entry of manager.getBranch()){
      if(entry.type==="custom"&&entry.customType==="cothink-draft"&&origin&&entry.data?.homeDraftId===origin)
        for(const ref of normalizeConversationEditor(entry.data).materials)inherited.push({...ref,ownerId:origin});
    }
    return inherited;
  }
  function materialOnBranch(receipt,manager){
    return !manager||!receipt?.branchAnchor||manager.getBranch().some(e=>e.id===receipt.branchAnchor);
  }
  function resolveEditorMaterials(ownerId, refs, manager){
    const source=new Map((manager?materialSources(manager):[]).map(ref=>[keyOf(ref),ref.ownerId]));
    const resolved=materials.resolve({ownerId,materials:refs,ownerFor:ref=>source.get(keyOf(ref))??ownerId});
    if(resolved.some(({manifest})=>!source.has(keyOf(manifest))&&!materialOnBranch(manifest,manager)))
      throw materialError("MATERIAL_NOT_FOUND","材料上传不属于当前分支。");
    return resolved;
  }
  function materialView(ownerId,editor,manager){
    let list=[],error;
    try {list=materials.list({ownerId});}catch(e){error=e.message;}
    const selected=(editor.materials??[]).map(ref=>{
      try{return resolveEditorMaterials(ownerId,[ref],manager)[0].manifest;}
      catch(e){return {...ref,name:"材料不可用",status:"failed",error:e.message};}
    });
    const ids=new Set(selected.map(item=>item.id));
    const outstanding=list.filter(item=>materialOnBranch(item,manager)&&!ids.has(item.id)&&
      (item.status==="pending"||item.status==="ready"&&!item.acknowledged));
    return {materials:selected,materialUploads:outstanding.map(item=>item.status==="ready"?
      {...item,status:"unknown",error:"原上传已有字节，可查询原标识并恢复。"}:item),materialError:error};
  }
  async function materialOwner(ownerId,{writable=false}={}){
    if(!isWorkspaceId(ownerId))throw materialError("MATERIAL_ID","材料归属无效。");
    let draft;try{draft=readHomeDraft(home);}catch{}
    if(draft?.draftId===ownerId)return {draft,editor:normalizeConversationEditor(draft.editor)};
    let manager;
    try {manager=await reader(ownerId);}
    catch {throw materialError("MATERIAL_NOT_FOUND","材料归属不存在。");}
    if(writable){
      assertSessionUnarchived(ownerId);
      await assertWorkspaceWritable(manager,{requireTeam:true});
      if(getActive()?.origin==="context.organize"&&getActive()?.sessionId===ownerId)
        throw materialError("CONTEXT_BUSY","该对话正在整理，请稍后添加材料。");
    }
    return {manager,editor:readConversationMetadata(manager).editor};
  }
  async function materialQuery({ownerId,uploadId}){
    const {manager}=await materialOwner(ownerId);
    if(!uploadId)return materials.list({ownerId}).filter(item=>materialOnBranch(item,manager));
    const item=materials.query({ownerId,uploadId});
    return materialOnBranch(item,manager)?item:null;
  }
  async function materialRead({ownerId,id,sha256,taskId}){
    const {manager,editor}=await materialOwner(ownerId);
    let refs=editor.materials;
    if(taskId){
      if(!manager||!conversationTaskIds(manager).includes(taskId))
        throw materialError("MATERIAL_NOT_FOUND","材料来源不在当前分支。");
      const task=rawTask(taskId).record;
      refs=task.materials??[];
    }
    const ref=refs.find(item=>matchRef(item,{id,sha256}));
    if(!ref)throw materialError("MATERIAL_NOT_FOUND","当前草稿或历史消息没有这份材料。");
    return resolveEditorMaterials(ownerId,[ref],manager)[0];
  }
  async function materialUpload({ownerId,uploadId,body,signal,stop}){
    if(isShuttingDown())throw materialError("HOST_SHUTTING_DOWN","宿主正在退出。");
    const abort=new AbortController(),request={abort,promise:null};
    if(stop)abort.signal.addEventListener("abort",stop,{once:true});
    uploads.add(request);
    request.promise=(async()=>{
      const {manager}=await materialOwner(ownerId,{writable:true});
      if(!materialOnBranch(materials.query({ownerId,uploadId}),manager))
        throw materialError("MATERIAL_NOT_FOUND","上传不属于当前分支。");
      return materials.publish({ownerId,uploadId,body,signal:signal?AbortSignal.any([signal,abort.signal]):abort.signal});
    })();
    try{return await request.promise;}
    finally{if(stop)abort.signal.removeEventListener("abort",stop);uploads.delete(request);emit();}
  }
  async function projectMaterialSource({ownerId,source,version}){
    const {manager}=await materialOwner(ownerId);
    const path=manager&&readSessionProject(manager);
    if(!path)throw materialError("MATERIAL_NOT_FOUND","此对话没有绑定项目目录。");
    const facts=inspectGuiDirectory(path);
    if(!conversationDirectoryAvailable(manager,path,facts))throw materialError("MATERIAL_SOURCE","所选目录不可读取或已经改变。");
    const identity=directoryIdentity(path);
    if(!identity)throw materialError("MATERIAL_SOURCE","所选目录已不可用。");
    if(source==="current")return {root:facts.canonicalPath,path,identity,source,scope:".",version:null};
    if(source!=="saved")throw materialError("MATERIAL_SOURCE","请选择当前文件副本或已保存版本。");
    const saved=await inspectGuiProject(home,path,loadConfig(home)?.work,{includeChanges:false});
    if(!saved.executionReady||!saved.version)throw materialError("MATERIAL_SOURCE","此目录没有可核验的已保存版本。");
    const grant=await freezeReadAuthorization({home,workspace:{project:path},sessionId:ownerId,input:{paths:[saved.relativePath]}});
    if(grant.canonicalRepo!==saved.root)throw materialError("MATERIAL_SOURCE","项目仓库在选择时发生改变。");
    if(version!==undefined&&grant.version!==version)throw materialError("READ_VERSION","已保存版本改变，请重新浏览并选择。");
    return {root:grant.canonicalRepo,path,identity,source,scope:saved.relativePath,version:grant.version};
  }
  async function listProjectMaterials(args){
    return listGuiProjectMaterials(await projectMaterialSource(args),args);
  }
  async function readProjectMaterial(args,source){
    return readGuiProjectMaterial(source??await projectMaterialSource(args),args.path);
  }
  async function importProjectMaterials(args){
    if(args.source!=="current"||!Array.isArray(args.paths)||!args.paths.length||args.paths.length>GUI_MATERIAL_CAPABILITIES.maxCount)
      throw materialError("MATERIAL_LIMIT","请选择不超过单条上限的当前文件副本。");
    const {manager}=await materialOwner(args.ownerId,{writable:true});
    const source=await projectMaterialSource(args);
    const verified=await Promise.all(args.paths.map(async row=>{
      const result=await readProjectMaterial({...args,path:row.path},source);
      if(row.sha256!==result.sha256||row.sourceToken!==result.sourceToken)
        throw materialError("MATERIAL_CONFLICT","文件或目录在预览后已变化，请重新预览。");
      return {...result,name:basename(row.path),uploadId:row.uploadId};
    }));
    if(verified.reduce((sum,row)=>sum+row.bytes.length,0)>GUI_MATERIAL_CAPABILITIES.totalBytes)
      throw materialError("MATERIAL_LIMIT","选择超出材料总字节上限。");
    const ready=[];
    for(const row of verified){
      const intent={ownerId:args.ownerId,uploadId:row.uploadId,name:row.name,mediaType:row.mediaType,byteLength:row.bytes.length,sha256:row.sha256,branchAnchor:manager.getLeafId()};
      materials.begin(intent);
      ready.push(await materialUpload({ownerId:args.ownerId,uploadId:row.uploadId,body:row.bytes}));
    }
    return ready;
  }
  return {materialError,materialOnBranch,resolveEditorMaterials,materialView,materialOwner,materialQuery,
    materialRead,materialUpload,listProjectMaterials,readProjectMaterial,importProjectMaterials};
}
