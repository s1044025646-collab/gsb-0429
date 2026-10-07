import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../errors.js";
import { IsingStore } from "../db.js";
import {
  acceptanceProbability,
  cloneGrid,
  Grid,
  inspectStep,
  magnetization,
  shouldAccept,
  simulateBatch,
  totalEnergy,
} from "../ising.js";

let passed = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
  passed += 1;
}

function equalish(actual: unknown, expected: unknown, message: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}; actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

function allOnes(size: number): Grid {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as const));
}

const grid3 = allOnes(3);
assert(totalEnergy(grid3) === -18, "全正 3x3 能量应为 -18");
assert(magnetization(grid3) === 9, "全正 3x3 磁化量应为 9");
const sim = simulateBatch(
  { temperature: 2, expectedVersion: 0, proposals: [{ id: "a", row: 0, col: 0, u: 0 }] },
  grid3,
  0,
);
assert(sim.results[0]!.deltaEnergy === 8, "翻转全正网格一格能量差应为 8");
assert(sim.finalEnergy === -10 && sim.finalMagnetization === 7, "接受后能量 -10、磁化量 7");

assert(shouldAccept(8, 0, 0) === false, "零温拒绝正能量差");
assert(shouldAccept(8, 2, 0.01831563888873418 - 1e-12), "严格小于概率时接受");
assert(shouldAccept(8, 2, 0.01831563888873418) === false, "u 等于概率时必须拒绝");
assert(shouldAccept(0, 2, 0.99), "零能量差始终接受");
assert(shouldAccept(-4, 2, 0.99), "负能量差始终接受");
assert(acceptanceProbability(8, 0) === 0, "零温正能差概率为 0");

for (let size = 3; size <= 6; size += 1) {
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const varied: Grid = Array.from({ length: size }, (_, r) =>
        Array.from({ length: size }, (_, c) => (((r * 7 + c * 3) % 2 === 0 ? 1 : -1) as 1 | -1)),
      );
      const info = inspectStep(varied, row, col, 1);
      const candidate = cloneGrid(varied);
      candidate[row]![col] = candidate[row]![col] === 1 ? -1 : 1;
      assert(totalEnergy(candidate) - totalEnergy(varied) === info.deltaEnergy, `${size}x${size} 位置 (${row},${col}) 局部能量差不匹配`);
    }
  }
}

const path = mkdtempSync(join(tmpdir(), "ising-"));
const dbPath = join(path, "test.sqlite");
const store = new IsingStore(dbPath);
try {
  const board = store.createBoard("b", grid3, 0);
  equalish(board.currentGrid, grid3, "初始棋盘保存");

  const beforeGrid = JSON.stringify(store.getBoard("b").currentGrid);
  let rejectedBatch = false;
  try {
    store.submitProposals("b", {
      requestId: "invalid",
      expectedVersion: 0,
      temperature: 0,
      proposals: [
        { id: "valid", row: 0, col: 0, u: 0 },
        { id: "bad", row: 99, col: 0, u: 0 },
      ],
    });
  } catch (error) {
    rejectedBatch = error instanceof AppError && error.code === "INVALID_ARGUMENT";
  }
  assert(rejectedBatch, "整批非法必须在推进前失败");
  assert(JSON.stringify(store.getBoard("b").currentGrid) === beforeGrid, "失败批次不得改变棋盘");
  assert(store.getBoard("b").version === 0, "失败批次不得推进版本");

  const first = store.submitProposals("b", {
    requestId: "r1",
    expectedVersion: 0,
    temperature: 0,
    proposals: [{ id: "p1", row: 0, col: 0, u: 0 }],
  });
  assert(first.idempotent === false && !first.simulation.results[0]!.accepted, "零温拒绝步被处理");
  assert(store.getBoard("b").version === 1, "拒绝也推进版本");

  const duplicate = store.submitProposals("b", {
    requestId: "r1",
    expectedVersion: 0,
    temperature: 0,
    proposals: [{ id: "p1", row: 0, col: 0, u: 0 }],
  });
  assert(duplicate.idempotent && store.getBoard("b").version === 1, "重复 requestId 返回原结果");

  let conflicted = false;
  try {
    store.submitProposals("b", {
      requestId: "stale",
      expectedVersion: 0,
      temperature: 2,
      proposals: [{ id: "p2", row: 0, col: 0, u: 0 }],
    });
  } catch (error) {
    conflicted = error instanceof AppError && error.status === 409;
  }
  assert(conflicted, "旧版本提交必须冲突");

  const acceptThenBack = store.submitProposals("b", {
    requestId: "r2",
    expectedVersion: 1,
    temperature: 2,
    proposals: [
      { id: "p3", row: 0, col: 0, u: 0 },
      { id: "p4", row: 0, col: 0, u: 0.99 },
    ],
  });
  assert(acceptThenBack.simulation.results[0]?.accepted === true && acceptThenBack.simulation.results[1]?.accepted === true, "同格可在有序序列中重复翻回");
  const verification = store.verify("b");
  assert(verification.ok, "数据库状态、增量能量和全量重算必须一致");
  const replay = store.replay("b");
  assert(replay.matchesCurrent, "从保存起点回放必须匹配当前棋盘");
} finally {
  store.close();
  rmSync(path, { recursive: true, force: true });
}

console.log(`通过 ${passed} 项断言`);
