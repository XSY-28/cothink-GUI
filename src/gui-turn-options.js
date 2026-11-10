// Pure editor schema shared by the versioned draft and its renderer. This is not an authority store.
export const defaultTurnOptions = () => ({id:null,readOnly:false,delegate:true,review:false,maxCalls:'',readAllowed:false,readPaths:'',readProject:null,readWorkspaceId:null,readVersion:null});

// Recognize explicit creation/edit commands locally. Ambiguous requests can be
// marked as file work in the composer without asking a model to classify them.
const chineseFileAction = /^(?:(?:请(?:你)?|麻烦(?:你)?|帮我|给我)\s*)*(?:创建|新建|生成|制作|修改|修复|编辑|更新|写入|保存|导出|删除)/u;
const chineseTargetFirst = /^(?:(?:请(?:你)?|麻烦(?:你)?|帮我)\s*)*(?:把|将).+(?:修改|改成|编辑|更新|写入|保存|导出|删除|修一下)/u;
const chineseSaveAs = /^(?:请\s*)?(?:给我|帮我).+(?:保存为|另存为|写入到)/u;
const englishFileAction = /^(?:please\s+)?(?:create|generate|build|edit|modify|update|write|save|export|delete)\b/i;
const filePath = /(?:^|[\s/`“"（(]|(?<=[\p{Script=Han}]))[a-z0-9_-]+\.(?:html?|svg|css|[cm]?js|tsx?|jsx|md|txt|json|ya?ml|py|csv|pdf|docx?|xlsx?)(?=$|[\s/`”"）),，。！？])/iu;
const chineseFileTarget = /(?:文件(?:夹)?|目录|网页)(?=$|[\s，。！、？,.!?]|(?:到|至|并|放在|保存在))|(?:html|svg)\s*(?:界面|页面|图像|插图|文件)/iu;
const englishFileTarget = /\b(?:files?|folders?|director(?:y|ies)|web ?pages?|(?:html|svg)\s+(?:pages?|interfaces?|images?|files?))\b/i;

export function isGuiFileTask(input, { fileWork = false, readOnly = false } = {}) {
  if (readOnly) return false;
  if (fileWork) return true;
  const firstLine = input.trimStart().replace(/^\/skill:[^\s]+\s*/u, "").split(/\r?\n/, 1)[0].trim();
  if (/(?:代码(?:片段|示例)|只(?:给|输出|贴)(?:我)?(?:代码|示例)|(?:贴|发|展示|输出)(?:在|到)(?:这条|本次|当前|这个)?(?:聊天|对话|回复)(?:里|中)|(?:不要|不用|无需)(?:创建|修改|写入|生成|保存)文件)|\b(?:code (?:example|snippet)|in (?:this|the) chat)\b/iu.test(firstLine)) return false;
  if (/[?？]$/u.test(firstLine) && /(?:怎么|怎样|如何|要注意什么|需要注意什么|有什么(?:区别|影响|建议)|是做什么的)/u.test(firstLine)) return false;
  if (chineseFileAction.test(firstLine) || chineseTargetFirst.test(firstLine) || chineseSaveAs.test(firstLine))
    return chineseFileTarget.test(firstLine) || filePath.test(firstLine) || /(?:这个|该|这些|此)文件/u.test(firstLine);
  return englishFileAction.test(firstLine) && (englishFileTarget.test(firstLine) || filePath.test(firstLine));
}

export function validateEditorTurnOptions(value) {
  if(value==null)return null;
  const defaults=defaultTurnOptions();
  if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>k!=='fileWork'&&!Object.hasOwn(defaults,k)))throw Error('本条选项记录无效；原草稿保留。');
  const {fileWork,...options}=value;
  if(fileWork!==undefined&&typeof fileWork!=='boolean')throw Error('本条文件任务选项无效；原草稿保留。');
  const result={...defaults,...options};
  const validDelegation=[true,false,'review-only'].includes(result.delegate);
  if(typeof result.id!=='string'||!/^[\da-f-]{36}$/i.test(result.id)||!validDelegation||['readOnly','review','readAllowed'].some(k=>typeof result[k]!=='boolean')||typeof result.maxCalls!=='string'||result.maxCalls.length>32||typeof result.readPaths!=='string'||result.readPaths.length>8000||result.readProject!==null&&typeof result.readProject!=='string'||result.readWorkspaceId!==null&&(typeof result.readWorkspaceId!=='string'||!/^[\da-f-]{36}$/i.test(result.readWorkspaceId)))throw Error('本条选项记录无效；原草稿保留。');
  if(result.readVersion!==null&&(typeof result.readVersion!=='string'||!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(result.readVersion)))throw Error('固定读取版本记录无效。');
  if(result.readAllowed&&!result.readProject)throw Error('文件读取选择缺少当时显示的目录。');
  return fileWork ? {...result,fileWork} : result;
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
