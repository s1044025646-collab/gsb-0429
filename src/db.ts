import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "./errors.js";
import {
  Grid,
  Proposal,
  ReplayResult,
  cloneGrid,
  replay,
  totalEnergy,
  magnetization,
  validateGrid,
  validateTemperature
} from "./engine.js";

export interface ExperimentRecord {
  id: number;
  name: string | null;
  rows: number;
  cols: number;
  temperature: number;
  initialGrid: Grid;
  grid: Grid;
  energy: number;
  magnetization: number;
  version: number;
  createdAt: string;
}

export interface BatchRecord {
  id: number;
  experimentId: number;
  requestId: string;
  baseVersion: number;
  newVersion: number;
  acceptedCount: number;
  rejectedCount: number;
  result: ReplayResult;
  createdAt: string;
}

function hashProposals(proposals: Proposal[]): string {
  return createHash("sha256").update(JSON.stringify(proposals)).digest("hex");
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS experiments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        rows INTEGER NOT NULL,
        cols INTEGER NOT NULL,
        temperature REAL NOT NULL,
        initial_grid TEXT NOT NULL,
        current_grid TEXT NOT NULL,
        current_energy INTEGER NOT NULL,
        current_mag INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_id INTEGER NOT NULL REFERENCES experiments(id),
        request_id TEXT NOT NULL,
        base_version INTEGER NOT NULL,
        new_version INTEGER NOT NULL,
        proposal_hash TEXT NOT NULL,
        proposals_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        accepted_count INTEGER NOT NULL,
        rejected_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(experiment_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_id INTEGER NOT NULL REFERENCES experiments(id),
        batch_id INTEGER NOT NULL REFERENCES batches(id),
        seq INTEGER NOT NULL,
        global_step INTEGER NOT NULL,
        row INTEGER NOT NULL,
        col INTEGER NOT NULL,
        u REAL NOT NULL,
        neighbors_json TEXT NOT NULL,
        neighbor_sum INTEGER NOT NULL,
        delta_e INTEGER NOT NULL,
        accept_probability REAL,
        accepted INTEGER NOT NULL,
        energy_before INTEGER NOT NULL,
        energy_after INTEGER NOT NULL,
        mag_before INTEGER NOT NULL,
        mag_after INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_steps_exp ON steps(experiment_id, global_step);
      CREATE INDEX IF NOT EXISTS idx_batches_exp ON batches(experiment_id, id);
    `);
  }

  createExperiment(input: {
    name?: string | null;
    grid: unknown;
    temperature: unknown;
  }): ExperimentRecord {
    const grid = validateGrid(input.grid);
    const temperature = validateTemperature(input.temperature);
    const energy = totalEnergy(grid);
    const mag = magnetization(grid);
    const stmt = this.db.prepare(`
      INSERT INTO experiments (name, rows, cols, temperature, initial_grid, current_grid, current_energy, current_mag, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);
    const info = stmt.run(
      input.name ?? null,
      grid.length,
      grid[0]!.length,
      temperature,
      JSON.stringify(grid),
      JSON.stringify(grid),
      energy,
      mag
    );
    return this.getExperiment(Number(info.lastInsertRowid))!;
  }

  private rowToExperiment(row: Record<string, unknown>): ExperimentRecord {
    return {
      id: Number(row.id),
      name: (row.name as string | null) ?? null,
      rows: Number(row.rows),
      cols: Number(row.cols),
      temperature: Number(row.temperature),
      initialGrid: JSON.parse(row.initial_grid as string) as Grid,
      grid: JSON.parse(row.current_grid as string) as Grid,
      energy: Number(row.current_energy),
      magnetization: Number(row.current_mag),
      version: Number(row.version),
      createdAt: row.created_at as string
    };
  }

  getExperiment(id: number): ExperimentRecord | null {
    const row = this.db
      .prepare("SELECT * FROM experiments WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToExperiment(row) : null;
  }

  requireExperiment(id: number): ExperimentRecord {
    const exp = this.getExperiment(id);
    if (!exp) {
      throw new AppError("NOT_FOUND", `试验 id=${id} 不存在`, 404);
    }
    return exp;
  }

  listExperiments(): ExperimentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM experiments ORDER BY id")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToExperiment(r));
  }

  submitBatch(input: {
    experimentId: number;
    requestId: string;
    baseVersion: number;
    proposals: Proposal[];
  }): { batch: BatchRecord; replayed: boolean } {
    const exp = this.requireExperiment(input.experimentId);
    if (typeof input.requestId !== "string" || input.requestId.length === 0) {
      throw new AppError("INVALID_PROPOSAL", "requestId 必须为非空字符串");
    }
    if (!Number.isInteger(input.baseVersion) || input.baseVersion < 0) {
      throw new AppError("INVALID_PROPOSAL", "baseVersion 必须为非负整数");
    }

    const existing = this.db
      .prepare("SELECT * FROM batches WHERE experiment_id = ? AND request_id = ?")
      .get(input.experimentId, input.requestId) as Record<string, unknown> | undefined;
    if (existing) {
      const sameHash = existing.proposal_hash === hashProposals(input.proposals);
      if (!sameHash) {
        throw new AppError(
          "REQUEST_ID_REPLAY",
          `requestId=${input.requestId} 已用于不同的提议内容`,
          409
        );
      }
      return { batch: this.rowToBatch(existing), replayed: true };
    }

    if (input.baseVersion !== exp.version) {
      throw new AppError(
        "VERSION_CONFLICT",
        `版本冲突：请求基于版本 ${input.baseVersion}，当前版本为 ${exp.version}`,
        409
      );
    }

    // 全批已在 handler 中完成校验；此处事务内重放并原子写入。
    const result = replay(exp.grid, exp.temperature, input.proposals);
    const newGrid = result.grid;
    const proposalHash = hashProposals(input.proposals);

    let batchId = 0;
    const tx = this.db.exec.bind(this.db);
    tx("BEGIN IMMEDIATE");
    try {
      const currentVersionRow = this.db
        .prepare("SELECT version FROM experiments WHERE id = ?")
        .get(input.experimentId) as Record<string, unknown>;
      if (Number(currentVersionRow.version) !== input.baseVersion) {
        throw new AppError("VERSION_CONFLICT", "事务内检测到版本冲突", 409);
      }

      const batchInfo = this.db
        .prepare(`
          INSERT INTO batches (experiment_id, request_id, base_version, new_version, proposal_hash, proposals_json, result_json, accepted_count, rejected_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.experimentId,
          input.requestId,
          input.baseVersion,
          input.baseVersion + 1,
          proposalHash,
          JSON.stringify(input.proposals),
          JSON.stringify(result),
          result.acceptedCount,
          result.rejectedCount
        );
      batchId = Number(batchInfo.lastInsertRowid);

      const priorSteps = Number(
        (this.db
          .prepare("SELECT COUNT(*) AS n FROM steps WHERE experiment_id = ?")
          .get(input.experimentId) as Record<string, unknown>).n
      );
      const insertStep = this.db.prepare(`
        INSERT INTO steps (experiment_id, batch_id, seq, global_step, row, col, u, neighbors_json, neighbor_sum, delta_e, accept_probability, accepted, energy_before, energy_after, mag_before, mag_after)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      result.steps.forEach((s) => {
        insertStep.run(
          input.experimentId,
          batchId,
          s.seq,
          priorSteps + s.seq,
          s.row,
          s.col,
          s.u,
          JSON.stringify(s.neighbors),
          s.neighborSum,
          s.deltaE,
          s.acceptProbability,
          s.accepted ? 1 : 0,
          s.energyBefore,
          s.energyAfter,
          s.magnetizationBefore,
          s.magnetizationAfter
        );
      });

      this.db
        .prepare(
          "UPDATE experiments SET current_grid = ?, current_energy = ?, current_mag = ?, version = ? WHERE id = ?"
        )
        .run(
          JSON.stringify(newGrid),
          result.energy,
          result.magnetization,
          input.baseVersion + 1,
          input.experimentId
        );
      tx("COMMIT");
    } catch (err) {
      tx("ROLLBACK");
      throw err;
    }

    const saved = this.db.prepare("SELECT * FROM batches WHERE id = ?").get(batchId) as Record<
      string,
      unknown
    >;
    return { batch: this.rowToBatch(saved), replayed: false };
  }

  private rowToBatch(row: Record<string, unknown>): BatchRecord {
    return {
      id: Number(row.id),
      experimentId: Number(row.experiment_id),
      requestId: row.request_id as string,
      baseVersion: Number(row.base_version),
      newVersion: Number(row.new_version),
      acceptedCount: Number(row.accepted_count),
      rejectedCount: Number(row.rejected_count),
      result: JSON.parse(row.result_json as string) as ReplayResult,
      createdAt: row.created_at as string
    };
  }

  getBatch(experimentId: number, batchId: number): BatchRecord | null {
    const row = this.db
      .prepare("SELECT * FROM batches WHERE experiment_id = ? AND id = ?")
      .get(experimentId, batchId) as Record<string, unknown> | undefined;
    return row ? this.rowToBatch(row) : null;
  }

  listBatches(experimentId: number): BatchRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM batches WHERE experiment_id = ? ORDER BY id")
      .all(experimentId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToBatch(r));
  }

  getStep(experimentId: number, globalStep: number): Record<string, unknown> | null {
    const row = this.db
      .prepare("SELECT * FROM steps WHERE experiment_id = ? AND global_step = ?")
      .get(experimentId, globalStep) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      ...row,
      accepted: row.accepted === 1,
      neighbors: JSON.parse(row.neighbors_json as string)
    };
  }

  listSteps(
    experimentId: number,
    limit: number,
    offset: number
  ): { steps: Record<string, unknown>[]; total: number } {
    const total = Number(
      (this.db
        .prepare("SELECT COUNT(*) AS n FROM steps WHERE experiment_id = ?")
        .get(experimentId) as Record<string, unknown>).n
    );
    const rows = this.db
      .prepare(
        "SELECT * FROM steps WHERE experiment_id = ? ORDER BY global_step LIMIT ? OFFSET ?"
      )
      .all(experimentId, limit, offset) as Record<string, unknown>[];
    return {
      total,
      steps: rows.map((row) => ({
        ...row,
        accepted: row.accepted === 1,
        neighbors: JSON.parse(row.neighbors_json as string)
      }))
    };
  }

  // 以已保存试验为起点做不落库的重放；温度变化通过 saveAs 成为新试验记录。
  replayFromSaved(input: {
    experimentId: number;
    temperature?: number;
    proposals: Proposal[];
  }): { result: ReplayResult; temperature: number; sourceGrid: Grid; saveAs: ExperimentRecord | null } {
    const exp = this.requireExperiment(input.experimentId);
    const temperature =
      input.temperature === undefined ? exp.temperature : validateTemperature(input.temperature);
    const sourceGrid = cloneGrid(exp.grid);
    const result = replay(sourceGrid, temperature, input.proposals);
    return { result, temperature, sourceGrid, saveAs: null };
  }

  saveReplayAsTrial(input: {
    sourceExperimentId: number;
    name?: string | null;
    temperature: number;
    result: ReplayResult;
  }): ExperimentRecord {
    this.requireExperiment(input.sourceExperimentId);
    const grid = input.result.grid;
    const created = this.createExperiment({
      name: input.name ?? null,
      grid,
      temperature: input.temperature
    });
    return created;
  }
}
