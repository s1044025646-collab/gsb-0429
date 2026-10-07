import { AppError } from "./errors.js";

export type Spin = 1 | -1;
export type Grid = Spin[][];

export interface ProposalInput {
  row: number;
  col: number;
  u: number;
}

export interface Proposal extends ProposalInput {
  seq: number;
}

export interface StepResult {
  id: number;
  seq: number;
  row: number;
  col: number;
  u: number;
  neighbors: { up: Spin; down: Spin; left: Spin; right: Spin };
  neighborSum: number;
  deltaE: number;
  acceptProbability: number | null;
  accepted: boolean;
  energyBefore: number;
  energyAfter: number;
  magnetizationBefore: number;
  magnetizationAfter: number;
}

export interface ReplayResult {
  grid: Grid;
  energy: number;
  magnetization: number;
  steps: StepResult[];
  acceptedCount: number;
  rejectedCount: number;
}

export const MIN_SIDE = 3;
export const MAX_SIDE = 32;

export function validateDimensions(rows: unknown, cols: unknown): { rows: number; cols: number } {
  if (!Number.isInteger(rows) || !Number.isInteger(cols)) {
    throw new AppError("INVALID_DIMENSIONS", "rows 与 cols 必须为整数");
  }
  const r = rows as number;
  const c = cols as number;
  if (r < MIN_SIDE || r > MAX_SIDE || c < MIN_SIDE || c > MAX_SIDE) {
    throw new AppError(
      "INVALID_DIMENSIONS",
      `rows 与 cols 必须位于 [${MIN_SIDE}, ${MAX_SIDE}]（含端点），收到 ${r} x ${c}`
    );
  }
  return { rows: r, cols: c };
}

export function validateTemperature(temperature: unknown): number {
  if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0) {
    throw new AppError(
      "INVALID_TEMPERATURE",
      "temperature 必须为不小于 0 的有限数值（负温不允许）"
    );
  }
  return temperature;
}

export function validateGrid(input: unknown): Grid {
  if (!Array.isArray(input) || input.length === 0) {
    throw new AppError("INVALID_GRID", "grid 必须为非空二维数组");
  }
  const rows = input.length;
  if (!Array.isArray(input[0])) {
    throw new AppError("INVALID_GRID", "grid 必须为二维数组");
  }
  const cols = (input[0] as unknown[]).length;
  validateDimensions(rows, cols);

  const grid: Grid = [];
  for (let r = 0; r < rows; r++) {
    const line = (input as unknown[])[r];
    if (!Array.isArray(line) || line.length !== cols) {
      throw new AppError("INVALID_GRID", `第 ${r} 行长度与首行不一致或不是数组`);
    }
    const outRow: Spin[] = [];
    for (let c = 0; c < cols; c++) {
      const v = (line as unknown[])[c];
      if (v !== 1 && v !== -1) {
        throw new AppError(
          "INVALID_SPIN",
          `位置 (${r}, ${c}) 的自旋必须严格为 1 或 -1，收到 ${String(v)}`
        );
      }
      outRow.push(v);
    }
    grid.push(outRow);
  }
  return grid;
}

export function validateU(u: unknown, seq: number): number {
  if (typeof u !== "number" || !Number.isFinite(u)) {
    throw new AppError("INVALID_U", `提议 seq=${seq} 的 u 必须为有限数值`);
  }
  if (u < 0 || u >= 1) {
    throw new AppError("INVALID_U", `提议 seq=${seq} 的 u 必须满足 0 <= u < 1，收到 ${u}`);
  }
  return u;
}

export function validateProposal(
  raw: unknown,
  seq: number,
  rows: number,
  cols: number
): Proposal {
  if (typeof raw !== "object" || raw === null) {
    throw new AppError("INVALID_PROPOSAL", `提议 seq=${seq} 必须为对象`);
  }
  const p = raw as Record<string, unknown>;
  const { row, col } = p;
  if (!Number.isInteger(row) || !Number.isInteger(col)) {
    throw new AppError("INVALID_PROPOSAL", `提议 seq=${seq} 的 row、col 必须为整数`);
  }
  const r = row as number;
  const c = col as number;
  if (r < 0 || r >= rows || c < 0 || c >= cols) {
    throw new AppError(
      "OUT_OF_BOUNDS",
      `提议 seq=${seq} 位置 (${r}, ${c}) 越界，网格为 ${rows} x ${cols}`
    );
  }
  const u = validateU(p.u, seq);
  return { seq, row: r, col: c, u };
}

export function validateProposalBatch(raw: unknown, rows: number, cols: number): Proposal[] {
  if (!Array.isArray(raw)) {
    throw new AppError("INVALID_PROPOSAL", "proposals 必须为数组");
  }
  return raw.map((p, i) => validateProposal(p, i, rows, cols));
}

export function cloneGrid(grid: Grid): Grid {
  return grid.map((row) => row.slice());
}

export function neighborsOf(grid: Grid, row: number, col: number) {
  const rows = grid.length;
  const cols = grid[0]!.length;
  const up = grid[(row - 1 + rows) % rows]![col]!;
  const down = grid[(row + 1) % rows]![col]!;
  const left = grid[row]![(col - 1 + cols) % cols]!;
  const right = grid[row]![(col + 1) % cols]!;
  return { up, down, left, right };
}

export function neighborSumAt(grid: Grid, row: number, col: number): number {
  const n = neighborsOf(grid, row, col);
  return n.up + n.down + n.left + n.right;
}

export function deltaEnergyAt(grid: Grid, row: number, col: number): number {
  const spin = grid[row]![col]!;
  return 2 * spin * neighborSumAt(grid, row, col);
}

export function acceptProbability(deltaE: number, temperature: number): number | null {
  if (deltaE <= 0) return 1;
  if (temperature === 0) return 0;
  return Math.exp(-deltaE / temperature);
}

export function isAccepted(deltaE: number, temperature: number, u: number): boolean {
  if (deltaE <= 0) return true;
  if (temperature === 0) return false;
  return u < Math.exp(-deltaE / temperature);
}

// 独立全量重算：每格只计右邻、下邻，键不重复。
export function totalEnergy(grid: Grid): number {
  const rows = grid.length;
  const cols = grid[0]!.length;
  let energy = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const spin = grid[r]![c]!;
      const right = grid[r]![(c + 1) % cols]!;
      const down = grid[(r + 1) % rows]![c]!;
      energy -= spin * right;
      energy -= spin * down;
    }
  }
  return energy;
}

export function magnetization(grid: Grid): number {
  let m = 0;
  for (const row of grid) {
    for (const spin of row) {
      m += spin;
    }
  }
  return m;
}

export function replay(
  initialGrid: Grid,
  temperature: number,
  proposals: ProposalInput[]
): ReplayResult {
  validateTemperature(temperature);
  const grid = cloneGrid(initialGrid);
  let energy = totalEnergy(grid);
  let mag = magnetization(grid);
  const steps: StepResult[] = [];
  let acceptedCount = 0;
  let rejectedCount = 0;

  proposals.forEach((raw, i) => {
    const p = validateProposal(raw, i, grid.length, grid[0]!.length);
    const { row, col, u } = p;
    const energyBefore = energy;
    const magnetizationBefore = mag;
    const neighbors = neighborsOf(grid, row, col);
    const neighborSum = neighbors.up + neighbors.down + neighbors.left + neighbors.right;
    const spin = grid[row]![col]!;
    const deltaE = 2 * spin * neighborSum;
    const probability = acceptProbability(deltaE, temperature);
    const accepted = isAccepted(deltaE, temperature, u);

    if (accepted) {
      grid[row]![col] = (spin * -1) as Spin;
      energy += deltaE;
      mag -= 2 * spin;
      acceptedCount++;
    } else {
      rejectedCount++;
    }

    steps.push({
      id: i,
      seq: i,
      row,
      col,
      u,
      neighbors,
      neighborSum,
      deltaE,
      acceptProbability: probability,
      accepted,
      energyBefore,
      energyAfter: energy,
      magnetizationBefore,
      magnetizationAfter: mag
    });
  });

  return { grid, energy, magnetization: mag, steps, acceptedCount, rejectedCount };
}

export function verifyState(
  grid: Grid,
  recordedEnergy: number,
  recordedMagnetization: number
) {
  const recomputedEnergy = totalEnergy(grid);
  const recomputedMagnetization = magnetization(grid);
  const ok =
    recomputedEnergy === recordedEnergy && recomputedMagnetization === recordedMagnetization;
  return {
    ok,
    recordedEnergy,
    recomputedEnergy,
    energyDifference: recomputedEnergy - recordedEnergy,
    recordedMagnetization: recordedMagnetization,
    recomputedMagnetization,
    magnetizationDifference: recomputedMagnetization - recordedMagnetization
  };
}

export function allPlusGrid(rows: number, cols: number): Grid {
  validateDimensions(rows, cols);
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => 1 as Spin));
}
