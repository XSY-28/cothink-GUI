import { existsSync } from "node:fs";
import { identifier, problem } from "./scope.js";
import { atomic, canonical, digest, load } from "./storage.js";

export const namedPolicyStorageVersion = 2;

export function checksPolicy(checks) {
  if (
    !Array.isArray(checks) ||
    checks.some(
      (c) =>
        !c ||
        Object.keys(c).some(
          (k) => !["command", "args", "timeoutMs"].includes(k),
        ) ||
        typeof c.command !== "string" ||
        !c.command ||
        (c.args !== undefined &&
          (!Array.isArray(c.args) ||
            c.args.some((a) => typeof a !== "string"))) ||
        c.env !== undefined ||
        (c.timeoutMs !== undefined &&
          (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs <= 0)),
    )
  )
    throw problem(
      "CHECK_POLICY",
      "checks require command, string args and optional positive timeoutMs; secret env is unsupported",
    );
  return structuredClone(checks);
}

export function prepareNamedCheckPolicies(checkPolicies, execution) {
  if (
    !checkPolicies ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(checkPolicies))
  )
    throw problem("CHECK_POLICY", "Expected a trusted catalog of named checks");
  return new Map(
    Object.entries(checkPolicies).map(([id, commands]) => {
      identifier(id);
      const checks = checksPolicy(commands);
      if (!checks.length || !execution)
        throw problem(
          "CHECK_POLICY",
          "Named policies require nonempty checks and fixed Docker execution",
        );
      return [
        id,
        { checks, policy: digest(canonical({ id, checks, execution })) },
      ];
    }),
  );
}

export function bindCheckPolicyResolver(checks, policy, namedPolicies) {
  return function resolveCheckPolicy(binding) {
    if (binding === undefined) return { checks, policy };
    const selected = namedPolicies.get(binding?.id);
    if (
      !selected ||
      Object.keys(binding).length !== 2 ||
      !Object.hasOwn(binding, "id") ||
      !Object.hasOwn(binding, "digest") ||
      binding.digest !== selected.policy
    )
      throw problem(
        "CHECK_POLICY",
        "Named check policy is unavailable or does not match its approved digest",
      );
    return selected;
  };
}

export function readProjectRegistration(registration, meta, integrationRef, namedCount) {
  const registered = existsSync(registration) ? load(registration) : null,
    namedRegistered =
      registered?.protocolVersion === namedPolicyStorageVersion,
    registeredRef = namedRegistered
      ? registered.formalRef
      : registered?.integrationRef;
  if (
    registered &&
    ((!namedRegistered && registered.protocolVersion !== undefined) ||
      typeof registeredRef !== "string" ||
      registeredRef !==
        (meta?.integrationRef ?? integrationRef ?? registeredRef))
  )
    throw problem("PROJECT_MISMATCH", "One formal ref per project");
  const storageVersion =
    namedCount ||
    namedRegistered ||
    meta?.protocolVersion === namedPolicyStorageVersion
      ? namedPolicyStorageVersion
      : 1;
  return { registered, registeredRef, storageVersion };
}

export function writeProjectRegistration(registration, { projectId, storageVersion, integrationRef, home }) {
  // v1 reads the home metadata before locking but checks this registry
  // under the owner lock. Omit its legacy ref field so even a stale
  // opener or a different home fails closed without moving the ref.
  atomic(registration, {
    projectId,
    ...(storageVersion === namedPolicyStorageVersion
      ? { protocolVersion: storageVersion, formalRef: integrationRef }
      : { integrationRef: integrationRef }),
    home,
  });
}
