// Pure editor schema shared by the versioned draft and its renderer. This is not an authority store.
export const defaultTurnOptions = () => ({id:null,readOnly:false,delegate:true,review:false,maxCalls:'',readAllowed:false,readPaths:[],readProject:null,readWorkspaceId:null,readVersion:null});

// Old pickers wrote comma-separated paths and did not allow commas in names.
// Do not trim path spellings: leading spaces can distinguish sibling entries.
export const editorReadPaths = value => Array.isArray(value) ? value : value ? value.split(',') : [];

// Recognize explicit creation/edit commands locally. Ambiguous requests can be
// marked as file work in the composer without asking a model to classify them.
const chineseFileAction = /^(?:(?:请(?:你)?|麻烦(?:你)?|帮我|给我)\s*)*(?:创建|新建|生成|制作|修改|修复|编辑|更新|写入?|保存|导出|删除)/u;
const chineseTargetFirst = /^(?:(?:请(?:你)?|麻烦(?:你)?|帮我)\s*)*(?:把|将).+(?:修改|改成|编辑|更新|写入|保存|导出|删除|修一下)/u;
const chineseSaveAs = /^(?:请\s*)?(?:给我|帮我).+(?:保存为|另存为|写入到)/u;
const englishFileAction = /^(?:please\s+)?(?:create|generate|build|edit|modify|update|write|save|export|delete|change)\s+/i;
const filePath = /(?:^|[\s/`“"（(]|(?<=[\p{Script=Han}]))[\p{L}\p{N}_-]+\.(?:html?|svg|css|[cm]?js|tsx?|jsx|md|txt|json|ya?ml|py|csv|pdf|docx?|xlsx?)(?=$|[\s/`”"）),，。！？]|\.(?=\s|$))/iu;
const chineseFileTarget = /(?:文件(?:夹)?|目录|网页)(?=$|[\s，。！、？,.!?]|(?:到|至|并|放在|保存在))|(?:html|svg)\s*(?:界面|页面|图像|插图|文件)/iu;
const englishFileTarget = /^(?:(?:(?:html|svg|text|markdown|csv|json)\s+)?files?|folders?|director(?:y|ies)|web ?pages?|(?:html|svg)\s+(?:pages?|interfaces?|images?))\b/i;
const inlineOnly = /(?:只(?:给|输出|贴)(?:我)?(?:代码|示例)|(?:贴|发|展示|输出)(?:在|到)(?:这条|本次|当前|这个)?(?:聊天|对话|回复)(?:里|中)|只在(?:聊天|对话|回复)(?:里|中)|(?:不要|不用|无需)(?:创建|修改|写入?|生成|保存)文件)|\bin (?:this|the) chat\b/iu;

function requestLines(input) {
  let fence;
  return input.trimStart().replace(/^\/skill:[^\s]+\s*/u, "").split(/\r?\n/).flatMap(line=>{
    const text=line.trim();
    const marker=text.match(/^(\x60{3,}|~{3,})/u)?.[1];
    if(marker && !fence){fence=marker;return [];}
    if(fence){
      if(marker?.[0]===fence[0] && marker.length>=fence.length && text===marker)fence=undefined;
      return [];
    }
    return text.startsWith(">") ? [] : [text.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u,"")];
  });
}

export function isGuiFileTask(input, { fileWork = false, readOnly = false } = {}) {
  if (readOnly) return false;
  if (fileWork) return true;
  const lines=requestLines(input);
  if (lines.some(line=>inlineOnly.test(line))) return false;
  return lines.some((line,index)=>{
    if (/[?？]$/u.test(line) && /(?:怎么|怎样|如何|要注意什么|需要注意什么|有什么(?:区别|影响|建议)|是做什么的)/u.test(line)) return false;
    if (chineseFileAction.test(line) || chineseTargetFirst.test(line) || chineseSaveAs.test(line)) {
      const bareAction=chineseFileAction.exec(line)?.[0]===line;
      const target=bareAction ? lines[index+1]?.split(/\s/u,1)[0]??"" : line;
      return chineseFileTarget.test(target) || filePath.test(target) || /(?:这个|该|这些|此)文件/u.test(target);
    }
    if (!englishFileAction.test(line)) return false;
    const object=line.replace(englishFileAction,"").replace(/^(?:(?:a|an|the|new|existing|this|that|my|our|to|as)\s+)*/i,"");
    const destination=object.match(/\b(?:as|to)\s+(\S+)/i)?.[1];
    return englishFileTarget.test(object) || filePath.test(object.split(/\s/u,1)[0]) ||
      !!destination && filePath.test(destination);
  });
}

const wholeTurnScope = /^(?:全程|整(?:个任务|轮(?:任务)?|次)|本轮(?:任务)?|生成过程|模型调用)(?:都|也|必须|要|\s)*/u;
const prohibitNetwork = /^(?:不联网|(?:不允许|不得|禁止|不许|不准|不能|不要)(?:联网|访问(?:互联网|网络)|使用(?:互联网|网络))|no (?:internet|network)(?: access)?\b|do not (?:connect to|use) the internet\b)/iu;
const prohibitCloudModel = /^(?:(?:不要|禁止|不允许|不得)调用(?:在线|远程|云端)模型|the (?:whole|entire) task must (?:stay|be) offline|do not (?:call|use) (?:any )?(?:remote|cloud) models?)/iu;
const localOnly = /^(?:只|仅)?(?:用|使用|依靠)(?:本地|离线)(?:知识|模型)/u;
const artifactOffline = /^(?:(?:仅|只)(?:要求|需)?\s*)?(?:成品|交付(?:物|文件)|生成的(?:网页|页面|文件))(?:必须|需要|能|须|可以|\s)*(?:离线|不联网)|^(?:only )?the (?:deliverable|output) must (?:stay|be|work) offline/iu;
const explanation = /(?:是什么意思|是什么含义|是个什么概念|怎么理解|在什么地方|在哪里|(?:如何|怎么)(?:设置|运行|工作))$/u;

export function guiNetworkChoice(input, {networkMode} = {}) {
  const clauses=requestLines(input).flatMap(line=>line.split(/[，,。；;！!？?]/u)
    .map(clause=>clause.trim().replace(/^请\s*/u,""))
    .filter(text=>!explanation.test(text)));
  const networkProhibited=clauses.some(text=>prohibitNetwork.test(text));
  const wholeTurn=clauses.some(text=>{
    const scope=text.match(wholeTurnScope);
    if (!scope) return prohibitCloudModel.test(text);
    const requirement=text.slice(scope[0].length);
    return /^离线/u.test(requirement) || prohibitNetwork.test(requirement);
  });
  if (networkMode==="whole-turn-offline" || wholeTurn || networkProhibited && clauses.some(text=>localOnly.test(text))) return "whole-turn-offline";
  if (networkMode==="artifact-offline" || clauses.some(text=>artifactOffline.test(text))) return "artifact-offline";
  return networkProhibited ? "choose" : null;
}

export function guiNetworkBlocker(input, options) {
  const mode=guiNetworkChoice(input,options);
  if(mode==="whole-turn-offline")return "整轮离线：当前阵容无法保证离线运行，未发送模型请求。";
  if(mode==="choose")return "请明确联网范围：仅要求成品离线，还是整轮离线。未发送模型请求。";
  return null;
}

export function validateEditorTurnOptions(value) {
  if(value==null)return null;
  const defaults=defaultTurnOptions();
  if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['fileWork','networkMode'].includes(k)&&!Object.hasOwn(defaults,k)))throw Error('本条选项记录无效；原草稿保留。');
  const {fileWork,networkMode,...options}=value;
  if(fileWork!==undefined&&typeof fileWork!=='boolean')throw Error('本条文件任务选项无效；原草稿保留。');
  if(networkMode!=null&&!['whole-turn-offline','artifact-offline'].includes(networkMode))throw Error('本条联网范围无效；原草稿保留。');
  const result={...defaults,...options};
  const validDelegation=[true,false,'review-only'].includes(result.delegate);
  const readPaths = result.readPaths;
  const validPaths = typeof readPaths === 'string' ? readPaths.length <= 8000
    : Array.isArray(readPaths) && readPaths.every(path => typeof path === 'string' && path.length > 0) &&
      readPaths.reduce((length, path) => length + path.length + 1, 0) <= 8000;
  if(typeof result.id!=='string'||!/^[\da-f-]{36}$/i.test(result.id)||!validDelegation||['readOnly','review','readAllowed'].some(k=>typeof result[k]!=='boolean')||typeof result.maxCalls!=='string'||result.maxCalls.length>32||!validPaths||result.readProject!==null&&typeof result.readProject!=='string'||result.readWorkspaceId!==null&&(typeof result.readWorkspaceId!=='string'||!/^[\da-f-]{36}$/i.test(result.readWorkspaceId)))throw Error('本条选项记录无效；原草稿保留。');
  if(result.readVersion!==null&&(typeof result.readVersion!=='string'||!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(result.readVersion)))throw Error('固定读取版本记录无效。');
  if(result.readAllowed&&!result.readProject)throw Error('文件读取选择缺少当时显示的目录。');
  return {...result,...(fileWork?{fileWork}:{}),...(networkMode?{networkMode}:{})};
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
  return {constraints:{readOnly:options.readOnly,allowedSubtasks,requireDifferentModelReview:options.review,...(options.networkMode?{networkMode:options.networkMode}:{})},budget:{maxCalls},
    ...(options.readAllowed?{readAuthorization:{paths:editorReadPaths(options.readPaths),version:options.readVersion}}:{})};
}
