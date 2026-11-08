import React, {useRef,useState} from "react";
import {shouldSubmit} from "./view.js";
const h=React.createElement;
export function Composer({session,boot,draft,onDraft,onSubmit,onChange,busy,submitting,pending,onSettings,onPlugins,workRequest,onWorkRequest,draftConflict,onResolveDraft}) {
  const composing=useRef(false), [adding,setAdding]=useState(false), team=session?.team;
  const disabled=!session || session.navigation?.archived || !!session.navigationError || session.readOnly || !!session.selectionError;
  const localTeam=draft.trim()==="/team";
  const blocks=disabled || draftConflict || !draft.trim() || (!localTeam && (busy || submitting || pending || !team));
  const one=session?.mode==="one" || /^\/one[ \t]+/.test(draft.trimStart());
  const refs=team ? (one ? [team.main] : [team.main,...team.secondary]) : [];
  const models=boot.models || [];
  const unavailable=refs.filter(ref=>!models.some(m=>m.provider===ref.provider && m.modelId===ref.modelId));
  const missing=refs.filter(ref=>models.find(m=>m.provider===ref.provider && m.modelId===ref.modelId)?.api==="anthropic-messages" && ref.maxOutputTokens==null);
  const send=()=>{if(!blocks)onSubmit();};
  return h("form",{className:"composer",onSubmit:e=>{e.preventDefault();send();},onKeyDown:e=>{
    if(e.key==="Escape" && adding){e.preventDefault();setAdding(false);return;}
    if(e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.code==="KeyM" || (!e.code && e.key.toLowerCase()==="m")) &&
      !composing.current && !e.nativeEvent?.isComposing && e.keyCode!==229){
      e.preventDefault();if(!e.repeat && !disabled && !submitting && !pending)onChange("session.mode",{mode:session.mode==="one" ? "cothink" : "one"});
    }
  }},
  session?.selectionError && h("p",{className:"error-text",role:"alert"},session.selectionError," 当前记录保留；可重新读取，或切到健康对话继续。请先处理占用或诊断，不要重新发送结果未知的请求。"),
  session?.workspaceError && h("p",{className:"error-text",role:"alert"},session.workspaceError),
  session?.viewError && h("p",{className:"composer-notice",role:"status"},session.viewError),
  draftConflict && h("div",{className:"composer-notice",role:"alert"},"保存稿已变化；当前本机输入保留。",
    h("button",{type:"button",onClick:()=>onResolveDraft?.("saved")},"读取保存稿"),
    h("button",{type:"button",onClick:()=>onResolveDraft?.("local")},"以本机稿再保存")),
  session && !team && !session.workspaceError && h("p",{className:"composer-notice"},"发送前请在顶部选择阵容。"),
  session?.navigationError && h("p",{className:"error-text",role:"alert"},session.navigationError),
  session?.navigation?.archived && h("p",{className:"composer-notice"},"已归档；请先恢复对话再编辑或发送。"),
  session?.readOnly && !session?.selectionError && !session?.workspaceError && !session?.workspaceArchived && !session?.navigation?.archived && h("p",{className:"composer-notice"},"此会话当前只读。若被其他 CLI 或窗口占用，请先在该入口结束并关闭，再重新读取；不会强制接管。"),
  workRequest && h("div",{className:"composer-options"},h("span",null,"制作网页 · 仅本次"),h("button",{type:"button",disabled:disabled || submitting || pending,onClick:()=>onWorkRequest?.(null),"aria-label":"移除制作网页标记"},"×")),
  h("label",{className:"sr-only",htmlFor:"message-input"},"输入问题"),
  h("textarea",{id:"message-input",rows:2,value:draft,disabled,
    placeholder:busy ? "任务进行中，可以继续写草稿……" : "描述要完成的工作……",
    onChange:e=>onDraft(e.target.value),onCompositionStart:()=>{composing.current=true;},onCompositionEnd:()=>{composing.current=false;},
    onKeyDown:e=>{if(shouldSubmit({...e,keyCode:e.keyCode,isComposing:composing.current || e.nativeEvent?.isComposing})){e.preventDefault();send();}}
  }),
  h("div",{className:"composer-options"},
    h("button",{type:"button",disabled:disabled || submitting || pending,"aria-label":"添加本次操作","aria-expanded":adding,onClick:()=>setAdding(!adding)},"＋"),
    adding && h("div",{className:"composer-add-menu"},
      h("button",{type:"button",disabled:disabled || submitting || pending,onClick:()=>{onWorkRequest?.({kind:"html-svg"});setAdding(false);}},"制作 HTML/SVG"),
      h("button",{type:"button",disabled:disabled || busy || submitting || pending || !team,onClick:()=>{setAdding(false);onPlugins();}},"插件命令"),
      h("details",{className:"composer-policy"},h("summary",null,"调用与输出额度详情"),
    ...refs.map((ref,index)=>h("p",{key:`${ref.provider}/${ref.modelId}`},`${index===0 ? "主模型" : "副模型 "+index} ${ref.provider}/${ref.modelId}：${ref.maxOutputTokens==null ? (unavailable.includes(ref) ? "模型目录不可用，输出额度要求未知" : "未设本地输出上限") : ref.maxOutputTokens+" tokens"}${missing.includes(ref) ? "（协议必填，请在阵容中设置）" : ""}`)),
    h("p",null,"ONE 问答一次，CoThink 问答三次；工作调用次数不限，单模型工作仅以主模型作为正式负责人，可使用已安装的插件助手。没有默认模型超时；自动重试、压缩、预热关闭。未知用量与费用保持未知，目录估价不等于账单。"))),
    h("label",{className:"control-label"},h("span",{className:"sr-only"},busy ? "下一条模式" : "模式"),h("select",{
      "aria-label":"对话模式","aria-keyshortcuts":"Alt+M",title:"Option+M / Alt+M 切换模式（输入区内）",value:session?.mode || "cothink",disabled:disabled || submitting || !!pending,
      onChange:e=>onChange("session.mode",{mode:e.target.value})},h("option",{value:"cothink"},"多模型"),h("option",{value:"one"},"单模型"))),
    h("button",{type:"submit",className:"primary send",disabled:blocks,"aria-label":localTeam ? "打开阵容" : submitting ? "确认提交" : pending ? "待确认" : busy ? "草稿保留" : "发送",title:localTeam ? "打开阵容" : "发送"},h("span",{"aria-hidden":true},submitting ? "…" : "↑"))
  ),

  );
}
