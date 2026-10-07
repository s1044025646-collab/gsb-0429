import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { conflict, invalid, notFound } from "./errors.js";
import {
  assertGrid,
  BatchSimulation,
  cloneGrid,
  Grid,
  inspectStep,
  magnetization,
  Proposal,
  simulateBatch,
  totalEnergy,
  validateExpectedVersion,
  validateProposals,
  validateTemperature,
} from "./ising.js";

export interface BoardRecord {
  id: string;
  size: number;
  initialGrid: Grid;
  currentGrid: Grid;
  temperature: number;
  version: number;
  energy: number;
  magnetization: number;
  createdAt: string;
}

export interface SubmitInput {
  requestId: string;
  temperature: number;
  expectedVersion: number;
  proposals: Proposal[];
}

export interface SubmitOutput {
  idempotent: boolean;
  trialId: number;
  board: BoardRecord;
  simulation: BatchSimulation;
}

interface BoardRow {
  id: string;
  size: number;
  initial_grid: string;
  current_grid: string;
  temperature: number;
  version: number;
  created_at: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function rowToBoard(row: BoardRow): BoardRecord {
  const currentGrid = JSON.parse(row.current_grid) as Grid;
  return {
    id: row.id,
    size: row.size,
    initialGrid: JSON.parse(row.initial_grid) as Grid,
    currentGrid,
    temperature: row.temperature,
    version: row.version,
    energy: totalEnergy(currentGrid),
    magnetization: magnetization(currentGrid),
    createdAt: row.created_at,
  };
}

export class IsingStore {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const absolute = resolve(dbPath);
    mkdirSync(dirname(absolute), { recursive: true });
    this.db = new DatabaseSync(absolute);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.init();
  }

  close(): void {
    this.db.close();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS boards (
        id TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        initial_grid TEXT NOT NULL,
        current_grid TEXT NOT NULL,
        temperature REAL NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS trials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id TEXT NOT NULL REFERENCES boards(id),
        request_id TEXT NOT NULL,
        temperature REAL NOT NULL,
        expected_version INTEGER NOT NULL,
        after_version INTEGER NOT NULL,
        start_grid TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(board_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id TEXT NOT NULL REFERENCES boards(id),
        trial_id INTEGER NOT NULL REFERENCES trials(id),
        proposal_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        version_before INTEGER NOT NULL,
        version_after INTEGER NOT NULL,
        proposal_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        UNIQUE(board_id, proposal_id),
        UNIQUE(trial_id, step_index)
      );
    `);
  }

  createBoard(id: string | undefined, rawGrid: unknown, rawTemperature: unknown): BoardRecord {
    assertGrid(rawGrid);
    const temperature = validateTemperature(rawTemperature);
    const boardId = id?.trim() || crypto.randomUUID();
    const grid = cloneGrid(rawGrid);
    this.db
      .prepare(
        `INSERT INTO boards (id, size, initial_grid, current_grid, temperature)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(boardId, grid.length, JSON.stringify(grid), JSON.stringify(grid), temperature);
    return this.getBoard(boardId);
  }

  getBoard(id: string): BoardRecord {
    const row = this.db.prepare("SELECT * FROM boards WHERE id = ?").get(id) as BoardRow | undefined;
    if (!row) throw notFound(`棋盘不存在: ${id}`);
    return rowToBoard(row);
  }

  submitProposals(boardId: string, body: unknown): SubmitOutput {
    const boardBefore = this.getBoard(boardId);
    if (typeof body !== "object" || body === null) {
      const error = new Error("请求体必须是对象");
      error.name = "ValidationError";
      throw error;
    }
    const data = body as Record<string, unknown>;
    if (typeof data.requestId !== "string" || data.requestId.trim().length === 0) {
      const error = new Error("requestId 必须是非空字符串");
      error.name = "ValidationError";
      throw error;
    }
    const temperature = validateTemperature(data.temperature);
    const expectedVersion = validateExpectedVersion(data.expectedVersion);
    const proposals = validateProposals(data.proposals, boardBefore.size);
    const input = { requestId: data.requestId, temperature, expectedVersion, proposals };
    const payloadHash = stableJson({ temperature, expectedVersion, proposals });

    const existing = this.db
      .prepare("SELECT id, payload_hash FROM trials WHERE board_id = ? AND request_id = ?")
      .get(boardId, input.requestId) as { id: number; payload_hash: string } | undefined;
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        throw conflict("相同 requestId 关联了不同请求内容", { requestId: input.requestId });
      }
      return this.loadExistingSubmission(boardId, existing.id, input.proposals.length);
    }

    if (expectedVersion !== boardBefore.version) {
      throw conflict("expectedVersion 不是当前版本", {
        expectedVersion,
        currentVersion: boardBefore.version,
      });
    }

    const simulation = simulateBatch(
      { temperature, expectedVersion, proposals },
      boardBefore.currentGrid,
      boardBefore.version,
    );

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const trialResult = this.db
        .prepare(
          `INSERT INTO trials
             (board_id, request_id, temperature, expected_version, after_version, start_grid, payload_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          boardId,
          input.requestId,
          temperature,
          expectedVersion,
          simulation.finalVersion,
          JSON.stringify(simulation.startGrid),
          payloadHash,
        );
      const trialId = Number(trialResult.lastInsertRowid);
      const insertStep = this.db.prepare(
        `INSERT INTO steps
           (board_id, trial_id, proposal_id, step_index, version_before, version_after,
            proposal_json, result_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      simulation.results.forEach((result) => {
        const proposal = { id: result.id, row: result.row, col: result.col, u: result.u };
        insertStep.run(
          boardId,
          trialId,
          result.id,
          result.index,
          result.beforeVersion,
          result.afterVersion,
          JSON.stringify(proposal),
          JSON.stringify(result),
        );
      });
      this.db
        .prepare(
          `UPDATE boards
             SET current_grid = ?, temperature = ?, version = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(simulation.finalGrid), temperature, simulation.finalVersion, boardId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const created = this.db
      .prepare("SELECT id FROM trials WHERE board_id = ? AND request_id = ?")
      .get(boardId, input.requestId) as { id: number };
    return { idempotent: false, trialId: created.id, board: this.getBoard(boardId), simulation };
  }

  private loadExistingSubmission(boardId: string, trialId: number, count: number): SubmitOutput {
    const trial = this.db
      .prepare("SELECT * FROM trials WHERE id = ?")
      .get(trialId) as { start_grid: string } & Record<string, unknown>;
    const rows = this.db
    .prepare("SELECT result_json FROM steps WHERE trial_id = ? ORDER BY step_index")
    .all(trialId) as { result_json: string }[];
  if (rows.length !== count) {
    throw conflict("幂等请求的提议数量与原请求不一致", { expected: rows.length, received: count });
  }
    const results = rows.map((row) => JSON.parse(row.result_json) as BatchSimulation["results"][number]);
    const first = results[0]!;
    const last = results[results.length - 1]!;
    const board = this.getBoard(boardId);
    return {
      idempotent: true,
      trialId,
      board,
      simulation: {
        startGrid: JSON.parse(trial.start_grid) as Grid,
        finalGrid: board.currentGrid,
        startEnergy: first.energyBefore,
        finalEnergy: last.energyAfter,
        startMagnetization: first.magnetizationBefore,
        finalMagnetization: last.magnetizationAfter,
        startVersion: first.beforeVersion,
        finalVersion: last.afterVersion,
        results,
      },
    };
  }

  getStep(boardId: string, stepIndex: number) {
    const row = this.db
      .prepare("SELECT result_json, trial_id FROM steps WHERE board_id = ? AND version_after = ?")
      .get(boardId, stepIndex) as { result_json: string; trial_id: number } | undefined;
    if (!row) throw notFound(`步骤版本不存在: ${stepIndex}`);
    return { trialId: row.trial_id, result: JSON.parse(row.result_json) };
  }

  inspect(boardId: string, row: unknown, col: unknown, temperatureOverride?: unknown) {
    const board = this.getBoard(boardId);
    if (!Number.isInteger(row) || !Number.isInteger(col)) throw invalid("row 和 col 必须是整数");
    const r = row as number;
    const c = col as number;
    if (r < 0 || r >= board.size || c < 0 || c >= board.size) throw invalid("row 和 col 越界");
    const temperature = temperatureOverride === undefined ? board.temperature : validateTemperature(temperatureOverride);
    return { boardId, version: board.version, temperature, ...inspectStep(board.currentGrid, r, c, temperature) };
  }

  history(boardId: string, limitValue: unknown, offsetValue: unknown) {
    this.getBoard(boardId);
    const parsedLimit = typeof limitValue === "string" ? Number(limitValue) : limitValue;
    const parsedOffset = typeof offsetValue === "string" ? Number(offsetValue) : offsetValue;
    const limit = Number.isInteger(parsedLimit) && (parsedLimit as number) > 0 && (parsedLimit as number) <= 200 ? (parsedLimit as number) : 50;
    const offset = Number.isInteger(parsedOffset) && (parsedOffset as number) >= 0 ? (parsedOffset as number) : 0;
    const rows = this.db
      .prepare("SELECT result_json FROM steps WHERE board_id = ? ORDER BY version_after LIMIT ? OFFSET ?")
      .all(boardId, limit, offset) as { result_json: string }[];
    return { boardId, currentVersion: this.getBoard(boardId).version, limit, offset, steps: rows.map((row) => JSON.parse(row.result_json)) };
  }

  verify(boardId: string) {
    const board = this.getBoard(boardId);
    const recomputedEnergy = totalEnergy(board.currentGrid);
    const recomputedMagnetization = magnetization(board.currentGrid);
    const stepCountRow = this.db
      .prepare("SELECT COUNT(*) AS count, MAX(version_after) AS max_version FROM steps WHERE board_id = ?")
      .get(boardId) as { count: number; max_version: number | null };
    const energyDifferences: string[] = [];
    const magnetizationDifferences: string[] = [];
    let cumulativeEnergy = totalEnergy(board.initialGrid);
    let cumulativeMagnetization = magnetization(board.initialGrid);
    const results = this.db.prepare("SELECT result_json FROM steps WHERE board_id = ? ORDER BY version_after").all(boardId) as { result_json: string }[];
    for (const row of results) {
      const step = JSON.parse(row.result_json) as BatchSimulation["results"][number];
      cumulativeEnergy += step.accepted ? step.deltaEnergy : 0;
      cumulativeMagnetization += step.accepted ? step.spinAfter - step.spinBefore : 0;
      if (cumulativeEnergy !== step.energyAfter) energyDifferences.push(`版本 ${step.afterVersion}: 累加 ${cumulativeEnergy}, 记录 ${step.energyAfter}`);
      if (cumulativeMagnetization !== step.magnetizationAfter) magnetizationDifferences.push(`版本 ${step.afterVersion}: 累加 ${cumulativeMagnetization}, 记录 ${step.magnetizationAfter}`);
    }
    return {
      ok: recomputedEnergy === board.energy && recomputedMagnetization === board.magnetization && energyDifferences.length === 0 && magnetizationDifferences.length === 0 && stepCountRow.count === board.version,
      version: board.version,
      recordedStepCount: stepCountRow.count,
      maxStepVersion: stepCountRow.max_version,
      recordedEnergy: board.energy,
      recomputedEnergy,
      energyDifference: recomputedEnergy - board.energy,
      recordedMagnetization: board.magnetization,
      recomputedMagnetization,
      magnetizationDifference: recomputedMagnetization - board.magnetization,
      energyDifferences,
      magnetizationDifferences,
    };
  }

  replay(boardId: string, toVersionValue?: unknown) {
    const board = this.getBoard(boardId);
    const normalizedToVersion = typeof toVersionValue === "string" ? Number(toVersionValue) : toVersionValue;
    const toVersion = normalizedToVersion === undefined ? board.version : validateExpectedVersion(normalizedToVersion);
    if (toVersion > board.version) throw invalid("toVersion 不能大于当前版本");
    let grid = cloneGrid(board.initialGrid);
    const rows = this.db
      .prepare("SELECT t.temperature, s.proposal_json FROM trials t JOIN steps s ON s.trial_id = t.id WHERE t.board_id = ? AND s.version_after <= ? ORDER BY s.version_after")
      .all(boardId, toVersion) as { temperature: number; proposal_json: string }[];
    for (const row of rows) {
      const proposal = JSON.parse(row.proposal_json) as Proposal;
      grid = simulateBatch({ temperature: row.temperature, expectedVersion: 0, proposals: [proposal] }, grid, 0).finalGrid;
    }
    return {
      boardId,
      replayedToVersion: toVersion,
      grid,
      energy: totalEnergy(grid),
      magnetization: magnetization(grid),
      matchesCurrent: toVersion === board.version && stableJson(grid) === stableJson(board.currentGrid),
    };
  }
}
