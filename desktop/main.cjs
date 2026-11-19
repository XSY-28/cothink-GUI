const {app,BrowserWindow,Menu,ipcMain,dialog,shell,clipboard}=require('electron');
const {spawn}=require('node:child_process');
const {dirname,isAbsolute,join}=require('node:path');
const {readFileSync,realpathSync,statSync,writeFileSync,renameSync,rmSync}=require('node:fs');
const {randomUUID}=require('node:crypto');
app.setName('CoThink');
let win,child,origin,ready=false,hostStopped=false,exiting=false,quitting=false,quitId;
let startupFailureShown=false,finalAckTimer;
const directoryRequests=new Set();
let lastSelectedDirectory;
const absolutePath=value=>typeof value==='string' && value.length<=32768 && !value.includes('\0') && isAbsolute(value);
function availableDirectory(value) {
  if (!absolutePath(value)) return undefined;
  try { const path=realpathSync(value); return statSync(path).isDirectory()?path:undefined; }
  catch { return undefined; }
}
let pendingClose,drained=false,draftsSaved=false,pageLoaded=false,rendererCrashed=false,finalRequested=false,closedEditorId;
const build=JSON.parse(readFileSync(join(__dirname,'build.json'),'utf8'));
const validId=value=>typeof value==='string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
const validTheme=value=>value==='light'||value==='dark';
const trusted=event=>win && !win.isDestroyed() && event.sender===win.webContents &&
  event.senderFrame===win.webContents.mainFrame && origin && new URL(event.senderFrame.url).origin===origin;
function focus() {if(win && !win.isDestroyed()){win.show();win.restore();win.focus();}}
function explain(message) {focus();void dialog.showMessageBox(win && !win.isDestroyed()?win:undefined,{type:'warning',title:'CoThink',message,buttons:['返回核对']});}
function startupFailure(message) {
  if(startupFailureShown)return;
  startupFailureShown=true;
  explain(message);
}
function send(message) {if(child?.connected)child.send(message,()=>{});}
function trustedExternal(value) {
  try {const url=new URL(value);if(['http:','https:'].includes(url.protocol) && !url.username && !url.password) void shell.openExternal(url.href).catch(()=>explain('无法打开外部链接，请在浏览器中手动打开。'));} catch {}
}
function resumeEditing() {
  if(closedEditorId && win && !win.isDestroyed()) {
    win.webContents.send('cothink:prepare-close',{requestId:closedEditorId,phase:'resume'});
    closedEditorId=null;
  }
}
function clearFinalWait() {
  clearTimeout(finalAckTimer);
  finalAckTimer=undefined;
}
function requestFinalAck() {
  finalRequested=true;
  finalAckTimer=setTimeout(()=>{
    finalAckTimer=undefined;
    explain('最终退出尚未确认。草稿已保存，窗口暂时锁定。再次选择退出可核对同一次停止。');
  },15000);
  send({type:'prepareShutdown',requestId:quitId,finalize:true});
}
function finishQuit() {
  if(!quitting || !drained || !child?.connected || finalRequested) return;
  if(!draftsSaved) {
    if(!pageLoaded) draftsSaved=true;
    else if(rendererCrashed) {
      if(pendingClose)return;
      pendingClose={requestId:quitId,kind:'crashed'};
      void dialog.showMessageBox(win,{type:'warning',message:'页面已崩溃，无法刷新未保存输入。只保留宿主已保存草稿并退出？',buttons:['返回核对','退出'],defaultId:0,cancelId:0}).then(result=>{
        pendingClose=null;
        if(result.response===1){draftsSaved=true;finishQuit();}
      });
      return;
    } else {flushForClose('quit');return;}
  }
  requestFinalAck();
}
function flushForClose(kind) {
  if(pendingClose) return;
  if(!ready || rendererCrashed) {
    explain('页面未就绪或已经崩溃。仅宿主已保存的草稿可恢复；请通过菜单明确重新打开页面，再核对退出。');return;
  }
  const requestId=randomUUID();
  const timer=setTimeout(()=>{
    if(pendingClose?.requestId!==requestId)return;
    pendingClose=null;resumeEditing();explain('未收到草稿保存确认，窗口继续保留。请核对连接和未保存输入后再次退出。');
  },15000);
  pendingClose={requestId,kind,timer};closedEditorId=requestId;
  win.webContents.send('cothink:prepare-close',{requestId,phase:'prepare'});
}
function requestQuit() {
  if(exiting)return;
  // After an unconfirmed child death, a later explicit user Quit may exit.
  // The in-progress guard only applies while that child is still running.
  if(!child || hostStopped){exiting=true;app.quit();return;}
  if(finalRequested) {
    if(!finalAckTimer)requestFinalAck();
    return;
  }
  if(quitting && pendingClose)return;
  quitting=true;quitId ??=randomUUID();drained=false;draftsSaved=false;finalRequested=false;
  // Freeze and drain immediately; keep reads and draft persistence until both acknowledge.
  send({type:'prepareShutdown',requestId:quitId,finalize:false});
  if(pendingClose) {clearTimeout(pendingClose.timer);pendingClose=null;}
  resumeEditing();
  // Edits remain available during drain. The only authoritative draft flush
  // happens after phase one, with the renderer kept inert until final close.

}
if(!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',focus);
  app.on('activate',focus);
  app.on('before-quit',event=>{if(!exiting){event.preventDefault();requestQuit();}});
  app.on('window-all-closed',()=>{if(process.platform!=='darwin')requestQuit();});
  app.whenReady().then(()=>{
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label:'CoThink',submenu:[{label:'关于 CoThink',click:()=>dialog.showMessageBox({title:'CoThink',message:`CoThink ${build.backendVersion}`,detail:`构建标识：${build.buildId}\n独立桌面本地候选；尚未签名、公证或发布。`})},{type:'separator'},{role:'hide',label:'隐藏 CoThink'},{role:'hideOthers',label:'隐藏其他应用'},{role:'unhide',label:'全部显示'},{type:'separator'},{label:'退出 CoThink',accelerator:'CmdOrCtrl+Q',click:requestQuit}]},
      {label:'编辑',submenu:[{role:'undo',label:'撤销'},{role:'redo',label:'重做'},{type:'separator'},{role:'cut',label:'剪切'},{role:'copy',label:'复制'},{role:'paste',label:'粘贴'},{role:'selectAll',label:'全选'}]},
      {label:'窗口',submenu:[{role:'minimize',label:'最小化'},{label:'显示 CoThink',click:focus},{label:'重新打开已保存页面',click:async()=>{
        if(finalRequested && !finalAckTimer){explain('最终退出尚未确认。请再次选择退出以核对。');return;}
        if(pendingClose || finalRequested){explain('正在确认最终保存与停止，请等待结果后再重新打开页面。');return;}
        if(!ready || hostStopped) {explain('宿主已停止，请重新启动 CoThink；不会自动重发任何任务。');return;}
        const result=await dialog.showMessageBox(win,{type:'warning',message:'重新打开页面仅恢复已保存内容。当前未保存的输入会丢失。',buttons:['取消','重新打开'],defaultId:0,cancelId:0});
        if(result.response===1)win.webContents.reload();
      }}]},
    ]));
    win=new BrowserWindow({width:1280,height:880,minWidth:760,minHeight:560,title:'CoThink',show:false,backgroundColor:'#fcfcfb',
      ...(process.platform==='darwin'?{titleBarStyle:'hiddenInset',trafficLightPosition:{x:18,y:21}}:{}),
      icon:join(__dirname,'assets/icon.png'),webPreferences:{preload:join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webviewTag:false,devTools:false}});
    win.on('page-title-updated',event=>{event.preventDefault();win.setTitle('CoThink');});
    win.on('show',()=>{if(!quitting)resumeEditing();});
    win.on('close',event=>{if(!exiting){event.preventDefault();if(process.platform==='darwin'&&!quitting)flushForClose('hide');else requestQuit();}});
    win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    win.webContents.session.setPermissionCheckHandler(()=>false);
    win.webContents.on('will-attach-webview',event=>event.preventDefault());
    win.webContents.on('will-navigate',(event,url)=>{
      if(!origin || new URL(url).origin!==origin){event.preventDefault();trustedExternal(url);}
    });
    win.webContents.setWindowOpenHandler(({url})=>{trustedExternal(url);return {action:'deny'};});
    win.webContents.on('did-finish-load',()=>{pageLoaded=true;rendererCrashed=false;});
    win.webContents.on('render-process-gone',()=>{
      rendererCrashed=true;
      if(pendingClose){clearTimeout(pendingClose.timer);pendingClose=null;}
      if(!ready || !pageLoaded){startupFailure('页面在启动时停止。请重新打开 CoThink。');return;}
      explain('页面进程已停止。宿主只保留已确认保存的草稿；任务不会因为页面重开而重发。请从窗口菜单重新打开已保存页面。');
    });
    ipcMain.handle('cothink:directory',async(event,{requestId,defaultPath}={})=>{
      if(!trusted(event)||!validId(requestId)||quitting||directoryRequests.has(requestId))throw Error('目录选择请求无效。');
      directoryRequests.add(requestId);
      if(directoryRequests.size>256)directoryRequests.delete(directoryRequests.values().next().value);
      const frame=event.senderFrame;
      const directory=availableDirectory(defaultPath) ?? availableDirectory(lastSelectedDirectory) ??
        (absolutePath(defaultPath)?availableDirectory(dirname(defaultPath)):undefined);
      const result=await dialog.showOpenDialog(win,{title:'选择或新建 CoThink 项目目录',properties:['openDirectory','createDirectory'],
        ...(directory && {defaultPath:directory})});
      if(!trusted(event)||frame!==win.webContents.mainFrame)throw Error('页面身份已改变。');
      if (result.canceled) return null;
      const selected=availableDirectory(result.filePaths[0]);
      if (selected) lastSelectedDirectory=selected;
      return selected??null;
    });
    ipcMain.handle('cothink:copy-text',(event,text)=>{
      if(!trusted(event)||typeof text!=='string')throw Error('剪贴板写入请求无效。');
      return clipboard.writeText(text);
    });
    const themePath=join(app.getPath('userData'),'cothink-theme');
    ipcMain.handle('cothink:theme:read',event=>{
      if(!trusted(event))throw Error('读取界面主题请求无效。');
      try {
        const theme=readFileSync(themePath,'utf8');
        return validTheme(theme)?theme:null;
      } catch(error) {
        if(error.code==='ENOENT')return null;
        throw error;
      }
    });
    ipcMain.handle('cothink:theme:write',(event,theme)=>{
      if(!trusted(event)||!validTheme(theme))throw Error('保存界面主题请求无效。');
      const temporary=themePath+'.'+randomUUID()+'.tmp';
      writeFileSync(temporary,theme,{mode:0o600,flag:'wx'});
      try { renameSync(temporary,themePath); }
      catch(error) { rmSync(temporary,{force:true});throw error; }
    });
    ipcMain.on('cothink:close-ack',(event,value)=>{
      if(!trusted(event)||!pendingClose||!value||Object.keys(value).some(k=>!['requestId','saved'].includes(k))||value.requestId!==pendingClose.requestId||typeof value.saved!=='boolean')return;
      const pending=pendingClose;clearTimeout(pending.timer);pendingClose=null;
      if(!value.saved){resumeEditing();explain('草稿尚未保存，窗口继续保留。请处理页面上的保存错误，再次关闭或退出。');return;}
      if(pending.kind==='hide'&&!quitting)win.hide();
      else {draftsSaved=true;finishQuit();}
    });
    if(process.env.NODE_OPTIONS||process.env.NODE_PATH||process.env.ELECTRON_RUN_AS_NODE){
      startupFailure('检测到 Node 预加载环境。请移除 NODE_OPTIONS、NODE_PATH 或 ELECTRON_RUN_AS_NODE 后重新打开 App。');return;
    }
    const nonce=randomUUID();
    const backendEnv={...process.env,COTHINK_DESKTOP_NONCE:nonce,COTHINK_NO_UPDATE_CHECK:'1'};
    if(process.platform==='darwin')backendEnv.PATH=[process.env.PATH||'/usr/bin:/bin:/usr/sbin:/sbin',join(app.getPath('home'),'.docker/bin'),
      '/usr/local/bin','/opt/homebrew/bin','/Applications/Docker.app/Contents/Resources/bin'].filter(Boolean).join(':');
    const nodeExecutable=process.platform==='win32'?'node.exe':'node';
    child=spawn(join(process.resourcesPath,'node','bin',nodeExecutable),[join(__dirname,'host.mjs')],{
      cwd:__dirname,env:backendEnv,stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,
    });
    const startupTimer=setTimeout(()=>{if(!ready){startupFailure('后台未完成启动。请检查 App 资源是否完整；退出后重新打开，不会重发任务。');requestQuit();}},30000);
    child.on('error',()=>{clearTimeout(startupTimer);hostStopped=true;startupFailure('随包 Node 无法启动。请重新生成或取得完整的 CoThink App；不需要安装全局 Node。');});
    child.on('exit',(code,signal)=>{
      clearTimeout(startupTimer);clearFinalWait();hostStopped=true;
      if(exiting)return;
      if(!ready || !pageLoaded) {
        startupFailure(`后台在页面就绪前停止（${signal || 'exit '+code}）。请核对数据根权限、配置和 App 资源。`);
        return;
      }
      resumeEditing();
      if(pendingClose){clearTimeout(pendingClose.timer);pendingClose=null;}
      explain(`本地宿主已停止（${signal || 'exit '+code}），未收到最终停止确认。已加载内容继续保留；新提交不可用。请核对后明确退出，重新打开仅恢复已保存事实。`);
    });
    child.on('message',message=>{
      if(message?.type==='ready'&&!ready&&!startupFailureShown) {
        let url;try {url=new URL(message.origin);}catch{return;}
        if(message.nonce!==nonce||message.protocolVersion!==build.protocolVersion||message.buildId!==build.buildId||message.backendVersion!==build.backendVersion||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.pathname!=='/'||url.search||url.hash||url.username||url.password||!/^[A-Za-z0-9_-]{43}$/.test(message.token)){
          startupFailure('后台身份与 App 构建不匹配，未打开输入页面。请重新生成完整候选。');requestQuit();return;
        }
        clearTimeout(startupTimer);origin=url.origin;ready=true;
        void win.loadURL(`${origin}/#token=${message.token}`).then(()=>{focus();}).catch(()=>startupFailure('页面加载失败，请确认 App 内 GUI 资源完整。'));
      } else if(message?.type==='startupError'&&message.nonce===nonce) {
        clearTimeout(startupTimer);startupFailure(message.code==='UNTRUSTED_STARTUP'?'后台拒绝预加载环境，请清除 Node 预加载配置后重开。':'后台启动失败。请检查数据根权限、配置与 App 资源；原记录保留。');
      } else if(message?.requestId===quitId && message.type==='shutdownState') {
        drained=message.settled===true;
        if(drained)finishQuit();
        else if(message.reason && message.reason!=='正在停止所属任务并保存。'){clearFinalWait();finalRequested=false;resumeEditing();explain('停止尚未确认，窗口和只读状态保留。请核对任务详情后再次退出。');}
      } else if(message?.type==='stopped'&&message.requestId===quitId&&message.settled===true) {
        clearFinalWait();hostStopped=true;exiting=true;app.quit();
      }
    });
  }).catch(()=>{startupFailure('CoThink 桌面初始化失败，请重新生成完整 App。');});
}
