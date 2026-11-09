import {defaultTurnOptions} from "../../src/gui-turn-options.js";
import React, {useEffect,useLayoutEffect,useRef,useState} from "react";
import {Icon} from "./Icon.js";
import {shouldSubmit} from "./view.js";
const h=React.createElement;
export function Composer({session,boot,draft,onDraft,onSubmit,busy,submitting,pending,onSettings,onPlugins,workRequest,onWorkRequest,draftConflict,onResolveDraft,turnOptions,onTurnOptions,homeReady=false,creating=false,editorKey,materials=[],materialCapabilities,materialError,onImportMaterials,onRemoveMaterial,onRetryMaterial,onPreviewMaterial,onChooseProjectFiles,onAssociateProject,onChooseSkill,selectedSkill,onRemoveSkill}) {
  const composing=useRef(false), input=useRef(null), fileInput=useRef(null), toolbar=useRef(null), menuPanel=useRef(null), importing=useRef(new Map());
  const [openMenu,setOpenMenu]=useState(null), [importError,setImportError]=useState(null), [,showImportState]=useState(0), team=session?.team;
  const scope=editorKey??session?.id??null, importScope=session?.id??null;
  const menu=openMenu?.scope===scope?openMenu.kind:null;
  useEffect(()=>{
    if(!menu)return;
    const closeOutside=event=>{
      const trigger=toolbar.current?.querySelector(`[data-composer-trigger="${menu}"]`);
      if(!menuPanel.current?.contains(event.target)&&!trigger?.contains(event.target))setOpenMenu(null);
    };
    document.addEventListener("pointerdown",closeOutside,true);
    document.addEventListener("focusin",closeOutside,true);
    return()=>{document.removeEventListener("pointerdown",closeOutside,true);document.removeEventListener("focusin",closeOutside,true);};
  },[menu]);
  useEffect(()=>{setOpenMenu(null);setImportError(null);},[scope]);
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
  const {readPaths,readOnly,delegate,review,maxCalls}=options;
  const readAllowed=options.readAllowed&&options.readProject===session?.project&&options.readWorkspaceId===(session?.workspaceId??null);
  const setReadOnly=value=>onTurnOptions?.({readOnly:value}),setDelegate=value=>onTurnOptions?.({delegate:value}),setReview=value=>onTurnOptions?.({review:value}),setMaxCalls=value=>onTurnOptions?.({maxCalls:value});
  const disabled=(!session && !homeReady) || session?.navigation?.archived || !!session?.navigationError || !!session?.readOnly || !!session?.selectionError;
  const localCommand=/^\/(?:team|models|settings|help)$/.test(draft.trim());
  const localTeam=/^\/(?:team|models)$/.test(draft.trim());
  const incomplete=!!importing.current.get(importScope)||materials.some(item=>item.status!=="ready");
  const blocks=boot.protocol?.unified!==1 || disabled || draftConflict || (!draft.trim()&&!materials.length) ||
    (creating || !localCommand && (busy || submitting || pending || incomplete || !team && !homeReady));
  const refs=team ? [team.main,...team.secondary] : [];
  const models=boot.models || [];
  const unavailable=refs.filter(ref=>!models.some(m=>m.provider===ref.provider && m.modelId===ref.modelId));
  const missing=refs.filter(ref=>models.find(m=>m.provider===ref.provider && m.modelId===ref.modelId)?.api==="anthropic-messages" && ref.maxOutputTokens==null);
  const send=async()=>{if(!blocks&&(localCommand||!importing.current.get(importScope)))await onSubmit();};
  const optionDisabled=disabled||submitting||pending||creating||session?.contextOrganizing;
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
  const doAction=action=>{setOpenMenu(null);input.current?.focus();action();};
  const openFiles=()=>fileInput.current?.click();
  const toggleMenu=kind=>setOpenMenu(menu===kind?null:{kind,scope});
  const projectAction=session?.project?onChooseProjectFiles:onAssociateProject;
  const addActions=[
    onImportMaterials&&["添加文件或图片",openFiles],
    projectAction&&[session?.project?"选择项目文件":"选择项目文件 · 关联目录",projectAction],
    onChooseSkill&&["使用技能",onChooseSkill],
    onPlugins&&["插件命令",onPlugins]
  ].filter(Boolean);
  const chips=[
    readOnly&&["只分析",()=>setReadOnly(false)],
    !delegate&&["不委派",()=>setDelegate(true)],
    review&&["独立评审",()=>setReview(false)],
    maxCalls!==""&&[`最多 ${maxCalls} 次请求`,()=>setMaxCalls("")],
    options.readAllowed&&[readAllowed?`读取已保存版本：${readPaths||"未选范围"}`:"项目读取范围需重新确认",()=>onTurnOptions?.({readAllowed:false,readPaths:""})],
    selectedSkill&&[`技能：${typeof selectedSkill==="string"?selectedSkill:selectedSkill.name}`,onRemoveSkill],
    workRequest&&["制作网页 · 仅本次",()=>onWorkRequest?.(null)],
  ].filter(Boolean);

  return h("form",{className:"composer",onSubmit:e=>{e.preventDefault();send();},onKeyDown:e=>{
    if(e.key==="Escape"&&menu&&!composing.current&&!e.nativeEvent?.isComposing&&e.keyCode!==229){
      e.preventDefault();e.stopPropagation();setOpenMenu(null);
      toolbar.current?.querySelector(`[data-composer-trigger="${menu}"]`)?.focus();
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
  session?.selectionError && h("p",{className:"error-text",role:"alert"},session.selectionError," 当前记录保留；可重新读取，或切到健康对话继续。请先处理占用或诊断，不要重新发送结果未知的请求。"),
  session?.workspaceError && h("p",{className:"error-text",role:"alert"},session.workspaceError),
  session?.viewError && h("p",{className:"composer-notice",role:"status"},session.viewError),
  session?.contextOrganizing && h('p',{className:'composer-notice',role:'status'},'正在整理上下文；新输入暂留本机，结束后再保存。'),
  session?.contextOperation && h('p',{className:'composer-notice',role:'status'},`上下文整理：${session.contextOperation.applied?'已应用，可追溯原文':session.contextOperation.status} · ${session.contextOperation.requests?.filter(r=>r.sent).length??0} 次实际请求${session.contextOperation.preparation?' / 本次准备预计 '+session.contextOperation.preparation.expectedCalls+' 次':''}${session.contextOperation.error?' · '+session.contextOperation.error:''}`),
  draftConflict && h("div",{className:"composer-notice",role:"alert"},"保存稿已变化；当前本机输入保留。",
    h("button",{type:"button",onClick:()=>onResolveDraft?.("saved")},"读取保存稿"),
    h("button",{type:"button",onClick:()=>onResolveDraft?.("local")},"以本机稿再保存")),
  session && !team && !session.workspaceError && h("div",{className:"composer-notice"},
    session.rosterRequired || "发送前请选择阵容。",
    h("button",{type:"button",onClick:onSettings},"选择阵容")),
  session?.navigationError && h("p",{className:"error-text",role:"alert"},session.navigationError),
  session?.navigation?.archived && h("p",{className:"composer-notice"},"已归档；请先恢复对话再编辑或发送。"),
  session?.readOnly && !session?.selectionError && !session?.workspaceError && !session?.workspaceArchived && !session?.navigation?.archived && h("p",{className:"composer-notice"},"此会话当前只读。若被其他 CLI 或窗口占用，请先在该入口结束并关闭，再重新读取；不会强制接管。"),
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
  chips.length>0 && h("div",{className:"composer-chips","aria-label":"本次选择"},...chips.map(([label,remove])=>
    h("span",{key:label,className:"composer-chip"},
      h("span",{title:label},label),
      remove&&h("button",{type:"button",disabled:optionDisabled,onClick:remove,"aria-label":`移除${label}标记`},"×")))),
  onImportMaterials && h("input",{type:"file",hidden:true,multiple:true,ref:fileInput,accept:materialCapabilities?.mediaTypes?.join(","),
    onChange:e=>{const files=Array.from(e.target.files??[]);e.target.value="";importFiles(files);input.current?.focus();},
    onCancel:()=>input.current?.focus()}),
  h("label",{className:"sr-only",htmlFor:"message-input"},"输入问题"),
  h("textarea",{id:"message-input",ref:input,rows:2,value:draft,disabled,
    placeholder:busy ? "任务进行中，可以继续写草稿……" : "描述任务，或继续讨论……",
    onPaste:e=>{
      const files=Array.from(e.clipboardData?.files??[]).filter(file=>file.type.startsWith("image/"));
      if(files.length&&!optionDisabled&&onImportMaterials){e.preventDefault();importFiles(files);}
    },
    onChange:e=>onDraft(e.target.value),onCompositionStart:()=>{composing.current=true;},onCompositionEnd:()=>{composing.current=false;},
    onKeyDown:e=>{if(shouldSubmit({...e,keyCode:e.keyCode,isComposing:composing.current || e.nativeEvent?.isComposing})){e.preventDefault();send();}}
  }),
  h("div",{className:"composer-options",ref:toolbar},
    addActions.length>0 && h("button",{type:"button",disabled:optionDisabled,"aria-label":"添加本次操作","data-composer-trigger":"add","aria-expanded":menu==="add",onClick:()=>toggleMenu("add")},h(Icon,{name:"plus"})),
    menu==="add" && h("div",{className:"composer-add-menu composer-add-actions",ref:menuPanel},
      ...addActions.map(([label,action])=>h("button",{key:label,type:"button",disabled:optionDisabled,onClick:()=>doAction(action)},label))),
    h("button",{type:"button",disabled:optionDisabled,"data-composer-trigger":"options","aria-expanded":menu==="options",onClick:()=>toggleMenu("options")},"本次选项"),
    menu==="options" && h("div",{className:"composer-add-menu",ref:menuPanel},
      h("label",{className:"turn-choice"},h("input",{disabled:optionDisabled,type:"checkbox",checked:readOnly,onChange:e=>setReadOnly(e.target.checked)}),"只分析，不修改"),
      h("label",{className:"turn-choice"},h("input",{disabled:optionDisabled,type:"checkbox",checked:delegate,onChange:e=>setDelegate(e.target.checked)}),"允许工作委派"),
      h("label",{className:"turn-choice"},h("input",{disabled:optionDisabled,type:"checkbox",checked:review,onChange:e=>setReview(e.target.checked)}),"必须由不同型号独立评审"),
      h("label",null,"本轮最多模型请求（留空不设上限）",h("input",{disabled:optionDisabled,type:"number",min:0,step:1,value:maxCalls,onChange:e=>setMaxCalls(e.target.value)})),
      h("details",{className:"composer-policy"},h("summary",null,"调用与输出额度详情"),
    ...refs.map((ref,index)=>h("p",{key:`${ref.provider}/${ref.modelId}`},`${index===0 ? "主模型" : "副模型 "+index} ${ref.provider}/${ref.modelId}：${ref.maxOutputTokens==null ? (unavailable.includes(ref) ? "模型目录不可用，输出额度要求未知" : "未设本地输出上限") : ref.maxOutputTokens+" tokens"}${missing.includes(ref) ? "（协议必填，请在阵容中设置）" : ""}`)),
    h("p",null,"简单答复通常一次请求，读取材料后的续答、评审和正式工作按实际请求计账。默认不设调用上限；确认工作沿用提议剩余额度。没有默认模型超时；自动重试、压缩、预热关闭。未知用量与费用保持未知，目录估价不等于账单。"))),
    h("button",{type:"submit",className:"primary send",disabled:blocks,"aria-label":localTeam ? "打开阵容" : localCommand ? "打开本地命令" : submitting ? "确认提交" : pending ? "待确认" : busy ? "草稿保留" : "发送",title:localTeam ? "打开阵容" : "发送"},h(Icon,{name:submitting ? "more" : "send"}))
  ),

  );
}
