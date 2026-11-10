// Known vendor namespaces and aliases share an identity. Custom IDs remain opaque.
export function workModelIdentity({modelId}) {
  const id = modelId.replace(/^(?:openai|anthropic|deepseek|moonshotai|moonshot)\//, "");
  if (id === "k3.1-pro") return "kimi-k3.1-pro";
  if (id === "anthropic.claude-opus-5-5" || id === "claude-opus-5.5") return "claude-opus-5-5";
  if (id === "deepseek-v4.1-flash1017") return "deepseek-v4.1-flash-1017";
  return id;
}

/** Change roles without losing a model or its saved generation settings. */
export function switchModelRoles(config, selected) {
  const next = structuredClone(config);
  const same = (a, b) => a.provider === b.provider && a.modelId === b.modelId;
  const previous = next.main;
  const index = next.secondary.findIndex((ref) => same(ref, selected));
  next.main = {
    ...(same(previous, selected)
      ? previous
      : index >= 0
        ? next.secondary[index]
        : {}),
    ...structuredClone(selected),
  };
  if (!same(previous, selected)) {
    if (index >= 0) next.secondary[index] = previous;
    else next.secondary.unshift(previous);
  }
  return next;
}

