import { act } from "react";
import { Window } from "happy-dom";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { build } from "vite";

mkdirSync(resolve("work/gui"), { recursive: true });
const bundleDirectory = mkdtempSync(resolve("work/gui/component-build-"));
process.once("exit", () => rmSync(bundleDirectory, { recursive: true, force: true }));
const previousNodeEnv = process.env.NODE_ENV;
await build({
  configFile: false,
  logLevel: "silent",
  build: {
    lib: {
      entry: resolve("test/helpers/gui-components.jsx"),
      formats: ["es"],
      fileName: "components",
    },
    outDir: bundleDirectory,
    emptyOutDir: true,
    minify: false,
    rolldownOptions: { external: ["react", "react/jsx-runtime"] },
  },
});
if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = previousNodeEnv;
export const componentUrl = pathToFileURL(
  resolve(bundleDirectory, "components.js"),
).href;

export async function modalEnvironment(run) {
  const win = new Window({ url: "http://localhost/" }),
    prior = {};
  Object.defineProperty(win.document, "compatMode", { value: "CSS1Compat" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Event",
    "KeyboardEvent",
    "CompositionEvent",
    "DOMParser",
  ]) {
    prior[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: win[key],
    });
  }
  // happy-dom has no layout: model only the browser's rendered-box boundary.
  // Disabled fieldset semantics, focus, events and our trap remain actual DOM behavior.
  win.HTMLElement.prototype.getClientRects = function () {
    if (this.closest("[hidden]")) return [];
    for (let node = this; node; node = node.parentElement) {
      if (win.getComputedStyle(node).display === "none") return [];
      if (
        node.tagName === "DETAILS" &&
        !node.open &&
        !node.querySelector("summary")?.contains(this)
      )
        return [];
    }
    return [{ width: 20, height: 20 }];
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const components = await import(componentUrl),
    { createRoot } = await import("react-dom/client");
  const container = win.document.createElement("div");
  win.document.body.append(container);
  const root = createRoot(container);
  try {
    await run({ win, container, root, ...components });
  } finally {
    await act(() => root.unmount());
    win.happyDOM.abort();
    for (const [key, descriptor] of Object.entries(prior)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
}
