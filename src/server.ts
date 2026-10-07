import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { AppError, errorBody } from "./errors.js";
import { Store } from "./db.js";
import {
  Proposal,
  neighborsOf,
  deltaEnergyAt,
  acceptProbability,
  validateProposalBatch,
  verifyState
} from "./engine.js";

function findFreePort(preferred?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    const onError = (err: Error) => {
      srv.close();
      if (preferred !== undefined && (err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        srv.listen(0, "127.0.0.1");
      } else {
        reject(err);
      }
    };
    srv.once("error", onError);
    srv.listen(preferred ?? 0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new AppError("BAD_REQUEST", "请求体超过 2MB 限制", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new AppError("INVALID_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

export interface AppContext {
  store: Store;
}

function experimentSummary(e: {
  id: number;
  name: string | null;
  rows: number;
  cols: number;
  temperature: number;
  grid: number[][];
  energy: number;
  magnetization: number;
  version: number;
  createdAt: string;
}) {
  return {
    id: e.id,
    name: e.name,
    rows: e.rows,
    cols: e.cols,
    temperature: e.temperature,
    grid: e.grid,
    energy: e.energy,
    magnetization: e.magnetization,
    version: e.version,
    createdAt: e.createdAt
  };
}

type Handler = (
  ctx: AppContext,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  match: RegExpMatchArray
) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const routes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/health$/,
    handler: async (_c, _r, res) => {
      send(res, 200, { ok: true });
    }
  },
  {
    method: "GET",
    pattern: /^\/api\/experiments$/,
    handler: async (c, _r, res) => {
      send(res, 200, { experiments: c.store.listExperiments().map(experimentSummary) });
    }
  },
  {
    method: "POST",
    pattern: /^\/api\/experiments$/,
    handler: async (c, _r, res, body) => {
      const b = body as Record<string, unknown>;
      const exp = c.store.createExperiment({
        name: typeof b.name === "string" ? b.name : null,
        grid: b.grid,
        temperature: b.temperature
      });
      send(res, 201, experimentSummary(exp));
    }
  },
  {
    method: "GET",
    pattern: /^\/api\/experiments\/(\d+)$/,
    handler: async (c, _r, res, _b, match) => {
      const exp = c.store.requireExperiment(Number(match![1]));
      send(res, 200, experimentSummary(exp));
    }
  },
  {
    method: "POST",
    pattern: /^\/api\/experiments\/(\d+)\/proposals$/,
    handler: async (c, _r, res, body, match) => {
      const experimentId = Number(match![1]);
      const exp = c.store.requireExperiment(experimentId);
      const b = body as Record<string, unknown>;
      const requestId = b.requestId;
      if (typeof requestId !== "string" || requestId.length === 0) {
        throw new AppError("INVALID_PROPOSAL", "requestId 必须为非空字符串");
      }
      const baseVersion =
        b.baseVersion === undefined ? exp.version : (b.baseVersion as unknown);
      if (!Number.isInteger(baseVersion) || (baseVersion as number) < 0) {
        throw new AppError("INVALID_PROPOSAL", "baseVersion 必须为非负整数");
      }
      // 执行前校验整个批次：任何一条非法都不推进。
      const proposals: Proposal[] = validateProposalBatch(b.proposals, exp.rows, exp.cols);
      const { batch, replayed } = c.store.submitBatch({
        experimentId,
        requestId,
        baseVersion: baseVersion as number,
        proposals
      });
      const after = c.store.requireExperiment(experimentId);
      send(res, replayed ? 200 : 201, {
        idempotent: replayed,
        batch: {
          id: batch.id,
          requestId: batch.requestId,
          baseVersion: batch.baseVersion,
          newVersion: batch.newVersion,
          acceptedCount: batch.acceptedCount,
          rejectedCount: batch.rejectedCount,
          steps: batch.result.steps
        },
        experiment: experimentSummary(after)
      });
    }
  },
  {
    method: "GET",
    pattern: /^\/api\/experiments\/(\d+)\/steps\/(\d+)\/inspect$/,
    handler: async (c, req, res, _b, match) => {
      const experimentId = Number(match![1]);
      const globalStep = Number(match![2]);
      const exp = c.store.requireExperiment(experimentId);
      const rowParam = new URL(req.url!, "http://localhost").searchParams.get("row");
      const colParam = new URL(req.url!, "http://localhost").searchParams.get("col");

      // 默认查看已发生的全局步骤；也可用 ?row=&col= 查看当前棋盘上任意格的即时信息（不改变状态）。
      if (rowParam !== null && colParam !== null) {
        const row = Number(rowParam);
        const col = Number(colParam);
        if (!Number.isInteger(row) || !Number.isInteger(col)) {
          throw new AppError("BAD_REQUEST", "row、col 必须为整数");
        }
        if (row < 0 || row >= exp.rows || col < 0 || col >= exp.cols) {
          throw new AppError("OUT_OF_BOUNDS", `(${row}, ${col}) 越界`);
        }
        const neighbors = neighborsOf(exp.grid, row, col);
        const deltaE = deltaEnergyAt(exp.grid, row, col);
        send(res, 200, {
          scope: "current",
          row,
          col,
          spin: exp.grid[row]![col],
          neighbors,
          neighborSum: neighbors.up + neighbors.down + neighbors.left + neighbors.right,
          deltaE,
          temperature: exp.temperature,
          acceptProbability: acceptProbability(deltaE, exp.temperature)
        });
        return;
      }

      const step = c.store.getStep(experimentId, globalStep);
      if (!step) {
        throw new AppError("NOT_FOUND", `全局步骤 ${globalStep} 不存在`, 404);
      }
      send(res, 200, { scope: "step", ...step });
    }
  },
  {
    method: "GET",
    pattern: /^\/api\/experiments\/(\d+)\/verify$/,
    handler: async (c, _r, res, _b, match) => {
      const experimentId = Number(match![1]);
      const exp = c.store.requireExperiment(experimentId);
      send(res, 200, verifyState(exp.grid, exp.energy, exp.magnetization));
    }
  },
  {
    method: "GET",
    pattern: /^\/api\/experiments\/(\d+)\/history$/,
    handler: async (c, req, res, _b, match) => {
      const experimentId = Number(match![1]);
      c.store.requireExperiment(experimentId);
      const params = new URL(req.url!, "http://localhost").searchParams;
      const limit = Number(params.get("limit") ?? "50");
      const offset = Number(params.get("offset") ?? "0");
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new AppError("INVALID_PAGINATION", "limit 必须为 1..500 的整数");
      }
      if (!Number.isInteger(offset) || offset < 0) {
        throw new AppError("INVALID_PAGINATION", "offset 必须为非负整数");
      }
      const { steps, total } = c.store.listSteps(experimentId, limit, offset);
      send(res, 200, {
        total,
        limit,
        offset,
        batches: c.store.listBatches(experimentId).map((b) => ({
          id: b.id,
          requestId: b.requestId,
          baseVersion: b.baseVersion,
          newVersion: b.newVersion,
          acceptedCount: b.acceptedCount,
          rejectedCount: b.rejectedCount,
          createdAt: b.createdAt
        })),
        steps
      });
    }
  },
  {
    method: "POST",
    pattern: /^\/api\/experiments\/(\d+)\/replay$/,
    handler: async (c, _r, res, body, match) => {
      const experimentId = Number(match![1]);
      const exp = c.store.requireExperiment(experimentId);
      const b = body as Record<string, unknown>;
      const proposals = validateProposalBatch(b.proposals, exp.rows, exp.cols);
      const temperature =
        b.temperature === undefined ? exp.temperature : (b.temperature as number);
      const out = c.store.replayFromSaved({ experimentId, temperature, proposals });
      let savedAs = null;
      if (b.saveAs === true) {
        savedAs = c.store.saveReplayAsTrial({
          sourceExperimentId: experimentId,
          name: typeof b.name === "string" ? b.name : null,
          temperature: out.temperature,
          result: out.result
        });
      }
      send(res, 200, {
        sourceExperimentId: experimentId,
        sourceVersion: exp.version,
        temperatureUsed: out.temperature,
        savedAsNewExperiment: savedAs ? experimentSummary(savedAs) : null,
        result: out.result
      });
    }
  }
];

export function createApp(store: Store): Server {
  const ctx: AppContext = { store };
  return createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url!, "http://localhost").pathname;
      let body: unknown = {};
      if (req.method === "POST") {
        body = await readJson(req);
      }
      for (const route of routes) {
        const m = pathname.match(route.pattern);
        if (m && req.method === route.method) {
          await route.handler(ctx, req, res, body, m);
          return;
        }
      }
      const anyMatch = routes.some((r) => pathname.match(r.pattern));
      if (anyMatch) {
        throw new AppError("METHOD_NOT_ALLOWED", `方法 ${req.method} 不允许`, 405);
      }
      send(res, 404, errorBody("NOT_FOUND", `路径 ${pathname} 不存在`));
    } catch (err) {
      if (err instanceof AppError) {
        send(res, err.status, errorBody(err.code, err.message, err.details));
      } else {
        send(res, 500, errorBody("BAD_REQUEST", (err as Error).message));
      }
    }
  });
}

export async function startServer(store: Store, preferredPort?: number): Promise<{ server: Server; port: number }> {
  const port = await findFreePort(preferredPort);
  const server = createApp(store);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, port };
}
