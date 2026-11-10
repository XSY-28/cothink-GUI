import { teamId } from './helpers/gui-controller-fixture.js';
import {createGuiController} from '../src/gui-controller.js';
import {saveConfig} from '../src/config.js';
import {createTeamConfig} from '../src/teams.js';

export async function complete(c,id){for(let n=0;n<1000;n++){const task=await c.task(id);if(!['running','preparing','cancelling'].includes(task.status))return task;await new Promise(r=>setTimeout(r,10));}throw Error('task did not settle');}
export async function controller(t,f,work){saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models,...(work?{work}:{})},'Fixture',teamId));const c=await createGuiController({home:f.home,cwd:f.cwd});t.after(()=>c.close());return c;}
