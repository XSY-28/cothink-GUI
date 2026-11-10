import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const packageRoot=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL("..",import.meta.url)));
export const load=path=>import(pathToFileURL(join(packageRoot,path)));
export const {saveConfig}=await load("src/config.js");
export const {createTeamConfig}=await load("src/teams.js");
export const {startGuiServer}=await load("src/gui-server.js");
