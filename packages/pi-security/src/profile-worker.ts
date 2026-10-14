import { parentPort, workerData } from "node:worker_threads";
import { compileProfile } from "./profiles.ts";

parentPort!.postMessage(
  compileProfile(workerData.loaded, workerData.permissions, workerData.options),
);
