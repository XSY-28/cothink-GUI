import { taskDisplayStatus } from "./task.js";

export function publicModel(ref) {
  return ref &&
    typeof ref.provider === "string" &&
    typeof (ref.modelId ?? ref.id) === "string"
    ? {
        provider: ref.provider,
        modelId: ref.modelId ?? ref.id,
        ...(ref.thinkingLevel !== undefined
          ? { thinkingLevel: ref.thinkingLevel }
          : {}),
        ...(ref.maxOutputTokens !== undefined
          ? { maxOutputTokens: ref.maxOutputTokens }
          : {}),
      }
    : null;
}
export const diagnostic = error => typeof error === "string" ? error :
  typeof error?.message === "string" ? error.message : null;

export function projectGuiProcessCheck(record, messages) {
  const saved = record.processCheck;
  if (!saved) return null;
  const calls = new Map(messages.filter(message => message.role === "process-check").map(message => [message.id, message]));
  const reports = Map.groupBy(saved.reports ?? [], report => report.observationId);
  const observations = (saved.observations ?? []).map(observation => {
    const candidate = calls.get(observation.requestId);
    const call = candidate && candidate.taskId === observation.taskId && candidate.stageId === observation.stageId &&
      candidate.sessionId === observation.sessionId ? candidate : null;
    const verified = observation.status === "completed" && call?.sent && call.status === "completed";
    const members = (observation.members ?? []).map(fact => ({
      taskId: fact.taskId,
      memberId: fact.memberId,
      leaderId: fact.leaderId,
      attempt: fact.attempt,
      status: fact.status,
      blockers: fact.blockers,
      lastProgressAt: fact.lastProgressAt,
      covered: !!verified && !!observation.covered?.some(row => row.taskId === fact.taskId &&
        row.memberId === fact.memberId && row.attempt === fact.attempt &&
        row.evidenceIds?.length && row.evidenceIds.every(id => fact.evidenceIds?.includes(id))),
    }));
    return {
      id: observation.id,
      sequence: observation.sequence,
      kind: observation.kind,
      dueAt: observation.dueAt,
      observedAt: observation.observedAt,
      delayMs: observation.delayMs,
      missedIntervals: observation.missedIntervals,
      status: observation.status === "completed" && !verified ? "unverified" : observation.status,
      error: diagnostic(observation.error),
      requestId: observation.requestId,
      requestStatus: call?.status ?? null,
      actualModel: call?.sent ? call.actualModel : null,
      usage: call?.usage ?? null,
      members,
      reports: verified ? (reports.get(observation.id) ?? []).filter(report =>
        observation.members?.some(member => member.taskId === report.taskId && member.memberId === report.memberId &&
          member.leaderId === report.leaderId && member.attempt === report.attempt && report.evidenceIds?.length &&
          report.evidenceIds.every(id => member.evidenceIds?.includes(id) || member.blockerIds?.includes(id)))).map(report => ({
        id: report.id, kind: report.kind, status: report.status, reason: report.reason, forwardedAt: report.forwardedAt,
        taskId: report.taskId, memberId: report.memberId, leaderId: report.leaderId, evidenceIds: report.evidenceIds,
      })) : [],
    };
  });
  return {
    interval: saved.interval,
    status: saved.status === "running" && taskDisplayStatus(record) === "outcome_unknown" ? "outcome_unknown" : saved.status,
    selectedModel: publicModel(saved.model),
    settledAt: saved.settledAt,
    gap: saved.gap ? {code: saved.gap.code, message: diagnostic(saved.gap), at: saved.gap.at} : null,
    unexecuted: (saved.unexecuted ?? []).map(({taskId,memberId,status}) => ({taskId,memberId,status})),
    observations,
  };
}
