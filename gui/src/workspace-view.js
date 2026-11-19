import {useEffect, useRef} from "react";

// Disposable display choices only: no drafts, host snapshots or running-task facts.
export const initialView = {
  theme: "light",
  overlay: null,
  filesBySession: {},
  detailsBySession: {},
  navigation: {mobileOpen: false},
};
export function restoreDetailFocus(preferred) {
  for (const node of [preferred, document.querySelector(".conversation-picker-trigger"), document.querySelector(".nav-toggle")]) {
    if (!node?.isConnected || node.matches(":disabled") || node.closest("[inert]") || !node.getClientRects().length) continue;
    node.focus();
    if (document.activeElement === node) break;
  }
}
export function bindDrawerKeys(node, modal, onClose) {
  if (!node) return;
  const items = () => [...node.querySelectorAll('button,input,select,textarea,a[href],summary,iframe,[tabindex="0"]')]
    .filter(n => !n.disabled && !n.closest("[inert]") && n.getClientRects().length);
  (items()[0] || node).focus();
  const key = event => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
    if (modal && event.key === "Tab") {
      const elements = items(), first = elements[0], last = elements.at(-1);
      if (!elements.includes(document.activeElement)) {event.preventDefault(); (event.shiftKey ? last : first)?.focus();}
      else if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus();}
      else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus();}
    }
  };
  node.addEventListener("keydown", key);
  return () => node.removeEventListener("keydown", key);
}

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
