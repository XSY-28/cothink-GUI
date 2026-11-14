import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFileSync,readFileSync} from 'node:fs';
import {fixture} from './helpers/pi-fixture.js';
import {repository} from './helpers/git-fixture.js';
import {execution} from './helpers/agent-sync-fixture.js';
import {invoke} from './helpers/cli-fixture.js';
import {saveConfig} from '../src/config.js';
export const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
export const checks = [
  {
    command: "node",
    args: ["-e", "const value = require('./export.json'); if(value.version !== 2) process.exit(1)"],
  },
];
export const review = {
  path: "export.json",
  contains: '"version":1',
  reason: "An old version tag predicts an upgrade fault. If absent we do not know the cause.",
  ifPresent: "repair",
  ifAbsent: "blocked",
  repairScope: ["export.json"],
};

export async function project(t, { spec = {}, budget = { maxCalls: 7 }, handler, responsesApi=false,vision=false,workExecution=execution,onSetup }) {
  const repo = repository(t),
    f = await fixture(t, handler);
  if(responsesApi||vision){const path=join(f.home,'pi','models.json'),catalog=JSON.parse(readFileSync(path,'utf8'));
    if(responsesApi)catalog.providers.fixture.api='openai-responses';for(const model of catalog.providers.fixture.models){if(vision)model.input=['text','image'];if(responsesApi)model.compat={supportsMidConvoSystemMessages:true,supportsAdditionalTools:true};}writeFileSync(path,JSON.stringify(catalog));}
  saveConfig(f.home, { formatVersion: 2, ...f.models, work: { checks, execution:workExecution } });
  onSetup?.({f,repo});
  const input = join(f.home, "plan.json");
  writeFileSync(
    input,
    JSON.stringify({
      goal: "Export a readable version 2 artifact.",
      scope: spec.scope??["export.json"],
      budget,
      steps: [
        {
          id: "export",
          goal: "Read version tag through normal entry.",
          deliverables: ["export.json"],
          checks,
          ...spec,
        },
      ],
    }),
  );
  const reply = await invoke(f, ["project", "start", "--file", input, "--json"], "", repo.project);
  assert.ok(reply.stdout.trim(), reply.stderr);
  return { repo, f, reply, state: JSON.parse(reply.stdout) };
}
