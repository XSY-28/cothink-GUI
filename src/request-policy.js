import { payloadImageHashes } from "./visual-preview.js";
import { describeError, responseHeaders, observeResponse, assertFencedModelTransport, hostToolsOnlyPayload } from "./transport-diagnostics.js";
import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { redact } from "./storage.js";
import { problem } from "./task.js";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { applyMaterials, textOf } from "./request-materials.js";

export {assertFencedModelTransport,hostToolsOnlyPayload} from './transport-diagnostics.js';
const optionalApis = new Set([
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "google-generative-ai",
]);
export const requiresModelOutputLimit = model => model?.api ? !optionalApis.has(model.api) : null;
export { textOf };
export function createRequestPolicy({ getBinding, getSecrets = () => [], imageAutoResize = () => true, capabilitySources = () => null, effectiveModel = model => model }) {
  return {
    stream(model, context, options, send) {
      const output = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const binding = getBinding();
        let call, task, stage, removeAbortListener, releaseProjectSeat, fenced;
        const failure = (error) => ({
          role: "assistant",
          api: model.api,
          model: model.id,
          provider: model.provider,
          content: [],
          stopReason: "error",
          errorMessage: error.message,
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        });
        try {
          if (!binding)
            throw problem("UNMANAGED_REQUEST", "模型请求没有绑定 CoThink 任务；已阻止发送。");
          ({ task, stage } = binding);
          model=effectiveModel(model);
          if (task.record.status !== "running")
            throw problem("TASK_ENDED", "任务已结束，拒绝新的模型请求。");
          binding.assertOwned?.();
          if (task.ioError) throw task.ioError;
          if (task.signal.aborted) throw task.signal.reason;
          fenced = Boolean(task.projectPolicy || task.rootOwner);
          if(fenced)assertFencedModelTransport(model,options?.client);
          const sendIntent = task.projectPolicy?.locateSend({ task, stage, context, model });
          await task.projectPolicy?.autoReviewScope?.();
          context=task.projectPolicy?.projectRequestContext?.(sendIntent,context)??context;
          if (stage.phase === "process-check") context = {...context,
            messages:context.messages.filter(message=>message.role==="system"||message===context.messages.at(-1))};
          const materialContext=await applyMaterials(binding,context,model,imageAutoResize());
          context=materialContext.context;
          if((fenced||binding.task.materialContext?.length)&&model.contextWindow>0){
            const estimate=context.messages.reduce((sum,message)=>sum+estimateTokens(message),0)+Math.ceil((context.systemPrompt?.length??0)/4);
            if(estimate>=model.contextWindow) {
              const source=capabilitySources(model)?.contextWindow;
              const label=({model_override:"本地显式覆盖",local_config_unverified:"本地配置 / 未核实",sdk_default:"SDK 默认 / 未核实",bundled_catalog:"随包目录"})[source]??"来源未核实";
              throw problem("MATERIAL_CONTEXT_LIMIT",`对话及材料超出模型上下文估算上限 ${model.contextWindow}（${label}）。请在设置的“模型与认证”核对模型能力，或减少材料、手动整理上下文。`);
            }
          }
          const expectedMaterialImages=materialContext.images;
          const secrets = await getSecrets(model);
          const clean = (v) => redact(v, secrets);
          const original = sendIntent && task.projectPolicy.originalResult(sendIntent, task);
          if (original) {
            if (!stage.callIds.includes(original.id)) stage.callIds.push(original.id);
            task.save();
            output.push({ type: "done", reason: "stop", message: original.response });
            output.end();
            return;
          }
          call = {
            id: sendIntent?.requestId ?? randomUUID(),
            ...(sendIntent ? { projectSend: { sessionId: sendIntent.sessionId, workId: sendIntent.workId,
              dispatchId: sendIntent.dispatchId, cause: sendIntent.cause, feedback: sendIntent.feedback,
              ...(sendIntent.effect ? { effect: sendIntent.effect } : {}) } } : {}),
            taskId: task.record.id,
            stageId: stage.id,
            displayId: randomUUID(),
            phase: stage.phase,
            role: stage.role,
            requestedModel: stage.modelRef,
            actualModel: {
              provider: model.provider,
              modelId: model.id,
              api: model.api,
              baseUrl: model.baseUrl,
            },
            status: "preparing",
            sent: false,
            createdAt: new Date().toISOString(),
            context: clean(context),
            events: [],
            usage: null,
            estimatedCost: null,
            _secrets: secrets,
          };
          task.register(call);
          stage.callIds.push(call.id);
          task.writeRequest(call);
          task.save();
          if (stage.phase === "process-check") task.rootOwner?.processCheck.recordRequest(stage, call.id);
          const signal = options?.signal
            ? AbortSignal.any([options.signal, task.signal])
            : task.signal;
          call.transport = { startedAt: new Date().toISOString(), bodyBytes: 0, bodyChunks: 0 };
          const onAbort = () => {
            call.transport.abort = {
              at: new Date().toISOString(),
              source: task.signal.aborted ? (task.ioError ? "storage_failure" : task.record.cancelRequestedAt ? "user_cancel" : "task_stop") : "runtime_signal",
              reason: describeError(signal.reason, secrets),
            };
          };
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", onAbort);
          if (signal.aborted) onAbort();
          let usageSeen = false;
          const opts = {
            ...options,
            ...(fenced && model.api === "openai-codex-responses" ? {transport:"sse"} : {}),
            signal,
            maxTokens:
              binding.maxOutputTokens ?? binding.modelRef?.maxOutputTokens ?? options?.maxTokens,
            fetch: async (url, init) => {
              if (signal.aborted) throw signal.reason;
              const seats=task.rootOwner?.acquireRequestSeat ? task.rootOwner : task.projectPolicy;
              if (seats?.acquireRequestSeat) {
                if (releaseProjectSeat) throw problem('PROJECT_REPLAY','Repeated physical request transport');
                releaseProjectSeat = await seats.acquireRequestSeat(signal,stage);
                signal.throwIfAborted();
              }
              let response;
              let body;
              if(expectedMaterialImages.length || binding.beforeDispatch){
                try {
                  if(typeof init?.body==="string")body=JSON.parse(init.body);
                  else if(init?.body instanceof Uint8Array)body=JSON.parse(Buffer.from(init.body).toString("utf8"));
                  else if(url instanceof Request)body=await url.clone().json();
                } catch {}
              }
              if(expectedMaterialImages.length){
                const hashes=payloadImageHashes(body);
                if(!call.materialImages||expectedMaterialImages.some(image=>!hashes.has(image.payloadSha256))){
                  binding.error=problem("MATERIAL_IMAGE_OMITTED","实际 HTTP 正文缺少可核验的材料图片。未发送模型请求。");
                  throw binding.error;
                }
              }
              if (fenced) {
                // Pi may perform fetch after yielding since onPayload. Recheck live authority.
                if (!call.payload || call.transport.projectDispatched)
                  throw problem("PROJECT_REPLAY", "Missing prepared payload or repeated project transport");
                try {
                  const origin = new URL(url instanceof Request ? url.url : url).origin;
                  if (origin !== new URL(model.baseUrl).origin)
                    throw problem("PROJECT_TRANSPORT", "Dispatch origin differs from the approved model endpoint");
                  call.transport.requestOrigin = origin;
                  let dispatchedPayload;
                  try { dispatchedPayload=typeof init?.body==='string'?JSON.parse(init.body):call.payload; } catch {}
                  call.transport.hostToolsOnly = hostToolsOnlyPayload(model,dispatchedPayload);
                  binding.assertOwned?.();
                  if(task.ioError) throw task.ioError;
                  if(task.record.status!=="running") throw problem("TASK_ENDED","Task ended before dispatch");
                  task.rootOwner?.reserveRequest({requestId:call.id,taskId:task.record.id,sessionId:stage.sessionId??task.record.sessionId,stageId:stage.id,model:call.actualModel,cause:sendIntent?.cause??stage.phase});
                  binding.beforeDispatch?.(call, body);
                  task.projectPolicy?.admit("send", sendIntent);
                  task.rootOwner?.processCheck.consume(task.record.id, stage.role);
                } catch (error) {
                  // Some provider SDKs replace local fetch errors with "Connection error".
                  binding.error = error;
                  call.failure = describeError(error, secrets);
                  call.error = clean(error.message);
                  throw error;
                }
                call.sent = true;
                call.status = "in_flight";
                call.transport.projectDispatched = true;
                task.writeRequest(call);
                task.save();
              }
              try {
                call.transport.dispatchedAt = new Date().toISOString();
                response = await (options?.fetch ?? globalThis.fetch)(url,
                  fenced ? { ...init, redirect: "error" } : init);
              } catch (error) {
                call.transport.fetchError = describeError(error, secrets);
                throw error;
              }
              call.httpStatus = response.status;
              if (fenced) call.transport.responseOrigin = response.url ? new URL(response.url).origin : null;
              call.transport.headersAt = new Date().toISOString();
              call.transport.responseHeaders = responseHeaders(response.headers, secrets);
              const observed = observeResponse(response, call.transport, secrets);
              task.writeRequest(call);
              if (!observed.ok) call.rawErrorBody = clean(await observed.clone().text());
              return observed;
            },
            timeoutMs: binding.timeout ?? 0,
            maxRetries: 0,
            onPayload: async (payload, actual) => {
              if (signal.aborted) throw signal.reason;
              if (binding.error) throw binding.error;
              binding.assertOwned?.();
              if (task.ioError) throw task.ioError;
              const body = (await options?.onPayload?.(payload, actual)) ?? payload;
              if (binding.error) throw binding.error;
              binding.assertOwned?.();
              if (task.ioError) throw task.ioError;
              if (!body || typeof body !== "object")
                throw problem("INVALID_PAYLOAD", "服务请求格式无效");
              const outputCap = binding.maxOutputTokens ?? binding.modelRef?.maxOutputTokens;
              if (outputCap != null) {
                for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
                  if (key in body) body[key] = outputCap;
                }
                if (body.generationConfig) body.generationConfig.maxOutputTokens = outputCap;
              } else if (requiresModelOutputLimit(actual) === false) {
                delete body.max_tokens;
                delete body.max_completion_tokens;
                delete body.max_output_tokens;
                if (body.generationConfig) delete body.generationConfig.maxOutputTokens;
              } else
                throw problem(
                  "REQUIRED_OUTPUT_LIMIT",
                  `${actual.api} 协议要求输出额度，请在模型配置中明确 maxOutputTokens。`,
                );
              if (signal.aborted) throw signal.reason;
              if (task.record.maxCalls !== null && task.usage().calls >= task.record.maxCalls)
                throw problem("CALL_BUDGET", "实际请求数超过本条预算");
              call.actualModel = {
                provider: actual.provider,
                modelId: actual.id,
                api: actual.api,
                baseUrl: actual.baseUrl,
              };
              if(expectedMaterialImages.length){
                const hashes=payloadImageHashes(body);
                if(expectedMaterialImages.some(image=>!hashes.has(image.payloadSha256))){
                  binding.error=problem("MATERIAL_IMAGE_OMITTED","模型请求正文缺少已选图片。未发送模型请求。");
                  throw binding.error;
                }
                call.materialImages=expectedMaterialImages;
              }
              call.payload = clean(body);
              if(task.record.work?.visualEvidence) {
                const hashes=payloadImageHashes(body), serialized=JSON.stringify(body);
                for(const e of task.record.work.visualEvidence) {
                  if(e.actor===stage.role && e.result==="captured" && !e.imageRequestId && e.images.length && e.images.every(i=>hashes.has(i.sha256)) && serialized.includes(e.toolCallId) && serialized.includes(e.sourceVersion)) e.imageRequestId=call.id;
                }
              }
              call.limits = {
                maxOutputTokens:
                  binding.maxOutputTokens ?? binding.modelRef?.maxOutputTokens ?? null,
                timeoutMs: binding.timeout ?? null,
                retries: 0,
              };
              if (fenced) {
                if (actual.provider !== model.provider || actual.id !== model.id || actual.baseUrl !== model.baseUrl)
                  throw problem("PROJECT_TRANSPORT", "Prepared payload changed the approved project route");
                task.projectPolicy?.admit("prepareSend", sendIntent);
              } else { call.status = "in_flight"; call.sent = true; }
              task.writeRequest(call);
              task.save();
              return body;
            },
            onResponse: async (response) => {
              call.httpStatus = response.status;
              task.writeRequest(call);
              await options?.onResponse?.(response);
            },
            onProviderStreamEvent: async (data, actual) => {
              task.appendRequestEvent(call, data);
              if (
                data?.usage ||
                data?.message?.usage ||
                data?.response?.usage ||
                data?.choices?.[0]?.usage ||
                data?.usageMetadata
              )
                usageSeen = true;
              await options?.onProviderStreamEvent?.(data, actual);
            },
          };
          const source = await send(model, context, opts);
          for await (const originalEvent of source) {
            const event = clean(originalEvent);
            const message = event.message ?? event.partial ?? event.error;
            if (message && typeof message === "object") {
              message.cothinkMessageId = call.displayId;
              message.cothinkTaskId = task.record.id;
              message.cothinkPhase = stage.phase;
              if (message.content) message.content = clean(message.content);
              if (message.errorMessage) message.errorMessage = clean(message.errorMessage);
            }
            if (event.type === "done" || event.type === "error") {
              call.response = clean(message);
              if (event.type === "error") call.transport.sdkError = clean(message?.errorMessage);
              call.text = textOf(message);
              call.usage = usageSeen ? message.usage : null;
              call.usageSource = usageSeen ? "provider_stream" : null;
              call.estimatedCost =
                usageSeen &&
                Object.values(model.cost ?? {}).some(
                  (value) => typeof value === "number" && value > 0,
                ) &&
                typeof message.usage?.cost?.total === "number"
                  ? message.usage.cost.total
                  : null;
              call.status = signal.aborted
                ? call.sent
                  ? "outcome_unknown"
                  : "not_sent"
                : message.stopReason === "length"
                  ? "partial"
                  : message.stopReason === "error"
                    ? call.httpStatus >= 400
                      ? "failed"
                      : call.sent
                        ? "outcome_unknown"
                        : "failed"
                    : message.stopReason === "aborted"
                      ? call.sent
                        ? "outcome_unknown"
                        : "not_sent"
                      : message.stopReason === "stop" || message.stopReason === "toolUse"
                        ? "completed"
                        : "partial";
              if (
                call.status === "completed" &&
                !call.text.trim() &&
                !message.content?.some((c) => c.type === "toolCall")
              )
                call.status = "failed";
              call.endedAt = new Date().toISOString();
              task.writeRequest(call);
              task.save();
            }
            output.push(event);
          }
          output.end();
        } catch (error) {
          if (binding) binding.error = error;
          if (call) {
            call.error = redact(error.message, call._secrets);
            call.failure = describeError(error, call._secrets);
            call.endedAt = new Date().toISOString();
            call.status = call.sent ? "outcome_unknown" : "failed";
            try {
              task.writeRequest(call);
            } catch {
              /* memory remains available to host recovery */
            }
          }
          output.push({ type: "error", reason: "error", error: failure(error) });
          output.end();
        } finally {
          if(call && task?.rootOwner) {
            try {task.rootOwner.settleRequest({requestId:call.id,taskId:task.record.id,status:call.status,notSent:call.sent===false && !call.transport?.projectDispatched,usage:call.usage});}
            catch(error){task.ioError=error;binding.error=error;}
          }
          releaseProjectSeat?.();
          removeAbortListener?.();
        }
      });
      return output;
    },
  };
}
