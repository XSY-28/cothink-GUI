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
