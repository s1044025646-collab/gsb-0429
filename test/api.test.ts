import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { Store } from "../src/db.js";
import { startServer } from "../src/server.js";
import { allPlusGrid } from "../src/engine.js";

let store: Store;
let server: Server;
let base: string;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ising-api-test-"));
  store = new Store(join(dir, "api.sqlite"));
  const started = await startServer(store);
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  store.close();
});

async function api(path: string, init?: RequestInit & { json?: unknown }) {
  const res = await fetch(base + path, {
    method: init?.method ?? (init?.json !== undefined ? "POST" : "GET"),
    headers: init?.json !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined
  });
  const body = await res.json();
  return { status: res.status, body };
}

test("健康检查", async () => {
  const r = await api("/api/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test("完整 API 流程：建棋盘、提交、查询、inspect、核验、历史、回放", async () => {
  const created = await api("/api/experiments", {
    json: { name: "api-flow", grid: allPlusGrid(3, 3), temperature: 10 }
  });
  assert.equal(created.status, 201);
  const id = created.body.id as number;
  assert.equal(created.body.energy, -18);
  assert.equal(created.body.magnetization, 9);

  const submit = await api(`/api/experiments/${id}/proposals`, {
    json: {
      requestId: "api-req-1",
      proposals: [{ row: 0, col: 0, u: 0.0001 }]
    }
  });
  assert.equal(submit.status, 201);
  assert.equal(submit.body.batch.steps[0].deltaE, 8);
  assert.equal(submit.body.batch.steps[0].accepted, true);
  assert.equal(submit.body.experiment.version, 1);

  // 幂等重复。
  const repeat = await api(`/api/experiments/${id}/proposals`, {
    json: { requestId: "api-req-1", proposals: [{ row: 0, col: 0, u: 0.0001 }] }
  });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.idempotent, true);

  // 旧版本冲突。
  const conflict = await api(`/api/experiments/${id}/proposals`, {
    json: {
      requestId: "api-req-stale",
      baseVersion: 0,
      proposals: [{ row: 1, col: 1, u: 0.1 }]
    }
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "VERSION_CONFLICT");

  // inspect 已发生步骤。
  const inspectStep = await api(`/api/experiments/${id}/steps/0/inspect`);
  assert.equal(inspectStep.status, 200);
  assert.equal(inspectStep.body.delta_e, 8);

  // inspect 当前棋盘任意格的邻居与概率（不改变状态）。
  const inspectCurrent = await api(`/api/experiments/${id}/steps/0/inspect?row=0&col=0`);
  assert.equal(inspectCurrent.status, 200);
  assert.equal(inspectCurrent.body.scope, "current");
  assert.equal(typeof inspectCurrent.body.acceptProbability, "number");

  const verify = await api(`/api/experiments/${id}/verify`);
  assert.equal(verify.body.ok, true);

  const history = await api(`/api/experiments/${id}/history?limit=1&offset=0`);
  assert.equal(history.body.total, 1);
  assert.equal(history.body.steps.length, 1);

  // 从保存起点用不同温度不落库重放。
  const replay = await api(`/api/experiments/${id}/replay`, {
    json: { temperature: 0, proposals: [{ row: 1, col: 1, u: 0 }], saveAs: true, name: "api-derived" }
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.savedAsNewExperiment.temperature, 0);
});

test("非法批次整体拒绝：400 且状态不变", async () => {
  const created = await api("/api/experiments", {
    json: { grid: allPlusGrid(3, 3), temperature: 1 }
  });
  const id = created.body.id as number;
  const bad = await api(`/api/experiments/${id}/proposals`, {
    json: {
      requestId: "bad",
      proposals: [
        { row: 0, col: 0, u: 0.1 },
        { row: 0, col: 0, u: 1 }
      ]
    }
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "INVALID_U");
  const exp = await api(`/api/experiments/${id}`);
  assert.equal(exp.body.version, 0);
});

test("非法 JSON、负温、越界分别返回明确错误码", async () => {
  const res = await fetch(base + "/api/experiments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json"
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "INVALID_JSON");

  const neg = await api("/api/experiments", { json: { grid: allPlusGrid(3, 3), temperature: -1 } });
  assert.equal(neg.body.error.code, "INVALID_TEMPERATURE");

  const missing = await api("/api/experiments/9999");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "NOT_FOUND");
});
