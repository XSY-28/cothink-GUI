// Pure editor schema shared by the versioned draft and its renderer. This is not an authority store.
export const defaultTurnOptions = () => ({id:null,readOnly:false,delegate:true,review:false,maxCalls:'',readAllowed:false,readPaths:'',readProject:null,readWorkspaceId:null,readVersion:null});
export function validateEditorTurnOptions(value) {
  if(value==null)return null;
  const defaults=defaultTurnOptions();
  if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(defaults,k)))throw Error('本条选项记录无效；原草稿保留。');
  const result={...defaults,...value};
  const validDelegation=[true,false,'review-only'].includes(result.delegate);
  if(typeof result.id!=='string'||!/^[\da-f-]{36}$/i.test(result.id)||!validDelegation||['readOnly','review','readAllowed'].some(k=>typeof result[k]!=='boolean')||typeof result.maxCalls!=='string'||result.maxCalls.length>32||typeof result.readPaths!=='string'||result.readPaths.length>8000||result.readProject!==null&&typeof result.readProject!=='string'||result.readWorkspaceId!==null&&(typeof result.readWorkspaceId!=='string'||!/^[\da-f-]{36}$/i.test(result.readWorkspaceId)))throw Error('本条选项记录无效；原草稿保留。');
  if(result.readVersion!==null&&(typeof result.readVersion!=='string'||!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(result.readVersion)))throw Error('固定读取版本记录无效。');
  if(result.readAllowed&&!result.readProject)throw Error('文件读取选择缺少当时显示的目录。');
  return result;
}
export function editorTurnInput(value,{project,workspaceId=null}={}) {
  const options=validateEditorTurnOptions(value)??defaultTurnOptions();
  if(options.readAllowed&&(options.readProject!==project||options.readWorkspaceId!==workspaceId))throw Error('项目归属已变化，请重新确认本次文件读取选择。');
  if(options.readAllowed&&!options.readVersion)
    throw Object.assign(Error('原草稿缺少当时选择的固定版本，请重新选择项目文件。'),{code:'READ_VERSION'});
  const maxCalls=options.maxCalls===''?null:Number(options.maxCalls);
  if(maxCalls!==null&&(!/^\d+$/.test(options.maxCalls)||!Number.isSafeInteger(maxCalls)))throw Error('本轮请求上限必须是非负整数，或留空不设上限。');
  // An older draft with delegate:false permits review only when explicitly required.
  const allowedSubtasks=options.delegate===false&&!options.review?[]:['review'];
  if(options.delegate===true)allowedSubtasks.push('work');
  return {constraints:{readOnly:options.readOnly,allowedSubtasks,requireDifferentModelReview:options.review},budget:{maxCalls},
    ...(options.readAllowed?{readAuthorization:{paths:options.readPaths.split(',').map(path=>path.trim()).filter(Boolean),version:options.readVersion}}:{})};
}
