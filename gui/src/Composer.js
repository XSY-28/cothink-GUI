import {defaultTurnOptions,editorReadPaths,guiNetworkChoice,isGuiFileTask} from "../../src/gui-turn-options.js";
import {materialExtensions} from "../../src/gui-material-types.js";
import React, {useEffect,useLayoutEffect,useRef,useState} from "react";
import {Icon} from "./Icon.js";
import {shouldSubmit} from "./view.js";
const h=React.createElement;
export function Composer({session,boot,draft,onDraft,onSubmit,busy,submitting,pending,onSettings,onPlugins,workRequest,onWorkRequest,draftConflict,onResolveDraft,turnOptions,onTurnOptions,onOpenTurnLimits,homeReady=false,creating=false,editorKey,materials=[],materialCapabilities,materialError,onImportMaterials,onRemoveMaterial,onRetryMaterial,onPreviewMaterial,onChooseProjectFiles,onAssociateProject,onPrepareProject,onWorkspaceMenu,onChooseSkill,selectedSkill,onRemoveSkill,onUseTeamDirectory}) {
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
  const {readPaths,readOnly,delegate,review,maxCalls}=options;
  const readAllowed=options.readAllowed&&options.readProject===session?.project&&options.readWorkspaceId===(session?.workspaceId??null);
  const disabled=(!session && !homeReady) || session?.navigation?.archived || !!session?.navigationError || !!session?.readOnly || !!session?.selectionError;
  const localCommand=/^\/(?:team|models|settings|help)$/.test(draft.trim());
  const localTeam=/^\/(?:team|models)$/.test(draft.trim());
  const fileTask=!localCommand&&isGuiFileTask(draft,{readOnly,fileWork:options.fileWork||!!workRequest});
  const network=localCommand?null:guiNetworkChoice(draft,options);
  const networkBlocked=network==="choose"||network==="whole-turn-offline";
  const projectStatus=session?.projectStatus;
  const fileReady=!!session?.project&&projectStatus?.executionReady===true;
  const executionMissing=fileTask&&fileReady&&!!boot.work&&!boot.work.execution;
  const fileStatus=!session?.project ? "未关联项目目录" :
    fileReady ? "目录已准备" :
    session.projectDirectoryAvailable===false ? "目录不可用" : "目录尚未准备";
  const incomplete=!!importing.current.get(importScope)||materials.some(item=>item.status!=="ready");
  const blocks=boot.protocol?.unified!==1 || disabled || draftConflict || (!draft.trim()&&!materials.length) ||
    (creating || !localCommand && (busy || submitting || pending || incomplete || !team && !homeReady ||
      fileTask && !fileReady || executionMissing || networkBlocked));
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
  const doAction=action=>{setAddingFor(undefined);input.current?.focus();action();};
  const openFiles=()=>fileInput.current?.click();
  const projectAction=session?.project?onChooseProjectFiles:onAssociateProject;
  const addActions=[
    onImportMaterials&&["添加文件或图片",openFiles],
    onTurnOptions&&!readOnly&&["文件任务",()=>onTurnOptions({fileWork:true})],
    projectAction&&[session?.project?"选择项目文件":"选择项目文件 · 关联目录",projectAction],
    onChooseSkill&&["使用技能",onChooseSkill],
    onPlugins&&["插件命令",onPlugins]
  ].filter(Boolean);
  const chips=[
    readOnly&&["read-only","只分析",()=>onTurnOptions?.({readOnly:false}),onOpenTurnLimits],
    delegate!==true&&["dispatch",delegate===false&&!review?"禁止派工及按需评审（旧限制）":"禁止派工",()=>onTurnOptions?.({delegate:true}),onOpenTurnLimits],
    review&&["review","独立评审",()=>onTurnOptions?.({review:false}),onOpenTurnLimits],
    maxCalls!==""&&["max-calls",`最多 ${maxCalls} 次请求`,()=>onTurnOptions?.({maxCalls:""}),onOpenTurnLimits],
    options.readAllowed&&["read-scope",readAllowed?`读取已保存版本：${editorReadPaths(readPaths).join("、")||"未选范围"}`:"项目读取范围需重新确认",()=>onTurnOptions?.({readAllowed:false,readPaths:[]})],
    selectedSkill&&["skill",`技能：${typeof selectedSkill==="string"?selectedSkill:selectedSkill.name}`,onRemoveSkill],
    options.fileWork&&!readOnly&&["file-work","文件任务 · 仅本次",()=>onTurnOptions?.({fileWork:false})],
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
  chips.length>0 && h("div",{className:"composer-chips","aria-label":"本次选择"},...chips.map(([key,label,remove,edit])=>
    h("span",{key,className:"composer-chip"},
      edit ? h("button",{type:"button",className:"chip-edit",title:label,disabled:optionDisabled,onClick:event=>edit(event.currentTarget),"aria-label":`修改${label}`,"aria-haspopup":"dialog"},label)
        : h("span",{title:label},label),
      remove&&h("button",{type:"button",disabled:optionDisabled,onClick:()=>{remove();input.current?.focus();},"aria-label":`移除${label}标记`},"×")))),
  onImportMaterials && h("input",{type:"file",hidden:true,multiple:true,ref:fileInput,accept:[...(materialCapabilities?.mediaTypes??[]),...materialExtensions].join(","),
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
  fileTask && h("div",{className:"composer-file-status"},
    h("div",{className:"composer-file-path",role:"status"},
      h("span",{className:fileReady?"":"file-not-ready"},fileStatus),
      session?.project&&h("span",{title:session.project},session.project)),
    !fileReady && projectStatus?.homeDirectory && h("small",null,"请选择专用项目文件夹后新建对话。"),
    !fileReady && !projectStatus?.homeDirectory && projectStatus?.reason && h("small",null,projectStatus.reason),
    executionMissing && h("small",{role:"status"},"执行环境未配置。可在设置中配置 Docker 和执行镜像。"),
    (!fileReady||executionMissing||onUseTeamDirectory) && h("div",{className:"composer-file-actions"},
      onUseTeamDirectory&&h("button",{type:"button",disabled:optionDisabled,onClick:onUseTeamDirectory},"用新目录继续"),
      !fileReady&&onPrepareProject&&!projectStatus?.homeDirectory&&h("button",{type:"button",disabled:optionDisabled,onClick:onPrepareProject},"准备文件工作"),
      onWorkspaceMenu&&session?.project
        ? h("button",{type:"button",disabled:optionDisabled,onClick:onWorkspaceMenu},"查看 Team 目录")
        : !session?.project&&onAssociateProject&&h("button",{type:"button",disabled:optionDisabled,onClick:onAssociateProject},"选择项目目录"),
      (!fileReady||executionMissing)&&onTurnOptions&&h("button",{type:"button",disabled:optionDisabled,onClick:()=>onTurnOptions({fileWork:false,readOnly:true})},"只聊这件事"))),
  network && h("div",{className:"composer-file-status",role:"status"},
    network==="choose" ? h(React.Fragment,null,
      "这次需要整轮离线，还是只要求成品离线？模型请求与成品运行是两个环节。",
      h("div",{className:"composer-file-actions"},
        h("button",{type:"button",disabled:optionDisabled,onClick:()=>onTurnOptions?.({networkMode:"artifact-offline"})},"只要求成品离线"),
        h("button",{type:"button",disabled:optionDisabled,onClick:()=>onTurnOptions?.({networkMode:"whole-turn-offline"})},"整轮不联网"))) :
      network==="whole-turn-offline" ? "这条消息要求整轮离线。当前不能保证模型调用离线，发送已暂停。" :
      "只要求成品离线。发送仍会调用模型服务，成品离线性需要验证。",
    options.networkMode && h("div",{className:"composer-file-actions"},
      h("button",{type:"button",disabled:optionDisabled,onClick:()=>onTurnOptions?.({networkMode:null})},"重新选择联网要求"))),
  h("div",{className:"composer-options"},
    addActions.length>0 && h("button",{type:"button",ref:addTrigger,disabled:optionDisabled,"aria-label":"添加本次操作","aria-expanded":adding,onClick:()=>setAddingFor(adding?undefined:scope)},h(Icon,{name:"plus"})),
    adding && h("div",{className:"composer-add-menu composer-add-actions",ref:menuPanel},
      ...addActions.map(([label,action])=>h("button",{key:label,type:"button",disabled:optionDisabled,onClick:()=>doAction(action)},label))),
    h("button",{type:"submit",className:"primary send",disabled:blocks,"aria-label":localTeam ? "打开阵容" : localCommand ? "打开本地命令" : submitting ? "确认提交" : pending ? "待确认" : busy ? "草稿保留" : "发送",title:localTeam ? "打开阵容" : "发送"},h(Icon,{name:submitting ? "more" : "send"}))
  ),

  );
}
