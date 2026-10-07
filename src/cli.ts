#!/usr/bin/env node
import { resolve } from "node:path";
import { IsingStore } from "./db.js";
import { startServer } from "./server.js";

function parseJsonFlag(value: string | undefined, fallback: unknown = {}): unknown {
  if (value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`无法解析 JSON: ${(error as Error).message}`);
  }
}

function arg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const dbPath = resolve(arg(args, "--db") ?? "data/ising.sqlite");

  if (command === "serve") {
    const port = Number(arg(args, "--port") ?? process.env.PORT ?? "0");
    await startServer(Number.isInteger(port) ? port : 0, dbPath);
    return;
  }

  const store = new IsingStore(dbPath);
  try {
    const boardId = args.find((value) => !value.startsWith("--") && value !== command) ?? "";
    if (command === "create") {
      const body = parseJsonFlag(arg(args, "--body")) as Record<string, unknown>;
      console.log(JSON.stringify(store.createBoard(typeof body.id === "string" ? body.id : undefined, body.grid, body.temperature), null, 2));
    } else if (command === "get") {
      console.log(JSON.stringify(store.getBoard(boardId), null, 2));
    } else if (command === "submit") {
      console.log(JSON.stringify(store.submitProposals(boardId, parseJsonFlag(arg(args, "--body"))), null, 2));
    } else if (command === "step") {
      const step = Number(arg(args, "--step"));
      if (!Number.isInteger(step) || step <= 0) throw new Error("--step 必须是正整数");
      console.log(JSON.stringify(store.getStep(boardId, step), null, 2));
    } else if (command === "inspect") {
      const body = parseJsonFlag(arg(args, "--body")) as Record<string, unknown>;
      console.log(JSON.stringify(store.inspect(boardId, body.row, body.col, body.temperature), null, 2));
    } else if (command === "verify") {
      console.log(JSON.stringify(store.verify(boardId), null, 2));
    } else if (command === "history") {
      console.log(JSON.stringify(store.history(boardId, arg(args, "--limit"), arg(args, "--offset")), null, 2));
    } else if (command === "replay") {
      console.log(JSON.stringify(store.replay(boardId, arg(args, "--to")), null, 2));
    } else {
      console.log(`用法:
  ising serve [--port 0] [--db data/ising.sqlite]
  ising create --body '{"id":"demo","grid":[[1,1,1],[1,1,1],[1,1,1]],"temperature":0}'
  ising get BOARD_ID [--db ...]
  ising submit BOARD_ID --body '{"requestId":"r1","expectedVersion":0,"temperature":0,"proposals":[{"id":"p1","row":0,"col":0,"u":0}]}'
  ising step BOARD_ID --step 1
  ising inspect BOARD_ID --body '{"row":0,"col":0,"temperature":2}'
  ising verify BOARD_ID
  ising history BOARD_ID --limit 50 --offset 0
  ising replay BOARD_ID --to 3`);
    }
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: { code: "CLI_ERROR", message: error.message } }, null, 2));
  process.exitCode = 1;
});
