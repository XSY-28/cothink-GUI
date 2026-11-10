import {useEffect, useRef} from "react";

// Disposable display choices only: no drafts, host snapshots or running-task facts.
export const initialView = {
  theme: "light",
  overlay: null,
  filesBySession: {},
  detailsBySession: {},
  navigation: {mobileOpen: false},
};
// Only disposable presentation choices belong here. Host records never enter storage.
export function readDisplayPreferences(storage, fallbackTheme = "light") {
  let value;
  try {
    const raw = storage.getItem("cothink.display");
    if (raw === null) {
      const legacyTheme = storage.getItem("cothink.theme");
      if (["light","dark"].includes(legacyTheme)) fallbackTheme = legacyTheme;
    }
    value = JSON.parse(raw);
  } catch {}
  if (value?.schemaVersion !== 1) return {...initialView, theme:fallbackTheme};
  return {...initialView, theme:["light","dark"].includes(value.theme) ? value.theme : fallbackTheme};
}
export function saveDisplayPreferences(storage, view) {
  try { storage.setItem("cothink.display", JSON.stringify({schemaVersion:1,theme:view.theme})); } catch {}
}
export function useDisplayTheme(theme, dispatch, notify) {
  const choice = useRef(0);
  const desktop = window.cothinkDesktop;
  const native = typeof desktop?.readTheme === "function" && typeof desktop?.writeTheme === "function";
  useEffect(() => {
    if (!native) return;
    let current = true;
    void desktop.readTheme().then(saved => {
      if (current && !choice.current && ["light","dark"].includes(saved))
        dispatch({type:"theme",theme:saved});
    }).catch(() => {
      if (current && !choice.current) notify("无法读取桌面界面主题。");
    });
    return () => { current = false; };
  }, [desktop,native,dispatch,notify]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    if (!native) saveDisplayPreferences(localStorage,{theme});
  }, [native,theme]);
  return next => {
    const request = ++choice.current;
    dispatch({type:"theme",theme:next});
    if (native) void desktop.writeTheme(next).catch(() => {
      if (choice.current === request) notify("界面主题未能保存到桌面。");
    });
  };
}
export function workspaceViewReducer(state, action) {
  switch (action.type) {
    case "theme": return {...state, theme:action.theme === "dark" ? "dark" : "light"};
    case "overlay": return {...state, overlay: action.overlay, navigation: {...state.navigation, mobileOpen: false}};
    case "navigation": return {...state, navigation: {...state.navigation, ...action.change}};
    case "session": return {...state, navigation: {...state.navigation, mobileOpen: false}};
    case "details": return {...state, detailsBySession: {...state.detailsBySession,
      [action.sessionId]: {...state.detailsBySession[action.sessionId], ...action.change}}};
    case "files": return {...state, filesBySession: {...state.filesBySession, [action.sessionId]: action.selection}};
    default: return state;
  }
}
