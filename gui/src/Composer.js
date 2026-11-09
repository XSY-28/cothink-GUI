import {defaultTurnOptions} from "../../src/gui-turn-options.js";
import React, {useLayoutEffect,useRef,useState} from "react";
import {Icon} from "./Icon.js";
import {shouldSubmit} from "./view.js";
const h=React.createElement;
export function Composer({session,boot,draft,onDraft,onSubmit,onChange,busy,submitting,pending,onSettings,onPlugins,workRequest,onWorkRequest,draftConflict,onResolveDraft,turnOptions,onTurnOptions,onOrganize}) {
  const composing=useRef(false), input=useRef(null), [adding,setAdding]=useState(false), team=session?.team;
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
  const setReadAllowed=value=>onTurnOptions?.({readAllowed:value}),setReadPaths=value=>onTurnOptions?.({readPaths:value}),setReadOnly=value=>onTurnOptions?.({readOnly:value}),setDelegate=value=>onTurnOptions?.({delegate:value}),setReview=value=>onTurnOptions?.({review:value}),setMaxCalls=value=>onTurnOptions?.({maxCalls:value});
  const disabled=!session || session.navigation?.archived || !!session.navigationError || session.readOnly || !!session.selectionError;
  const localTeam=draft.trim()==="/team";
  const blocks=boot.protocol?.unified!==1 || disabled || draftConflict || !draft.trim() || (!localTeam && (busy || submitting || pending || !team));
  const refs=team ? [team.main,...team.secondary] : [];
  const models=boot.models || [];
  const unavailable=refs.filter(ref=>!models.some(m=>m.provider===ref.provider && m.modelId===ref.modelId));
  const missing=refs.filter(ref=>models.find(m=>m.provider===ref.provider && m.modelId===ref.modelId)?.api==="anthropic-messages" && ref.maxOutputTokens==null);
  const send=async()=>{if(!blocks)await onSubmit();};
  const optionDisabled=disabled||submitting||pending||session?.contextOrganizing;

  return h("form",{className:"composer",onSubmit:e=>{e.preventDefault();send();},onKeyDown:e=>{
    if(e.key==="Escape" && adding){e.preventDefault();setAdding(false);return;}

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
  session && !team && !session.workspaceError && h("p",{className:"composer-notice"},"发送前请在顶部选择阵容。"),
  session?.navigationError && h("p",{className:"error-text",role:"alert"},session.navigationError),
  session?.navigation?.archived && h("p",{className:"composer-notice"},"已归档；请先恢复对话再编辑或发送。"),
  session?.readOnly && !session?.selectionError && !session?.workspaceError && !session?.workspaceArchived && !session?.navigation?.archived && h("p",{className:"composer-notice"},"此会话当前只读。若被其他 CLI 或窗口占用，请先在该入口结束并关闭，再重新读取；不会强制接管。"),
  workRequest && h("div",{className:"composer-options"},h("span",null,"制作网页 · 仅本次"),h("button",{type:"button",disabled:disabled || submitting || pending,onClick:()=>onWorkRequest?.(null),"aria-label":"移除制作网页标记"},"×")),
  h("label",{className:"sr-only",htmlFor:"message-input"},"输入问题"),
  h("textarea",{id:"message-input",ref:input,rows:2,value:draft,disabled,
    placeholder:busy ? "任务进行中，可以继续写草稿……" : "描述任务，或继续讨论……",
    onChange:e=>onDraft(e.target.value),onCompositionStart:()=>{composing.current=true;},onCompositionEnd:()=>{composing.current=false;},
    onKeyDown:e=>{if(shouldSubmit({...e,keyCode:e.keyCode,isComposing:composing.current || e.nativeEvent?.isComposing})){e.preventDefault();send();}}
  }),
  h("div",{className:"composer-options"},
    h("button",{type:"button",disabled:disabled || submitting || pending,"aria-label":"添加本次操作","aria-expanded":adding,onClick:()=>setAdding(!adding)},h(Icon,{name:"plus"})),
    adding && h("div",{className:"composer-add-menu"},
      h('button',{type:'button',disabled:disabled||busy||submitting||pending||draftConflict||!team,onClick:()=>{setAdding(false);onOrganize?.();}},'整理上下文（会调用模型）'),
      h('p',null,'单次整理通常需要 1 次、split-turn 需要最多 2 次模型请求，按实际使用计费，沿用下方本轮请求上限。原文保留，自动压缩关闭。'),
      h("label",{className:"turn-choice"},h("input",{disabled:optionDisabled,type:"checkbox",checked:readOnly,onChange:e=>setReadOnly(e.target.checked)}),"只分析，不修改"),
      h("label",{className:"turn-choice"},h("input",{disabled:optionDisabled,type:"checkbox",checked:delegate,onChange:e=>setDelegate(e.target.checked)}),"允许工作委派"),
      h("label",{className:"turn-choice"},h("input",{disabled:optionDisabled,type:"checkbox",checked:review,onChange:e=>setReview(e.target.checked)}),"必须由不同型号独立评审"),
      h("label",null,"本轮最多模型请求（留空不设上限）",h("input",{disabled:optionDisabled,type:"number",min:0,step:1,value:maxCalls,onChange:e=>setMaxCalls(e.target.value)})),
      session?.project && h("div",{className:"turn-read-scope"},
        h("label",{className:"turn-choice"},h("input",{disabled:optionDisabled,type:"checkbox",checked:readAllowed,onChange:e=>setReadAllowed(e.target.checked)}),"本次允许读取项目文件"),
        readAllowed && h("label",null,"相对路径或子目录（逗号分隔，. 为全仓）",h("input",{disabled:optionDisabled,value:readPaths,onChange:e=>setReadPaths(e.target.value)})),
        h("p",null,session.project,"；只读提交时固定版本，不含未提交内容，不授予写入或命令权限。")),
      h("details",{className:"composer-policy"},h("summary",null,"调用与输出额度详情"),
    ...refs.map((ref,index)=>h("p",{key:`${ref.provider}/${ref.modelId}`},`${index===0 ? "主模型" : "副模型 "+index} ${ref.provider}/${ref.modelId}：${ref.maxOutputTokens==null ? (unavailable.includes(ref) ? "模型目录不可用，输出额度要求未知" : "未设本地输出上限") : ref.maxOutputTokens+" tokens"}${missing.includes(ref) ? "（协议必填，请在阵容中设置）" : ""}`)),
    h("p",null,"简单答复通常一次请求，读取材料后的续答、评审和正式工作按实际请求计账。默认不设调用上限；确认工作沿用提议剩余额度。没有默认模型超时；自动重试、压缩、预热关闭。未知用量与费用保持未知，目录估价不等于账单。"))),
    h("button",{type:"submit",className:"primary send",disabled:blocks,"aria-label":localTeam ? "打开阵容" : submitting ? "确认提交" : pending ? "待确认" : busy ? "草稿保留" : "发送",title:localTeam ? "打开阵容" : "发送"},h(Icon,{name:submitting ? "more" : "send"}))
  ),

  );
}
