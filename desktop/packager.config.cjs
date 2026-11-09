module.exports={
  name:'CoThink',appBundleId:'dev.cothink.desktop',executableName:'CoThink',
  platform:'darwin',arch:'arm64',asar:false,prune:false,overwrite:false,junk:false,derefSymlinks:false,
  // The staging tree is already the bounded consumer package; preserve its byte inventory.
  ignore:()=>false,
  appCategoryType:'public.app-category.productivity',
  darwinDarkModeSupport:true,
};
