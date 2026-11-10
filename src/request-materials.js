import { problem } from "./task.js";
import { materialImageHash, materialText, prepareMaterialImages } from "./context.js";

export const textOf = (m) =>
  m?.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n") ?? "";
export async function applyMaterials(binding, context, model, autoResize) {
  const {task,stage}=binding;
  const materials=binding.materials??(task.rootOwner&&stage.role!=="main"?[]:task.materialContext??[]);
  if(!materials.length||binding.stage.phase==="project-effect")return {context,images:[]};
  const required=binding.requiredPromptImages??[];
  if(required.length){
    const user=context.messages.findLast(message=>message.role==="user"&&Array.isArray(message.content)&&
      message.content.some(block=>block.type==="text"&&required.every(image=>block.text.includes(`materialId=${image.id};`))));
    const actual=user?.content.filter(block=>block.type==="image").map(materialImageHash)??[];
    for(const image of required){
      const index=actual.indexOf(image.payloadSha256);
      if(index<0)throw problem("MATERIAL_IMAGE_OMITTED","Pi 预处理后缺少已选图片。未发送模型请求。");
      actual.splice(index,1);
    }
  }
  const modelKey=JSON.stringify([model.provider,model.id,model.inputLimits?.images?.resize,autoResize]);
  if(binding.materialModelKey!==modelKey){
    binding.materialModelKey=modelKey;
    binding.preparedMaterials=prepareMaterialImages(materials,model,autoResize);
  }
  const prepared=await binding.preparedMaterials;
  const knownImages=new Set();
  const messages=context.messages.map(message=>{
    if(!Array.isArray(message.content)||!message.content.some(part=>part.type==="image"))return message;
    const candidates=message.role==="user"?prepared.filter(({evidence})=>
      message.cothinkInputMaterials?.some(ref=>ref.id===evidence.id)||
      message.content.some(part=>part.type==="text"&&part.text.includes(`materialId=${evidence.id};`))):[];
    let changed=false;
    const content=message.content.map(part=>{
      if(part.type!=="image")return part;
      const hash=materialImageHash(part);
      const replacement=candidates.some(({evidence})=>evidence.payloadSha256===hash)?undefined:
        candidates.find(({evidence,previousSha256})=>evidence.originalSha256===hash||previousSha256===hash);
      knownImages.add(replacement?.evidence.payloadSha256??hash);
      if(!replacement)return part;
      changed=true;
      return replacement.block;
    });
    return changed?{...message,content}:message;
  });
  context={...context,messages};
  const texts=context.messages.map(message=>typeof message.content==="string"?message.content:
    Array.isArray(message.content)?message.content.filter(block=>block.type==="text").map(block=>block.text).join("\n"):"");
  const included=new Set(),additional=[];
  for(const material of materials){
    const text=materialText(material);
    if(included.has(material.manifest.id))continue;
    included.add(material.manifest.id);
    if(!texts.some(value=>value.includes(text)))additional.push({type:"text",text});
  }
  const images=prepared.map(({block,evidence})=>{
    if(knownImages.has(evidence.payloadSha256))return evidence;
    additional.push(block);
    knownImages.add(evidence.payloadSha256);
    return evidence;
  });
  if(additional.length){
    const messages=[...context.messages];
    const index=messages.findLastIndex(message=>message.role==="user");
    messages.splice(Math.max(0,index),0,{role:"user",content:additional,timestamp:messages[index]?.timestamp??0});
    context={...context,messages};
  }
  return {context,images};
}
