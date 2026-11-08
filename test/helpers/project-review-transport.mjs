// Loaded only in the test CLI child. The model catalog and Pi request see a
// provider URL, but no TCP connection except to this test's server is allowed.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { localDockerSocket } from "../../packages/agent-sync/src/executor.js";
import { Socket } from "node:net";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const installed = process.env.COTHINK_TEST_PACKAGE_ROOT;
const sdkDir = installed && join(installed, "node_modules", "@earendil-works", "pi-coding-agent");
const sdk = sdkDir
  ? pathToFileURL(join(sdkDir, JSON.parse(readFileSync(join(sdkDir, "package.json"))).exports["."].import)).href
  : import.meta.resolve("@earendil-works/pi-coding-agent");
const { Agent, fetch: localFetch } = createRequire(sdk)("undici");

const endpoint = new URL(readFileSync(join(process.env.COTHINK_HOME, "review-fixture-url"), "utf8"));
if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port)
  throw Error("Review fixture needs an explicit IPv4 loopback port.");

const dockerSocket = localDockerSocket(JSON.parse(execFileSync("docker",
  ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], {encoding:"utf8"})));
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  const input = Array.isArray(args[0]) ? args[0] : args;
  const options = typeof input[0] === "object" ? input[0] : {port:input[0], host:input[1]};
  if (options.path === dockerSocket) return connect.call(this, {path:dockerSocket}, ...input.slice(1));
  if (options.path || options.host !== endpoint.hostname || String(options.port) !== endpoint.port)
    throw Error("Review fixture blocked a non-fixture socket.");
  return connect.apply(this, args);
};

// Pi preserves a replacement fetch installed after its dispatcher module loads.
await import(sdk);
const dispatcher = new Agent();
const path = "/v1/chat/completions";
const allowed = new Set(["https://api.openai.com", "https://api.anthropic.com", "https://api.deepseek.com",
  endpoint.origin].map(origin => origin + path));

globalThis.fetch = async (url, init) => {
  const requested = typeof url === "string" || url instanceof URL ? String(url) : url.url;
  if (!allowed.has(requested)) throw Error("Review fixture blocked an unknown fetch destination.");
  const headers = new Headers(init?.headers);
  headers.set("x-review-fixture-requested-url", requested);
  const response = await localFetch(new URL(path, endpoint), {...init, headers, dispatcher, redirect:"error"});
  Object.defineProperty(response, "url", {value:requested});
  return response;
};
