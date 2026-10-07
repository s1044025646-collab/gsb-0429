#!/usr/bin/env node
import { resolve } from "node:path";
import { Store } from "./db.js";
import { startServer } from "./server.js";
import { allPlusGrid } from "./engine.js";

const DEFAULT_DB = resolve(process.cwd(), "data", "ising.sqlite");

function help(): void {
  console.log(`二维 Ising 提议序列回放后端（仅 API + CLI）

用法:
  ising serve [--port N] [--db PATH]
      启动 HTTP API。默认数据文件 ${DEFAULT_DB}；端口默认自动选择空闲端口。
  ising init-db [--db PATH]
      创建/初始化 SQLite 数据库后退出。
  ising selftest [--db PATH]
      用 3x3 全正一网格做内置冒烟演示（建表、正温接受、零温拒绝、翻回、核验）。

环境变量:
  ISING_PORT   等价于 --port
  ISING_DB     等价于 --db
`);
}

function parseArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function dbPath(): string {
  return resolve(process.cwd(), parseArg("--db") ?? process.env.ISING_DB ?? "data/ising.sqlite");
}

async function serve(): Promise<void> {
  const preferred = parseArg("--port") ?? process.env.ISING_PORT;
  const store = new Store(dbPath());
  const { port } = await startServer(store, preferred ? Number(preferred) : undefined);
  console.log(JSON.stringify({
    status: "listening",
    host: "127.0.0.1",
    port,
    db: dbPath(),
    health: `http://127.0.0.1:${port}/api/health`
  }, null, 2));
}

async function selfTest(): Promise<void> {
  const store = new Store(dbPath());
  const exp = store.createExperiment({
    name: "cli-selftest",
    grid: allPlusGrid(3, 3),
    temperature: 10
  });
  console.log("初始:", { energy: exp.energy, magnetization: exp.magnetization, version: exp.version });
  const { batch } = store.submitBatch({
    experimentId: exp.id,
    requestId: `selftest-${Date.now()}`,
    baseVersion: 0,
    proposals: [{ seq: 0, row: 0, col: 0, u: 0.0001 }]
  });
  console.log("正温小 u:", batch.result.steps[0]);
  const after = store.requireExperiment(exp.id);
  console.log("当前:", { energy: after.energy, magnetization: after.magnetization });
  store.close();
}

const command = process.argv[2];
if (command === "serve") {
  serve().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (command === "init-db") {
  const store = new Store(dbPath());
  store.close();
  console.log(`数据库已初始化: ${dbPath()}`);
} else if (command === "selftest") {
  selfTest().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  help();
}
