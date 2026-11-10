import { createProjectStaff } from "../src/project-staff.js";

export function roster() {
  const state = {
    scope: ["src"],
    status: "running",
    staff: [],
    staffAssignments: {},
  };
  const staff = createProjectStaff({
    read: () => state,
    update(fn) {
      const copy = structuredClone(state);
      const result = fn(copy);
      Object.assign(state, copy);
      return result;
    },
  });
  const appoint = (id, options = {}) =>
    staff.change("appoint", {
      id,
      responsibility: id,
      scope: ["src"],
      ...options,
    });
  const assign = (id, options = {}) =>
    staff.begin({
      staffId: id,
      dispatchId: id + "-run",
      identity: id,
      model: "local/" + id,
      role: "member:" + id + "-run",
      taskId: "task-1",
      actor: "root",
      scope: [],
      readScope: ["."],
      readOnly: true,
      ...options,
    });
  return { state, staff, appoint, assign };
}
