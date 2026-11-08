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

