import { statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { capabilitySnapshot, resolveBuiltinSkills, validateBuiltinSkills } from "./builtin-skills.js";
import { loadConfig, updateConfig } from "./config.js";
import { freezeAnswerSkills } from "./context.js";
import { resolvePackageResources } from "./packages.js";
import { selectedResources } from "./pi-runtime.js";
import { validateSkillResources } from "./skill-resources.js";

export function saveGuiBuiltinSkills(home,value) {
  validateBuiltinSkills({piResources:{builtinSkills:value}});
  return updateConfig(home,current=>{
    if(!current)throw Error('请先保存阵容。');
    return {...current,piResources:{...current.piResources,builtinSkills:structuredClone(value)}};
  }).piResources.builtinSkills;
}

export async function saveGuiLocalSkills(home, paths, { cwd = process.cwd() } = {}) {
  if (!Array.isArray(paths) || paths.some(path => typeof path !== "string" || !path.trim() || path.includes("\0")))
    throw Error("请选择本机 SKILL.md 或技能目录。");
  const current = loadConfig(home);
  if (!current) throw Error("请先保存阵容。");
  const oldResources = current.piResources;
  const unique = [...new Set(paths)];
  for (const path of unique) {
    if (oldResources?.skills?.includes(path)) continue;
    if (!isAbsolute(path)) throw Error("新增技能来源需要本机绝对路径。");
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory() && !(stat.isFile() && basename(path) === "SKILL.md"))
      throw Error("技能来源不存在或不是 SKILL.md / 技能目录：" + path);
  }
  const proposed = {...current, piResources:{...oldResources, skills:unique}};
  const {additionalSkillPaths:skills, additionalPromptTemplatePaths:prompts, additionalThemePaths:themes} =
    selectedResources(proposed, cwd);
  const builtins = resolveBuiltinSkills(proposed);
  const packages = await resolvePackageResources({home, cwd, manual:{skills,prompts,themes}});
  const found = freezeAnswerSkills({
    cwd, home, paths:[...builtins.skills.map(s=>s.path), ...skills, ...packages.skills],
    project:true, includeRestricted:true,
  });
  validateSkillResources(found);
  updateConfig(home, latest => {
    if (!latest || JSON.stringify(latest.piResources) !== JSON.stringify(oldResources))
      throw Error("技能配置已改变，请刷新后重新选择。");
    return {...latest, piResources:proposed.piResources};
  });
  const sourceKind = path => builtins.skills.some(b=>b.path===path) ? "builtin" :
    packages.skills.includes(path) ? "package" : "selected";
  return {
    paths:unique,
    skills:capabilitySnapshot({skills:found.map(s=>({...s,sourceKind:sourceKind(s.path)}))}).skills,
  };
}
