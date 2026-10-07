import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./db.js";
import {
  allPlusGrid,
  totalEnergy,
  magnetization,
  verifyState
} from "./engine.js";

function line(title: string): void {
  console.log(`\n=== ${title} ===`);
}

const dir = mkdtempSync(join(tmpdir(), "ising-demo-"));
const store = new Store(join(dir, "demo.sqlite"));

line("1) 3x3 全 +1 周期网格的独立全量重算");
const grid = allPlusGrid(3, 3);
console.log({ totalEnergy: totalEnergy(grid), magnetization: magnetization(grid) });

line("2) 高温 T=10，u=0.0001 翻转 (0,0)：deltaE=8，应接受");
const hot = store.createExperiment({ name: "demo-hot", grid, temperature: 10 });
const hotBatch = store.submitBatch({
  experimentId: hot.id,
  requestId: "req-accept",
  baseVersion: 0,
  proposals: [{ seq: 0, row: 0, col: 0, u: 0.0001 }]
}).batch;
console.log(hotBatch.result.steps[0]);
console.log("接受后:", {
  energy: store.requireExperiment(hot.id).energy,
  magnetization: store.requireExperiment(hot.id).magnetization
});

line("3) 零温 T=0，不利翻转 deltaE=8 必须拒绝（即使 u 很小）");
const zero = store.createExperiment({ name: "demo-zero", grid, temperature: 0 });
const zeroBatch = store.submitBatch({
  experimentId: zero.id,
  requestId: "req-zero",
  baseVersion: 0,
  proposals: [{ seq: 0, row: 1, col: 1, u: 0.000001 }]
}).batch;
console.log(zeroBatch.result.steps[0]);
console.log("拒绝后状态不变:", {
  energy: store.requireExperiment(zero.id).energy,
  magnetization: store.requireExperiment(zero.id).magnetization,
  version: store.requireExperiment(zero.id).version
});

line("4) 把已翻转的格翻回：deltaE=-8，无条件接受");
const back = store.submitBatch({
  experimentId: hot.id,
  requestId: "req-flip-back",
  baseVersion: 1,
  proposals: [{ seq: 0, row: 0, col: 0, u: 0.99 }]
}).batch;
console.log(back.result.steps[0]);

line("5) 增量状态与独立重算的核验");
const finalExp = store.requireExperiment(hot.id);
console.log(verifyState(finalExp.grid, finalExp.energy, finalExp.magnetization));

line("6) 幂等：重复相同 requestId 返回原结果，不产生新版本");
const repeat = store.submitBatch({
  experimentId: hot.id,
  requestId: "req-accept",
  baseVersion: 0,
  proposals: [{ seq: 0, row: 0, col: 0, u: 0.0001 }]
});
console.log({ replayed: repeat.replayed, version: store.requireExperiment(hot.id).version });

line("7) 温度变化建模为新试验记录（不覆盖旧记录）");
const replayed = store.replayFromSaved({
  experimentId: zero.id,
  temperature: 1,
  proposals: [{ seq: 0, row: 0, col: 0, u: 0.001 }]
});
const newTrial = store.saveReplayAsTrial({
  sourceExperimentId: zero.id,
  name: "demo-T1-from-T0",
  temperature: 1,
  result: replayed.result
});
console.log({
  oldTemperature: zero.temperature,
  newTrialTemperature: newTrial.temperature,
  acceptedStep: newTrial.energy
});

store.close();
console.log(`\n演示完成（临时数据库目录：${dir}）`);
