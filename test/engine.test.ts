import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allPlusGrid,
  cloneGrid,
  deltaEnergyAt,
  isAccepted,
  magnetization,
  neighborsOf,
  replay,
  totalEnergy,
  validateGrid,
  validateProposalBatch,
  validateTemperature,
  verifyState
} from "../src/engine.js";
import { AppError } from "../src/errors.js";

function checkerGrid(size: number): number[][] {
  // 交替自旋网格，覆盖局部能量差为零与非零情形。
  return Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => ((r + c) % 2 === 0 ? 1 : -1))
  );
}

test("全正一 3x3：能量 -18、磁化 9，翻任意格 deltaE=8，接受后 -10/7", () => {
  const grid = allPlusGrid(3, 3);
  assert.equal(totalEnergy(grid), -18);
  assert.equal(magnetization(grid), 9);
  assert.equal(deltaEnergyAt(grid, 0, 0), 8);
  assert.equal(deltaEnergyAt(grid, 1, 2), 8);
  const result = replay(grid, 10, [{ row: 0, col: 0, u: 0.0001 }]);
  assert.equal(result.energy, -10);
  assert.equal(result.magnetization, 7);
  assert.equal(result.steps[0]!.accepted, true);
  // 输入网格不被原地修改。
  assert.deepEqual(grid, allPlusGrid(3, 3));
});

test("零温拒绝所有正能量差", () => {
  const grid = allPlusGrid(3, 3);
  const result = replay(grid, 0, [{ row: 0, col: 0, u: 0 }]);
  assert.equal(result.steps[0]!.accepted, false);
  assert.equal(result.energy, -18);
  assert.equal(result.magnetization, 9);
  assert.deepEqual(result.grid, grid);
});

test("负温被拒绝", () => {
  assert.throws(() => validateTemperature(-0.5), AppError);
  assert.throws(() => replay(allPlusGrid(3, 3), -1, []), AppError);
});

test("严格小于：u 恰好等于概率边界时拒绝", () => {
  // T 使 exp(-8/T) 取一个可精确比较的值：取 T = 8/ln2 则概率 = 0.5。
  const temperature = 8 / Math.log(2);
  assert.equal(isAccepted(8, temperature, 0.5), false);
  assert.equal(isAccepted(8, temperature, 0.5 - Number.EPSILON), true);
  assert.equal(isAccepted(8, 0, 0), false);
  // deltaE<=0 始终接受，即使 u 接近 1。
  assert.equal(isAccepted(-8, 0, 0.999), true);
  assert.equal(isAccepted(0, 0, 0.999), true);
});

test("u 校验：必须有限且 0 <= u < 1，即使该步无条件接受", () => {
  const grid = checkerGrid(4);
  // 在交替网格上找一个 deltaE<=0 的格，仍需校验 u。
  assert.throws(() => replay(grid, 1, [{ row: 0, col: 0, u: 1 as unknown as number }]), AppError);
  assert.throws(() => replay(grid, 1, [{ row: 0, col: 0, u: Number.NaN }]), AppError);
  assert.throws(() => replay(grid, 1, [{ row: 0, col: 0, u: -0.0001 }]), AppError);
  assert.throws(() => validateProposalBatch([{ row: 0, col: 0, u: Infinity }], 4, 4), AppError);
});

test("边角周期环绕的邻居", () => {
  const grid = allPlusGrid(4, 4);
  // 全部为 +1 时邻居恒为 +1；改为角落后检查具体环绕对象。
  grid[0]![3] = -1;
  grid[3]![0] = -1;
  grid[0]![1] = -1;
  const n00 = neighborsOf(grid, 0, 0);
  assert.equal(n00.up, -1); // (3,0)
  assert.equal(n00.down, 1);
  assert.equal(n00.left, -1); // (0,3)
  assert.equal(n00.right, -1); // (0,1)
});

test("能量差为零的提议接受且状态不变", () => {
  // 构造邻居和为 0 的格：自旋 +1，两上+两下合计 0。
  const grid = allPlusGrid(3, 3);
  grid[0]![1] = -1; // 目标格 (1,1) 的上邻
  grid[2]![1] = -1; // 下邻
  const sum = neighborsOf(grid, 1, 1);
  assert.equal(sum.up + sum.down + sum.left + sum.right, 0);
  assert.equal(deltaEnergyAt(grid, 1, 1), 0);
  const before = totalEnergy(grid);
  const result = replay(grid, 0, [{ row: 1, col: 1, u: 0.9 }]);
  assert.equal(result.steps[0]!.accepted, true);
  assert.equal(result.energy, before);
});

test("重复翻同格两次恢复原状态", () => {
  const grid = allPlusGrid(3, 3);
  const result = replay(grid, 100, [
    { row: 2, col: 2, u: 0.0001 },
    { row: 2, col: 2, u: 0.9999 } // deltaE=-8，无条件接受
  ]);
  assert.equal(result.steps[0]!.accepted, true);
  assert.equal(result.steps[1]!.accepted, true);
  assert.deepEqual(result.grid, grid);
  assert.equal(result.energy, -18);
  assert.equal(result.magnetization, 9);
});

test("多步回放：拒绝步棋盘完全不变但计为已处理", () => {
  const grid = allPlusGrid(3, 3);
  const result = replay(grid, 0, [
    { row: 0, col: 0, u: 0 }, // 拒绝
    { row: 0, col: 0, u: 0 }, // 再次拒绝（同一格，状态未变）
    { row: 1, col: 1, u: 0 }
  ]);
  assert.equal(result.steps.length, 3);
  assert.equal(result.rejectedCount, 3);
  assert.equal(result.acceptedCount, 0);
  assert.deepEqual(result.grid, grid);
});

test("逐格独立试翻：局部公式与全量重算能量一致（3x3 与 32x32 抽样）", () => {
  for (const size of [3, 4, 5, 32]) {
    const base = checkerGrid(size);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const local = deltaEnergyAt(base, r, c);
        const flipped = cloneGrid(base);
        flipped[r]![c] = (flipped[r]![c]! * -1) as 1 | -1;
        const globalDelta = totalEnergy(flipped) - totalEnergy(base);
        assert.equal(local, globalDelta, `size=${size} at (${r},${c})`);
      }
    }
  }
});

test("每次接受步骤后增量能量/磁化与独立重算一致", () => {
  const grid = checkerGrid(5);
  const result = replay(
    grid,
    1.2,
    Array.from({ length: 25 }, (_, i) => ({
      row: Math.floor(i / 5),
      col: i % 5,
      u: (i * 0.037) % 1
    }))
  );
  for (const step of result.steps) {
    // steps 已含逐步状态；这里核验最终状态自洽，并抽样核验逐步关系。
    assert.ok(step.energyAfter - step.energyBefore === (step.accepted ? step.deltaE : 0));
    const magDelta = step.magnetizationAfter - step.magnetizationBefore;
    assert.ok(step.accepted ? Math.abs(magDelta) === 2 : magDelta === 0);
  }
  const v = verifyState(result.grid, result.energy, result.magnetization);
  assert.equal(v.ok, true);
});

test("非法网格：尺寸越界、自旋非法、行列不齐", () => {
  assert.throws(() => validateGrid(allPlusGrid(2, 2)), AppError);
  assert.throws(() => validateGrid(allPlusGrid(33, 33)), AppError);
  assert.throws(() => validateGrid([[1, 1, 1], [1, 1]]), AppError);
  assert.throws(() => validateGrid([[1, 0, 1], [1, 1, 1], [1, 1, 1]]), AppError);
});

test("越界提议在整批校验时报错", () => {
  assert.throws(
    () => validateProposalBatch([{ row: 3, col: 0, u: 0.1 }], 3, 3),
    /越界/
  );
  assert.throws(
    () => validateProposalBatch([{ row: -1, col: 0, u: 0.1 }], 3, 3),
    AppError
  );
});
