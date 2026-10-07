import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.js";
import { allPlusGrid, verifyState } from "../src/engine.js";
import { AppError } from "../src/errors.js";

let store: Store;

before(() => {
  const dir = mkdtempSync(join(tmpdir(), "ising-db-test-"));
  store = new Store(join(dir, "test.sqlite"));
});

after(() => {
  store.close();
});

test("失败批次不部分推进：第二条提议非法时棋盘/版本不变", () => {
  const exp = store.createExperiment({ name: "fail-batch", grid: allPlusGrid(3, 3), temperature: 10 });
  assert.throws(
    () =>
      store.submitBatch({
        experimentId: exp.id,
        requestId: "bad-batch",
        baseVersion: 0,
        proposals: [
          { seq: 0, row: 0, col: 0, u: 0.0001 },
          { seq: 1, row: 9, col: 9, u: 0.5 }
        ]
      }),
    AppError
  );
  const unchanged = store.requireExperiment(exp.id);
  assert.equal(unchanged.version, 0);
  assert.equal(unchanged.energy, -18);
  assert.deepEqual(unchanged.grid, allPlusGrid(3, 3));
  assert.equal(store.listBatches(exp.id).length, 0);
});

test("重复 requestId 返回原结果且不新增版本", () => {
  const exp = store.createExperiment({ name: "idempotent", grid: allPlusGrid(3, 3), temperature: 10 });
  const args = {
    experimentId: exp.id,
    requestId: "same-req",
    baseVersion: 0,
    proposals: [{ seq: 0, row: 0, col: 0, u: 0.0001 }]
  };
  const first = store.submitBatch(args);
  assert.equal(first.replayed, false);
  const second = store.submitBatch(args);
  assert.equal(second.replayed, true);
  assert.equal(second.batch.id, first.batch.id);
  assert.equal(store.requireExperiment(exp.id).version, 1);
  assert.equal(store.listBatches(exp.id).length, 1);
});

test("相同 requestId 不同提议内容报错", () => {
  const exp = store.createExperiment({ name: "idemp-conflict", grid: allPlusGrid(3, 3), temperature: 10 });
  store.submitBatch({
    experimentId: exp.id,
    requestId: "dup",
    baseVersion: 0,
    proposals: [{ seq: 0, row: 0, col: 0, u: 0.1 }]
  });
  assert.throws(
    () =>
      store.submitBatch({
        experimentId: exp.id,
        requestId: "dup",
        baseVersion: 1,
        proposals: [{ seq: 0, row: 1, col: 1, u: 0.1 }]
      }),
    /已用于不同/
  );
});

test("旧版本提交冲突", () => {
  const exp = store.createExperiment({ name: "conflict", grid: allPlusGrid(3, 3), temperature: 10 });
  store.submitBatch({
    experimentId: exp.id,
    requestId: "v1",
    baseVersion: 0,
    proposals: [{ seq: 0, row: 0, col: 0, u: 0.0001 }]
  });
  assert.throws(
    () =>
      store.submitBatch({
        experimentId: exp.id,
        requestId: "stale",
        baseVersion: 0,
        proposals: [{ seq: 0, row: 1, col: 1, u: 0.1 }]
      }),
    /版本冲突/
  );
  // 基于当前版本可以成功。
  const ok = store.submitBatch({
    experimentId: exp.id,
    requestId: "v2",
    baseVersion: 1,
    proposals: [{ seq: 0, row: 1, col: 1, u: 0.0001 }]
  });
  assert.equal(ok.replayed, false);
  assert.equal(store.requireExperiment(exp.id).version, 2);
});

test("逐步历史与分页，且最终状态通过独立核验", () => {
  const exp = store.createExperiment({ name: "history", grid: allPlusGrid(3, 3), temperature: 100 });
  store.submitBatch({
    experimentId: exp.id,
    requestId: "multi",
    baseVersion: 0,
    proposals: [
      { seq: 0, row: 0, col: 0, u: 0.1 },
      { seq: 1, row: 0, col: 0, u: 0.9 },
      { seq: 2, row: 2, col: 2, u: 0.1 }
    ]
  });
  const page1 = store.listSteps(exp.id, 2, 0);
  assert.equal(page1.total, 3);
  assert.equal(page1.steps.length, 2);
  const page2 = store.listSteps(exp.id, 2, 2);
  assert.equal(page2.steps.length, 1);
  const step0 = store.getStep(exp.id, 0)!;
  assert.equal(step0.accepted, true);
  const finalExp = store.requireExperiment(exp.id);
  assert.equal(verifyState(finalExp.grid, finalExp.energy, finalExp.magnetization).ok, true);
});

test("从保存起点重放不落库；另存为新试验表达温度变化", () => {
  const exp = store.createExperiment({ name: "source", grid: allPlusGrid(3, 3), temperature: 0 });
  const batchesBefore = store.listBatches(exp.id).length;
  const out = store.replayFromSaved({
    experimentId: exp.id,
    temperature: 5,
    proposals: [{ seq: 0, row: 0, col: 0, u: 0.0001 }]
  });
  assert.equal(out.result.steps[0]!.accepted, true);
  assert.equal(store.listBatches(exp.id).length, batchesBefore);
  const fresh = store.saveReplayAsTrial({
    sourceExperimentId: exp.id,
    name: "derived",
    temperature: 5,
    result: out.result
  });
  assert.equal(fresh.temperature, 5);
  assert.equal(fresh.version, 0);
  assert.equal(store.requireExperiment(exp.id).temperature, 0);
  assert.equal(verifyState(fresh.grid, fresh.energy, fresh.magnetization).ok, true);
});
