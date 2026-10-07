import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { IsingStore } from "./db.js";

const dbPath = resolve("data/demo.sqlite");
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });

const store = new IsingStore(dbPath);
try {
  const grid = Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => 1));
  const board = store.createBoard("demo", grid, 0);
  console.log("初始:", { energy: board.energy, magnetization: board.magnetization, version: board.version });

  const rejected = store.submitProposals("demo", {
    requestId: "zero-temperature-reject",
    expectedVersion: 0,
    temperature: 0,
    proposals: [{ id: "flip-center-1", row: 1, col: 1, u: 0 }],
  });
  console.log("零温不利翻转:", rejected.simulation.results[0]);

  const accepted = store.submitProposals("demo", {
    requestId: "warm-accept",
    expectedVersion: 1,
    temperature: 2,
    proposals: [{ id: "flip-center-2", row: 1, col: 1, u: 0.0001 }],
  });
  console.log("正温且 u 足够小:", accepted.simulation.results[0]);

  const flippedBack = store.submitProposals("demo", {
    requestId: "flip-back",
    expectedVersion: 2,
    temperature: 2,
    proposals: [{ id: "flip-center-3", row: 1, col: 1, u: 0.99 }],
  });
  console.log("能量降低翻回:", flippedBack.simulation.results[0]);
  console.log("最终棋盘:", store.verify("demo"));
} finally {
  store.close();
}
