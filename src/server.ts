import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { AppError } from "./errors.js";
import { IsingStore } from "./db.js";

function isMain(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

export function createApp(store: IsingStore) {
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body, null, 2));
  };

  const readJson = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new AppError("INVALID_JSON", "请求体不是合法 JSON", 400);
    }
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        send(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && parts.length === 1 && parts[0] === "boards") {
        const body = (await readJson(req)) as Record<string, unknown>;
        send(res, 201, store.createBoard(typeof body.id === "string" ? body.id : undefined, body.grid, body.temperature));
        return;
      }

      if (method === "GET" && parts.length === 2 && parts[0] === "boards") {
        send(res, 200, store.getBoard(parts[1]!));
        return;
      }

      if (method === "POST" && parts.length === 3 && parts[0] === "boards" && parts[2] === "proposals") {
        send(res, 200, store.submitProposals(parts[1]!, await readJson(req)));
        return;
      }

      if (method === "GET" && parts.length === 4 && parts[0] === "boards" && parts[2] === "steps") {
        const step = Number(parts[3]);
        if (!Number.isInteger(step) || step <= 0) throw new AppError("INVALID_ARGUMENT", "step 必须是正整数版本号", 400);
        send(res, 200, store.getStep(parts[1]!, step));
        return;
      }

      if (method === "POST" && parts.length === 3 && parts[0] === "boards" && parts[2] === "inspect") {
        const body = (await readJson(req)) as Record<string, unknown>;
        send(res, 200, store.inspect(parts[1]!, body.row, body.col, body.temperature));
        return;
      }

      if (method === "GET" && parts.length === 3 && parts[0] === "boards" && parts[2] === "verify") {
        send(res, 200, store.verify(parts[1]!));
        return;
      }

      if (method === "GET" && parts.length === 3 && parts[0] === "boards" && parts[2] === "history") {
        send(res, 200, store.history(parts[1]!, url.searchParams.get("limit"), url.searchParams.get("offset")));
        return;
      }

      if (method === "POST" && parts.length === 3 && parts[0] === "boards" && parts[2] === "replay") {
        const body = (await readJson(req)) as Record<string, unknown>;
        send(res, 200, store.replay(parts[1]!, body.toVersion));
        return;
      }

      send(res, 404, { error: { code: "NOT_FOUND", message: "接口不存在" } });
    } catch (error) {
      if (error instanceof AppError) {
        send(res, error.status, { error: { code: error.code, message: error.message, details: error.details } });
      } else if (error instanceof Error) {
        const unique = /SQLITE_CONSTRAINT_UNIQUE/.test(error.message)
          ? { status: 409, code: "RESOURCE_CONFLICT", message: "资源编号冲突" }
          : undefined;
        send(res, unique?.status ?? 500, {
          error: { code: unique?.code ?? "INTERNAL", message: unique?.message ?? error.message },
        });
      } else {
        send(res, 500, { error: { code: "INTERNAL", message: "未知错误" } });
      }
    }
  });
}

export function startServer(port = 0, dbPath = resolve("data/ising.sqlite")): Promise<{ server: Server; port: number; store: IsingStore }> {
  const store = new IsingStore(dbPath);
  const server = createApp(store);
  return new Promise((resolveServer) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("无法确定监听端口");
      console.log(`Ising API: http://127.0.0.1:${address.port}`);
      console.log(`SQLite: ${resolve(dbPath)}`);
      resolveServer({ server, port: address.port, store });
    });
  });
}

if (isMain()) {
  const configuredPort = Number(process.env.PORT ?? "0");
  startServer(Number.isInteger(configuredPort) ? configuredPort : 0, process.env.ISING_DB ?? resolve("data/ising.sqlite"));
}
