import React, {createContext,useContext,useEffect,useRef,useState} from "react";
import ReactMarkdown, {defaultUrlTransform} from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {copyText} from "./api.js";

const h=React.createElement;
const ImageResolver=createContext(null);
const trustedTypes=new Set(["image/png","image/jpeg","image/webp"]);
function localImageReference(src) {
  if(/^(?:cothink-)?material:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(src))return true;
  if(!src)return false;
  try {
    const path=decodeURIComponent(src);
    return !/^[\/\\]|[:\\?#\x00-\x1f\x7f]/.test(path) && !path.split("/").includes("..");
  } catch { return false; }
}
function httpsImage(src) {
  if(!/^https:\/\//i.test(src))return null;
  try {
    const url=new URL(src);
    return url.hostname&&!url.username&&!url.password?url:null;
  } catch {return null;}
}

function MarkdownImage({src="",alt=""}) {
  const resolveImage=useContext(ImageResolver);
  const local=localImageReference(src)&&typeof resolveImage==="function";
  const remote=httpsImage(src);
  const [state,setState]=useState({status:"idle"});
  useEffect(()=>{
    if(!local)return;
    let current=true,objectUrl;
    Promise.resolve().then(()=>resolveImage(src)).then(blob=>{
      if(!current)return;
      if(!blob||!trustedTypes.has(blob.type)){
        setState({status:"unavailable"});return;
      }
      objectUrl=URL.createObjectURL(blob);
      setState({status:"loaded",url:objectUrl});
    }).catch(()=>{if(current)setState({status:"unavailable"});});
    return()=>{current=false;if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[local,src,resolveImage]);
  if(state.status==="loaded")return h("img",{className:"markdown-image",src:state.url,alt,
    referrerPolicy:"no-referrer",decoding:"async",onError:()=>setState({status:"unavailable"})});
  return h("span",{className:"image-placeholder"},
    alt?alt+" · ":null,
    remote?remote.hostname:local&&state.status==="idle"?"正在读取图片…":"图片不可用",
    remote&&state.status==="idle"&&h("button",{type:"button",onClick:()=>setState({status:"loaded",url:remote.href})},"加载图片"),
    remote&&state.status==="unavailable"&&h(React.Fragment,null," · 加载失败 · ",
      h("a",{href:remote.href,target:"_blank",rel:"noopener noreferrer"},"打开来源")));
}

function MarkdownCodeBlock({children}) {
  const block=useRef(null),[status,setStatus]=useState("");
  async function copy() {
    try {
      await copyText(block.current?.textContent??"");
      setStatus("已复制");
    } catch {setStatus("复制失败，请手动选中");}
  }
  return h("div",{className:"markdown-code-block"},
    h("button",{type:"button",onClick:copy},"复制代码"),status&&h("span",{role:"status"},status),
    h("pre",{ref:block},children));
}

const components={
  img:({src,alt})=>h(MarkdownImage,{key:src,src,alt}),
  pre:MarkdownCodeBlock,
  a:({href,children})=>h("a",{href,target:"_blank",rel:"noreferrer noopener"},children),
};

export function Markdown({text,resolveImage}) {
  return h(ImageResolver.Provider,{value:resolveImage},h(ReactMarkdown,{
    remarkPlugins:[remarkGfm,remarkMath],
    rehypePlugins:[[rehypeKatex,{throwOnError:false,trust:false,strict:"ignore"}]],
    skipHtml:true,
    urlTransform:(url,key,node)=>key==="src"&&node.tagName==="img"&&localImageReference(url)?url:defaultUrlTransform(url),
    components,
  },text||""));
}
