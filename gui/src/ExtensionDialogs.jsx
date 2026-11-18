import React, {useEffect,useState} from "react";
import {Modal} from "./Modal.jsx";

export function ExtensionPrompt({prompt, onAnswer}) {
  const [value, setValue] = useState(""), [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!prompt.expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [prompt.expiresAt]);
  const cancel = () => onAnswer(undefined, true);
  const selecting = prompt.kind === "select";
  return <Modal title={prompt.title} onClose={cancel}>
    <p>已安装插件的请求</p>
    {prompt.expiresAt && <p>将在 {Math.max(0, Math.ceil((prompt.expiresAt - now) / 1000))} 秒后关闭</p>}
    {prompt.kind === "confirm" ? <>
      <p>{prompt.message}</p>
      <div className="form-actions"><button onClick={() => onAnswer(true)}>确认</button><button onClick={cancel}>取消</button></div>
    </> : <form onSubmit={e => {e.preventDefault(); onAnswer(value);}}>
      {selecting ? <label>选择<select aria-label="插件选项" value={value} onChange={e => setValue(e.target.value)}>
        <option value="" disabled>请选择</option>
        {prompt.options.map((option, i) => <option key={i} value={option}>{option}</option>)}
      </select></label> : <label>输入<input aria-label="插件输入" value={value} placeholder={prompt.placeholder} onChange={e => setValue(e.target.value)} /></label>}
      <div className="form-actions">
        <button type="submit" disabled={selecting && !value}>继续</button>
        <button type="button" onClick={cancel}>取消</button>
      </div>
    </form>}
  </Modal>;
}

export function SkillChoices({items,onChoose,onSettings}) {
  const [query,setQuery]=useState("");
  const needle=query.trim().toLocaleLowerCase();
  const matches=items?.filter(item=>`${item.name} ${item.description??""}`.toLocaleLowerCase().includes(needle));
  if(!items)return <p role="status">正在读取此处可用的技能…</p>;
  if(!items.length)return <><p>当前没有可选技能。</p><button onClick={onSettings}>打开技能设置</button></>;
  const source={builtin:"内置",selected:"本地来源",package:"已安装包",project:"项目"};
  return <>
    <label>搜索技能<input value={query} onChange={event=>setQuery(event.target.value)} placeholder="名称或用途"/></label>
    <p className="field-note">只为当前输入显式选择一个技能；不会启用脚本或扩大文件权限。</p>
    <div className="material-skill-list">{matches.map(item=>
      <button type="button" key={item.name} onClick={()=>onChoose(item.name)}>
        <strong>{item.name}</strong> · {source[item.sourceKind]??"当前资源"}{item.explicitOnly?" · 仅手动使用":""}
        {item.description&&<small>{item.description}</small>}
      </button>)}
      {!matches.length&&<p>没有匹配的技能。</p>}
    </div>
  </>;
}
