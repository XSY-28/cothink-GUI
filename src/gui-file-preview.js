import { posix, extname } from 'node:path';
import {parse, serialize} from 'parse5';
import { FILE_LIMITS, format, raster, reject, text, unsupported, validateFilePath } from "./gui-file-content.js";

const HTML_TAGS=new Set('html head body title meta div span p h1 h2 h3 h4 h5 h6 section article main header footer nav aside figure figcaption blockquote pre code br hr strong em b i u s small sub sup mark time ul ol li dl dt dd table caption colgroup col thead tbody tfoot tr th td a img link style details summary'.split(' '));
const SVG_TAGS=new Set('svg g defs title desc path rect circle ellipse line polyline polygon text tspan linearGradient radialGradient stop clipPath mask pattern use image'.split(' '));
const ATTRS=new Set('id class title lang dir role style width height alt loading decoding colspan rowspan scope datetime open start reversed type viewBox preserveAspectRatio x y x1 x2 y1 y2 cx cy r rx ry d points fill fill-opacity fill-rule stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-opacity opacity transform font-family font-size font-weight text-anchor dominant-baseline dx dy offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod patternUnits patternContentUnits patternTransform clip-path clip-rule mask xmlns version'.toLowerCase().split(' '));
function cssSafe(css) {
  // A deliberately closed static CSS subset, not a sanitizer or a full CSS compiler.
  if(/[\\@<\x00-\x08]/.test(css))unsupported('此预览暂不支持该样式语法');
  const stripped=css.replace(/\/\*[\s\S]*?\*\//g,'');
  if(stripped.includes('/*')||/\b(?:url|image-set|image|cross-fade|element|expression|src)\s*\(/i.test(stripped)||/\b(?:behavior|-moz-binding)\s*:/i.test(stripped))unsupported('此预览暂不支持该样式资源引用');
  const functions=[...stripped.matchAll(/([a-zA-Z_-][\w-]*)\s*\(/g)].map(m=>m[1].toLowerCase());
  const allowed=new Set('rgb rgba hsl hsla hwb lab lch oklab oklch color calc min max clamp var env linear-gradient radial-gradient conic-gradient repeating-linear-gradient repeating-radial-gradient cubic-bezier steps translate translatex translatey scale scalex scaley rotate skew matrix blur brightness contrast grayscale hue-rotate invert opacity saturate sepia drop-shadow repeat minmax fit-content nth-child nth-of-type not is where has'.split(' '));
  if(functions.some(f=>!allowed.has(f)))unsupported('此预览无法可靠解释该样式函数');
  return css;
}
function resourcePath(from,url) {
  if(typeof url!=='string'||!url||url.trim()!==url||/[\\\x00-\x20\x7f]/.test(url.replaceAll(' ',''))||url.startsWith('/')||/^[a-z][a-z0-9+.-]*:/i.test(url)||/[?#]/.test(url)||/%(?:2f|5c)/i.test(url))unsupported('资源地址不是受支持的同版本相对路径');
  let decoded;try{decoded=decodeURIComponent(url);}catch{unsupported('资源地址编码无效');}
  if(/%[0-9a-f]{2}/i.test(decoded)||decoded.startsWith('/')||/[\\:]/.test(decoded))unsupported('资源地址包含不明确的路径编码');
  const path=posix.normalize(posix.join(posix.dirname(from),decoded));validateFilePath(path);return path;
}
export async function staticPreview(read, entryPath, entryBytes, tree) {
  const seen=new Map([[entryPath,entryBytes]]), stack=new Set([entryPath]);let total=entryBytes.length, derived=entryBytes.length;
  function account(value) {derived+=Buffer.byteLength(value);if(derived>FILE_LIMITS.derivedBytes)reject("FILE_TOO_LARGE","静态预览派生内容超过 16 MiB。");return value;}
  async function resource(from,url,depth,kind) {
    if(depth>FILE_LIMITS.depth)reject('FILE_TOO_LARGE','静态预览资源超过 4 层引用。');
    const path=resourcePath(from,url);
    if(stack.has(path))unsupported('静态预览存在循环资源引用');
    if(!seen.has(path)) {
      if(seen.size-1>=FILE_LIMITS.resources)reject('FILE_TOO_LARGE','静态预览超过 64 个资源。');
      const entry=tree.get(path);if(!entry)unsupported('同一固定版本缺少预览资源');
      const remaining=FILE_LIMITS.previewBytes-total;
      const bytes=await read(path,entry,Math.min(remaining,kind==='css'?FILE_LIMITS.textBytes:remaining));
      seen.set(path,bytes);total+=bytes.length;
    }
    const bytes=seen.get(path);
    if(kind==='css') {if(extname(path).toLowerCase()!=='.css')unsupported('样式资源不是 CSS');return account(cssSafe(text(bytes)));}
    const type=format(path);if(type.previewKind!=='image')unsupported('图片资源不是受支持的栅格图片');raster(bytes,type.mediaType);
    return account(`data:${type.mediaType};base64,${bytes.toString('base64')}`);
  }
  const source=text(entryBytes);
  if(extname(entryPath).toLowerCase()==='.svg'&&!/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(source))unsupported('SVG 根文档无效');
  const document=parse(source),ids=new Set(),references=[];
  async function visit(node) {
    if(node.tagName){
      const svg=node.namespaceURI==='http://www.w3.org/2000/svg',name=node.tagName;
      if(!(svg?SVG_TAGS:HTML_TAGS).has(name))unsupported(`静态预览不支持 ${name} 元素`);
      const attrs=node.attrs??[];
      if(name==='meta') {if(attrs.some(a=>a.name!=='charset'&&!(a.name==='name'&&a.value==='viewport')&&a.name!=='content'))unsupported('页面包含主动 meta 设置'); if(attrs.some(a=>a.name==='content')&&!attrs.some(a=>a.name==='name'&&a.value==='viewport'))unsupported('页面 meta 设置不受支持');}
      else if(name==='link') {
        if(attrs.find(a=>a.name==='rel')?.value.toLowerCase()!=='stylesheet'||attrs.some(a=>!['rel','href','media'].includes(a.name)))unsupported('页面包含不支持的链接资源');
        const css=await resource(entryPath,attrs.find(a=>a.name==='href')?.value,1,'css');
        node.tagName='style';node.nodeName='style';node.attrs=attrs.filter(a=>a.name==='media');node.childNodes=[{nodeName:'#text',value:css,parentNode:node}];
      } else {
        const safeAttrs=[];
        for(const a of attrs){
          const name=a.name.toLowerCase();
          if(node.tagName==='a'&&!svg&&['href','target','download','rel'].includes(name))continue;
          if(/^on/i.test(name)||a.prefix&&a.prefix!=='xlink')unsupported('页面包含事件或不支持的命名空间');
          if(name==='src'&&node.tagName==='img')a.value=await resource(entryPath,a.value,1,'image');
          else if(name==='href'&&svg) {
            if(node.tagName==='image')a.value=await resource(entryPath,a.value,1,'image');
            else if(node.tagName==='use'&&/^#[A-Za-z_][\w:.-]*$/.test(a.value))references.push(a.value.slice(1));
            else unsupported('SVG 引用不受支持');
          } else {
            if(!ATTRS.has(name)&&!name.startsWith('aria-')&&!name.startsWith('data-'))unsupported(`静态预览不支持 ${name} 属性`);
            if(name==='id')ids.add(a.value);
            if(name==='style')cssSafe(a.value);
            if(/url\s*\(/i.test(a.value)) {if(!svg||!['fill','stroke','clip-path','mask'].includes(name)||!/^url\(#[A-Za-z_][\w:.-]*\)$/.test(a.value))unsupported('SVG 或属性资源引用不受支持');references.push(a.value.slice(5,-1));}
          }
          safeAttrs.push(a);
        }
        node.attrs=safeAttrs;
      }
      if(node.tagName==='style') {for(const n of node.childNodes??[])if(n.nodeName==='#text')cssSafe(n.value);}
    }
    for(const child of node.childNodes??[])await visit(child);
    if(node.content)unsupported('静态预览不支持模板内容');
  }
  await visit(document);
  if(references.some(id=>!ids.has(id)))unsupported('SVG 局部引用缺少目标');
  const head=document.childNodes.find(n=>n.tagName==='html')?.childNodes.find(n=>n.tagName==='head');
  if(!head)unsupported('页面结构无法可靠读取');
  const policy="default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
  head.childNodes.unshift({nodeName:'meta',tagName:'meta',namespaceURI:'http://www.w3.org/1999/xhtml',attrs:[{name:'http-equiv',value:'Content-Security-Policy'},{name:'content',value:policy}],childNodes:[],parentNode:head});
  const bytes=Buffer.from(serialize(document));
  if(bytes.length>FILE_LIMITS.derivedBytes)reject('FILE_TOO_LARGE','静态预览派生内容超过 16 MiB，请下载原文件。');
  return bytes;
}
