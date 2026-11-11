import {defaultTurnOptions,editorReadPaths,retiredReviewOption} from "../../src/gui-turn-options.js";
import {materialExtensions} from "../../src/gui-material-types.js";
import React, {useEffect,useLayoutEffect,useRef,useState} from "react";
import {Icon} from "./Icon.js";
import {shouldSubmit} from "./view.js";
import {GUI_INPUT_VERSION} from "../../src/gui-turn-options.js";
const h=React.createElement;
export function Composer({session,boot,draft,onDraft,onSubmit,busy,submitting,pending,onSettings,onPlugins,workRequest,onWorkRequest,draftConflict,onResolveDraft,turnOptions,onTurnOptions,onOpenTurnLimits,homeReady=false,creating=false,homeCreationPending=false,editorKey,materials=[],materialCapabilities,materialError,onImportMaterials,onRemoveMaterial,onRetryMaterial,onPreviewMaterial,onChooseProjectFiles,onChooseSkill,selectedSkill,onRemoveSkill,thinking,onThinkingChange,onThinkingRecover,connection}) {
  const composing=useRef(false), input=useRef(null), fileInput=useRef(null), addTrigger=useRef(null), menuPanel=useRef(null), importing=useRef(new Map());
  const [addingFor,setAddingFor]=useState(), [importError,setImportError]=useState(null), [,showImportState]=useState(0), team=session?.team;
  const scope=editorKey??session?.id??null, importScope=session?.id??null;
  const adding=addingFor===scope;
  useEffect(()=>{
    if(!adding)return;
    const closeOutside=event=>{
      if(!menuPanel.current?.contains(event.target)&&!addTrigger.current?.contains(event.target))setAddingFor(undefined);
    };
    document.addEventListener("pointerdown",closeOutside,true);
    document.addEventListener("focusin",closeOutside,true);
    return()=>{document.removeEventListener("pointerdown",closeOutside,true);document.removeEventListener("focusin",closeOutside,true);};
  },[adding]);
  useEffect(()=>{setAddingFor(undefined);setImportError(null);},[scope]);
  const grow=()=>{
    const node=input.current;
    if(!node)return;
    node.style.height="0px";
    node.style.height=`${node.scrollHeight}px`;
  };
  useLayoutEffect(grow,[draft,session?.id]);
  useLayoutEffect(()=>{
    const node=input.current;
    let width=node?.clientWidth;
    const observer=typeof ResizeObserver === "undefined" ? null : new ResizeObserver(()=>{
      if(node.clientWidth !== width){width=node.clientWidth;grow();}
    });
    if(node)observer?.observe(node);
    window.addEventListener("resize",grow);
    return()=>{observer?.disconnect();window.removeEventListener("resize",grow);};
  },[]);
  const options=turnOptions??defaultTurnOptions();
  const {readPaths,readOnly,delegate,maxCalls}=options;
  const needsReviewUpdate=retiredReviewOption(options);
  const readAllowed=options.readAllowed&&options.readProject===session?.project&&options.readWorkspaceId===(session?.workspaceId??null);
  const disabled=(!session && !homeReady) || session?.navigation?.archived || !!session?.navigationError || !!session?.readOnly || !!session?.selectionError;
  const localCommand=/^\/(?:team|models|settings|help)$/.test(draft.trim());
  const localTeam=/^\/(?:team|models)$/.test(draft.trim());
  const incomplete=!!importing.current.get(importScope)||materials.some(item=>item.status!=="ready");
  const oldProtocol=boot.protocol?.guiInput!==Number(GUI_INPUT_VERSION);
  const blocks=boot.protocol?.unified!==1 || oldProtocol || disabled || draftConflict || thinking?.save || (!draft.trim()&&!materials.length) ||
    (creating || homeCreationPending || !localCommand && (busy || submitting || pending || incomplete || needsReviewUpdate || !team && !homeReady));
  const send=async()=>{if(!blocks&&(localCommand||!importing.current.get(importScope)))await onSubmit();};
  const optionDisabled=disabled||submitting||pending||creating||session?.contextOrganizing;
  const thinkingDisabled=optionDisabled||!team||!!thinking?.save||boot.protocol?.guiInput!==Number(GUI_INPUT_VERSION)||
    connection==="reconnecting"||connection==="connecting"||!!boot.shutdown?.requested;
  const importFiles=async files=>{
    if(optionDisabled||!onImportMaterials||!files.length)return;
    importing.current.set(importScope,(importing.current.get(importScope)??0)+1);
    showImportState(value=>value+1);
    setImportError(null);
    try {await onImportMaterials(files);}
    catch(error){setImportError({scope:importScope,message:error.message});}
    finally{
      const left=importing.current.get(importScope)-1;
      if(left)importing.current.set(importScope,left);else importing.current.delete(importScope);
      showImportState(value=>value+1);
    }
  };
  const doAction=action=>{setAddingFor(undefined);input.current?.focus();action();};
  const openFiles=()=>fileInput.current?.click();
  const addActions=[
    onImportMaterials&&["添加文件或图片",openFiles],
    session?.project&&onChooseProjectFiles&&["选择项目文件",onChooseProjectFiles],
    onChooseSkill&&["使用技能",onChooseSkill],
    onPlugins&&["插件命令",onPlugins]
  ].filter(Boolean);
  const chips=[
    readOnly&&["read-only","只分析",()=>onTurnOptions?.({readOnly:false}),onOpenTurnLimits],
    delegate!==true&&["dispatch","禁止派工",needsReviewUpdate?null:()=>onTurnOptions?.({delegate:true}),onOpenTurnLimits],
    maxCalls!==""&&["max-calls",`最多 ${maxCalls} 次请求`,()=>onTurnOptions?.({maxCalls:""}),onOpenTurnLimits],
    options.readAllowed&&["read-scope",readAllowed?`读取已保存版本：${editorReadPaths(readPaths).join("、")||"未选范围"}`:"项目读取范围需重新确认",()=>onTurnOptions?.({readAllowed:false,readPaths:[]})],
    selectedSkill&&["skill",`技能：${typeof selectedSkill==="string"?selectedSkill:selectedSkill.name}`,onRemoveSkill],
    options.fileWork&&!readOnly&&["file-work","文件任务 · 仅本次",()=>onTurnOptions?.({fileWork:false})],
    options.networkMode==="whole-turn-offline"&&["offline","整轮离线",()=>onTurnOptions?.({networkMode:null})],
    workRequest&&["work","制作网页 · 仅本次",()=>onWorkRequest?.(null)],
  ].filter(Boolean);

  return h("form",{className:"composer",onSubmit:e=>{e.preventDefault();send();},onKeyDown:e=>{
    if(e.key==="Escape"&&adding&&!composing.current&&!e.nativeEvent?.isComposing&&e.keyCode!==229){
      e.preventDefault();e.stopPropagation();setAddingFor(undefined);
      addTrigger.current?.focus();
    }
  },onDragOver:e=>{
    if(onImportMaterials&&Array.from(e.dataTransfer?.types??[]).includes("Files")){
      e.preventDefault();e.dataTransfer.dropEffect=optionDisabled?"none":"copy";
    }
  },onDrop:e=>{
    const files=Array.from(e.dataTransfer?.files??[]);
    if(onImportMaterials&&files.length){e.preventDefault();importFiles(files);}
  }},
  boot.protocol?.unified!==1 && h("p",{className:"error-text",role:"alert"},"前后端协议不匹配，请重新打开新版界面；草稿保留。"),
  oldProtocol && h("p",{className:"error-text",role:"alert"},"请重新打开新版界面后调整思考强度或发送；草稿保留。"),
  thinking?.save && h("p",{className:"composer-notice",role:"status"},thinking.save.status==="saving"?"正在保存思考强度；草稿保留，确认前暂不发送。":"思考设置保存结果未知；核对原对话前暂不发送。",
    thinking.save.status==="unknown"&&h(React.Fragment,null,
      h("button",{type:"button",onClick:()=>onThinkingRecover?.({})},"查询思考设置"),
      h("button",{type:"button",onClick:()=>onThinkingRecover?.({adoptCurrent:true})},"采用当前保存设置"))),
  session?.selectionError && h("p",{className:"error-text",role:"alert"},session.selectionError," 当前记录保留；可重新读取，或切到健康对话继续。请先处理占用或诊断，不要重新发送结果未知的请求。"),
  session?.workspaceError && h("p",{className:"error-text",role:"alert"},session.workspaceError),
  session?.viewError && h("p",{className:"composer-notice",role:"status"},session.viewError),
  session?.contextOrganizing && h('p',{className:'composer-notice',role:'status'},'正在整理上下文；新输入暂留本机，结束后再保存。'),
  session?.contextOperation && h('p',{className:'composer-notice',role:'status'},`上下文整理：${session.contextOperation.applied?'已应用，可追溯原文':session.contextOperation.status} · ${session.contextOperation.requests?.filter(r=>r.sent).length??0} 次实际请求${session.contextOperation.preparation?' / 本次准备预计 '+session.contextOperation.preparation.expectedCalls+' 次':''}${session.contextOperation.error?' · '+session.contextOperation.error:''}`),
  draftConflict && h("div",{className:"composer-notice",role:"alert"},"保存稿已变化；当前本机输入保留。",
    h("button",{type:"button",onClick:()=>onResolveDraft?.("saved")},"读取保存稿"),
    h("button",{type:"button",onClick:()=>onResolveDraft?.("local")},"以本机稿再保存")),
  needsReviewUpdate && h("div",{className:"composer-notice",role:"status"},
    "此草稿使用了已退役的普通对话评审选项。采用现行规则后，项目仍可按成果需要安排审查。",
    delegate!==true && "本条仍禁止新派工，可在确认后修改。",
    h("button",{type:"button",disabled:optionDisabled||!!draftConflict,onClick:()=>{
      onTurnOptions?.({review:false,delegate:delegate===true});input.current?.focus();
    }},"采用现行规则")),
  session && !team && !session.workspaceError && h("div",{className:"composer-notice"},
    session.rosterRequired || "发送前请选择阵容。",
    h("button",{type:"button",onClick:onSettings},"选择阵容")),
  session?.navigationError && h("p",{className:"error-text",role:"alert"},session.navigationError),
  session?.navigation?.archived && h("p",{className:"composer-notice"},"已归档；请先恢复对话再编辑或发送。"),
  session?.readOnly && session.workspaceId!==null && !session?.selectionError && !session?.workspaceError && !session?.workspaceArchived && !session?.navigation?.archived && h("p",{className:"composer-notice"},"此会话当前只读。若被其他 CLI 或窗口占用，请先在该入口结束并关闭，再重新读取；不会强制接管。"),
  (materialError || !materials.some(item=>item.error)&&importError?.scope===importScope&&importError.message) && h("p",{className:"error-text",role:"alert"},materialError || importError.message),
  importing.current.get(importScope)>0&&!materials.some(item=>item.status==="uploading")&&h("p",{className:"composer-notice",role:"status"},"正在核对并保存材料…"),
  materials.length>0 && h("ul",{className:"composer-materials","aria-label":"本次材料"},...materials.map((item,index)=>{
    const status={ready:"已就绪",pending:"待继续上传",uploading:"导入中",loading:"读取状态中",failed:"导入失败",unknown:"等待核对"}[item.status]??"尚未就绪";
    const bytes=item.byteLength;
    const type=item.mediaType?.startsWith("image/")?"图片":item.mediaType?.startsWith("text/")?"文本":null;
    return h("li",{key:item.key??item.uploadId??item.id??index},
      h("span",{className:"material-label"},h("strong",{title:item.name},item.name),
        h("small",{role:item.status==="ready"?undefined:"status",title:item.mediaType},[type,Number.isFinite(bytes)?new Intl.NumberFormat("zh-CN").format(bytes)+" B":null,status].filter(Boolean).join(" · "))),
      item.error&&h("span",{className:"material-error",role:"alert"},item.error),
      onPreviewMaterial&&item.status==="ready"&&h("button",{type:"button",onClick:()=>onPreviewMaterial(item),"aria-label":`预览 ${item.name}`},"预览"),
      onRetryMaterial&&item.uploadId&&["failed","unknown","pending"].includes(item.status)&&!item.uploading&&h("button",{type:"button",disabled:optionDisabled,onClick:()=>{setImportError(null);onRetryMaterial(item);}},item.status==="unknown"?"查询":"重新选择文件"),
      onRemoveMaterial&&h("button",{type:"button",disabled:optionDisabled,onClick:()=>{setImportError(null);onRemoveMaterial(item);},"aria-label":`移除 ${item.name}`},"×"));
  })),
  chips.length>0 && h("div",{className:"composer-chips","aria-label":"本次选择"},...chips.map(([key,label,remove,edit])=>
    h("span",{key,className:"composer-chip"},
      edit ? h("button",{type:"button",className:"chip-edit",title:label,disabled:optionDisabled,onClick:event=>edit(event.currentTarget),"aria-label":`修改${label}`,"aria-haspopup":"dialog"},label)
        : h("span",{title:label},label),
      remove&&h("button",{type:"button",disabled:optionDisabled,onClick:()=>{remove();input.current?.focus();},"aria-label":`移除${label}标记`},"×")))),
  onImportMaterials && h("input",{type:"file",hidden:true,multiple:true,ref:fileInput,accept:[...(materialCapabilities?.mediaTypes??[]),...materialExtensions].join(","),
    onChange:e=>{const files=Array.from(e.target.files??[]);e.target.value="";importFiles(files);input.current?.focus();},
    onCancel:()=>input.current?.focus()}),
  h("label",{className:"sr-only",htmlFor:"message-input"},"输入问题"),
  h("textarea",{id:"message-input",ref:input,rows:2,value:draft,disabled:disabled||homeReady&&creating,
    placeholder:busy ? "任务进行中，可以继续写草稿……" : "描述任务，或继续讨论……",
    onPaste:e=>{
      const files=Array.from(e.clipboardData?.files??[]).filter(file=>file.type.startsWith("image/"));
      if(files.length&&!optionDisabled&&onImportMaterials){e.preventDefault();importFiles(files);}
    },
    onChange:e=>onDraft(e.target.value),onCompositionStart:()=>{composing.current=true;},onCompositionEnd:()=>{composing.current=false;},
    onKeyDown:e=>{if(shouldSubmit({...e,keyCode:e.keyCode,isComposing:composing.current || e.nativeEvent?.isComposing})){e.preventDefault();send();}}
  }),
  h("div",{className:"composer-options"},
    addActions.length>0 && h("button",{type:"button",ref:addTrigger,disabled:optionDisabled,"aria-label":"添加本次操作","aria-expanded":adding,onClick:()=>setAddingFor(adding?undefined:scope)},h(Icon,{name:"plus"})),
    adding && h("div",{className:"composer-add-menu composer-add-actions",ref:menuPanel},
      ...addActions.map(([label,action])=>h("button",{key:label,type:"button",disabled:optionDisabled,onClick:()=>doAction(action)},label))),
    h("div",{className:"composer-submit-controls"},
      h(ThinkingControl,{scope,thinking,disabled:thinkingDisabled,next:busy,onChange:onThinkingChange}),
      h("button",{type:"submit",className:"primary send",disabled:!!blocks,"aria-label":localTeam ? "打开阵容" : localCommand ? "打开本地命令" : submitting ? "确认提交" : pending ? "待确认" : busy ? "草稿保留" : "发送",title:localTeam ? "打开阵容" : "发送"},h(Icon,{name:submitting ? "more" : "send"})))
  ),

  );
}

function ThinkingControl({scope,thinking,disabled,next,onChange}) {
  const [openFor,setOpenFor]=useState(null),trigger=useRef(null),menu=useRef(null);
  const open=openFor===scope&&scope!=null&&!disabled;
  const close=()=>{setOpenFor(null);trigger.current?.focus();};
  useEffect(()=>{setOpenFor(null);},[scope,disabled]);
  useLayoutEffect(()=>{if(open)menu.current?.querySelector('[role="menuitemradio"]')?.focus();},[open]);
  useEffect(()=>{
    if(!open)return;
    const outside=event=>{if(!menu.current?.contains(event.target)&&!trigger.current?.contains(event.target))setOpenFor(null);};
    document.addEventListener("pointerdown",outside,true);document.addEventListener("focusin",outside,true);
    return()=>{document.removeEventListener("pointerdown",outside,true);document.removeEventListener("focusin",outside,true);};
  },[open]);
  const label=thinking?.level?(thinking.scope==="main"?`主模型 ${thinking.level}`:`思考 ${thinking.level}`):"思考 默认";
  const choose=level=>{close();onChange?.(level);};
  return h("div",{className:"composer-thinking",onKeyDown:event=>{
    if(event.key==="Escape"&&open){event.preventDefault();event.stopPropagation();close();return;}
    if(!open)return;
    const items=Array.from(menu.current?.querySelectorAll('[role="menuitemradio"]')??[]),index=items.indexOf(document.activeElement);
    const target=event.key==="ArrowDown"?(index+1)%items.length:event.key==="ArrowUp"?(index+items.length-1)%items.length:event.key==="Home"?0:event.key==="End"?items.length-1:null;
    if(target!==null){event.preventDefault();items[target]?.focus();}
  }},
    h("button",{type:"button",ref:trigger,className:"composer-thinking-trigger",disabled,"aria-label":"思考强度","aria-haspopup":"menu","aria-expanded":open,
      title:disabled?"先选择对话阵容，并等待设置、连接与提交确认。":"调整本对话后续任务的思考强度",
      onClick:()=>setOpenFor(open?null:scope),onKeyDown:event=>{if(!open&&["ArrowDown","ArrowUp"].includes(event.key)){event.preventDefault();setOpenFor(scope);}}},label,h("span",{"aria-hidden":true}," ▾")),
    open&&h("div",{className:"composer-thinking-menu",ref:menu,role:"menu","aria-label":"思考强度选项"},
      h("p",null,next?"作用于下一条消息":"用于本对话后续新任务"),
      thinking?.scope==="main"&&thinking.level&&h("p",null,`历史设置仅作用于主模型 ${thinking.level}；重新选档后统一应用于阵容。`),
      h("button",{type:"button",role:"menuitemradio","aria-checked":thinking?.level==null,onClick:()=>choose(null)},"跟随阵容"),
      h("p",{className:"thinking-default-note"},"跟随阵容各模型参数；未指定的可思考模型默认 high。"),
      ...(thinking?.levels??[]).map(level=>h("button",{key:level,type:"button",role:"menuitemradio","aria-checked":thinking?.scope==="all"&&thinking.level===level,onClick:()=>choose(level)},level)),
      thinking?.reason&&h("p",{role:"status"},thinking.reason)));
}
