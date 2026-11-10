const {contextBridge,ipcRenderer}=require('electron');
// Sandboxed subframes, including file previews, receive no system bridge.
if(process.isMainFrame) contextBridge.exposeInMainWorld('cothinkDesktop',Object.freeze({
  info:Object.freeze({installation:'desktop',protocolVersion:1,platform:process.platform}),
  writeClipboardText:text=>ipcRenderer.invoke('cothink:copy-text',text),
  readTheme:()=>ipcRenderer.invoke('cothink:theme:read'),
  writeTheme:theme=>ipcRenderer.invoke('cothink:theme:write',theme),
  chooseProjectDirectory:defaultPath=>ipcRenderer.invoke('cothink:directory',{requestId:globalThis.crypto.randomUUID(),defaultPath}),
  onPrepareClose:callback=>{
    if(typeof callback!=='function')throw TypeError('callback required');
    const listener=(_event,message)=>{if(typeof message?.requestId==='string' && ['prepare','resume'].includes(message.phase))callback({requestId:message.requestId,phase:message.phase});};
    ipcRenderer.on('cothink:prepare-close',listener);
    return ()=>ipcRenderer.removeListener('cothink:prepare-close',listener);
  },
  acknowledgeClose:({requestId,saved})=>{
    if(typeof requestId==='string' && typeof saved==='boolean')ipcRenderer.send('cothink:close-ack',{requestId,saved});
  },
}));
