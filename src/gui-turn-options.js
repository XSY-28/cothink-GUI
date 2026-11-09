// Pure editor schema shared by the versioned draft and its renderer. This is not an authority store.
export const defaultTurnOptions = () => ({id:null,readOnly:false,delegate:true,review:false,maxCalls:'',readAllowed:false,readPaths:'',readProject:null,readWorkspaceId:null});
export function validateEditorTurnOptions(value) {
  if(value==null)return null;
  const defaults=defaultTurnOptions();
  if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(defaults,k)))throw Error('本条选项记录无效；原草稿保留。');
  const result={...defaults,...value};
  if(typeof result.id!=='string'||!/^[\da-f-]{36}$/i.test(result.id)||['readOnly','delegate','review','readAllowed'].some(k=>typeof result[k]!=='boolean')||typeof result.maxCalls!=='string'||result.maxCalls.length>32||typeof result.readPaths!=='string'||result.readPaths.length>8000||result.readProject!==null&&typeof result.readProject!=='string'||result.readWorkspaceId!==null&&(typeof result.readWorkspaceId!=='string'||!/^[\da-f-]{36}$/i.test(result.readWorkspaceId)))throw Error('本条选项记录无效；原草稿保留。');
  if(result.readAllowed&&!result.readProject)throw Error('文件读取选择缺少当时显示的目录。');
  return result;
}
export function editorTurnInput(value,{project,workspaceId=null}={}) {
  const options=validateEditorTurnOptions(value)??defaultTurnOptions();
  if(options.readAllowed&&(options.readProject!==project||options.readWorkspaceId!==workspaceId))throw Error('项目归属已变化，请重新确认本次文件读取选择。');
  const maxCalls=options.maxCalls===''?null:Number(options.maxCalls);
  if(maxCalls!==null&&(!/^\d+$/.test(options.maxCalls)||!Number.isSafeInteger(maxCalls)))throw Error('本轮请求上限必须是非负整数，或留空不设上限。');
  return {constraints:{readOnly:options.readOnly,allowedSubtasks:options.delegate?['review','work']:options.review?['review']:[],requireDifferentModelReview:options.review},budget:{maxCalls},
    ...(options.readAllowed?{readAuthorization:{paths:options.readPaths.split(',').map(path=>path.trim()).filter(Boolean)}}:{})};
}
