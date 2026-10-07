import { invalid } from "./errors.js";

export type Spin = 1 | -1;
export type Grid = Spin[][];

export interface Proposal {
  id: string;
  row: number;
  col: number;
  u: number;
}

export interface ProposalResult extends Proposal {
  index: number;
  beforeVersion: number;
  afterVersion: number;
  neighbors: { up: Spin; down: Spin; left: Spin; right: Spin; sum: number };
  energyBefore: number;
  magnetizationBefore: number;
  deltaEnergy: number;
  acceptanceProbability: number;
  accepted: boolean;
  rejectReason: "accepted" | "positive_delta_zero_temperature" | "random_compare_rejected";
  energyAfter: number;
  magnetizationAfter: number;
  spinBefore: Spin;
  spinAfter: Spin;
}

export interface BatchInput {
  temperature: number;
  expectedVersion: number;
  proposals: Proposal[];
}

export interface BatchSimulation {
  startGrid: Grid;
  finalGrid: Grid;
  startEnergy: number;
  finalEnergy: number;
  startMagnetization: number;
  finalMagnetization: number;
  startVersion: number;
  finalVersion: number;
  results: ProposalResult[];
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isSpin(value: unknown): value is Spin {
  return value === 1 || value === -1;
}

export function assertGrid(input: unknown): asserts input is Grid {
  if (!Array.isArray(input)) throw invalid("grid 必须是二维数组");
  if (input.length < 3 || input.length > 32) {
    throw invalid("行数必须在 3 到 32 之间", { rows: input.length });
  }
  const rows = input.length;
  for (let row = 0; row < rows; row += 1) {
    const line = input[row];
    if (!Array.isArray(line) || line.length !== rows) {
      throw invalid(`第 ${row} 行不是长度 ${rows} 的数组`);
    }
    for (let col = 0; col < rows; col += 1) {
      if (!isSpin(line?.[col])) throw invalid(`格子 (${row}, ${col}) 只能是 1 或 -1`);
    }
  }
}

export function validateTemperature(value: unknown): number {
  if (!isFiniteNumber(value) || value < 0) {
    throw invalid("temperature 必须是大于等于 0 的有限数值", { temperature: value });
  }
  return value;
}

export function validateExpectedVersion(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw invalid("expectedVersion 必须是非负整数", { expectedVersion: value });
  }
  return value as number;
}

export function validateProposals(input: unknown, size: number): Proposal[] {
  if (!Array.isArray(input) || input.length === 0) throw invalid("proposals 必须是非空数组");
  const seen = new Set<string>();
  return input.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) throw invalid(`第 ${index} 条提议必须是对象`);
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id.trim().length === 0) {
      throw invalid(`第 ${index} 条提议缺少稳定字符串 id`);
    }
    const id = item.id;
    if (seen.has(id)) throw invalid(`提议 id 重复: ${id}`, { id, index });
    seen.add(id);
    if (!Number.isInteger(item.row) || !Number.isInteger(item.col)) {
      throw invalid(`提议 ${id} 的 row 和 col 必须是整数`);
    }
    const row = item.row as number;
    const col = item.col as number;
    if (row < 0 || row >= size || col < 0 || col >= size) {
      throw invalid(`提议 ${id} 的行列越界`, { row, col, size });
    }
    if (!isFiniteNumber(item.u) || item.u < 0 || item.u >= 1) {
      throw invalid(`提议 ${id} 的 u 必须满足 0 <= u < 1`, { u: item.u });
    }
    return { id, row, col, u: item.u as number };
  });
}

export function cloneGrid(grid: Grid): Grid {
  return grid.map((line) => line.slice() as Spin[]);
}

export function neighborCoordinates(size: number, row: number, col: number) {
  return {
    up: { row: (row - 1 + size) % size, col },
    down: { row: (row + 1) % size, col },
    left: { row, col: (col - 1 + size) % size },
    right: { row, col: (col + 1) % size },
  };
}

export function totalEnergy(grid: Grid): number {
  const size = grid.length;
  let energy = 0;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const spin = grid[row]![col]!;
      energy -= spin * grid[row]![(col + 1) % size]!;
      energy -= spin * grid[(row + 1) % size]![col]!;
    }
  }
  return energy;
}

export function magnetization(grid: Grid): number {
  let total = 0;
  for (const line of grid) for (const spin of line) total += spin;
  return total;
}

export function acceptanceProbability(deltaEnergy: number, temperature: number): number {
  if (deltaEnergy <= 0) return 1;
  if (temperature === 0) return 0;
  return Math.exp(-deltaEnergy / temperature);
}

export function shouldAccept(deltaEnergy: number, temperature: number, u: number): boolean {
  if (deltaEnergy <= 0) return true;
  if (temperature === 0) return false;
  return u < Math.exp(-deltaEnergy / temperature);
}

export function simulateBatch(input: BatchInput, initialGrid: Grid, initialVersion: number): BatchSimulation {
  const grid = cloneGrid(initialGrid);
  let energy = totalEnergy(grid);
  let magnet = magnetization(grid);
  const results: ProposalResult[] = [];

  input.proposals.forEach((proposal, index) => {
    const energyBefore = energy;
    const magnetizationBefore = magnet;
    const spinBefore = grid[proposal.row]![proposal.col]!;
    const coordinates = neighborCoordinates(grid.length, proposal.row, proposal.col);
    const up = grid[coordinates.up.row]![coordinates.up.col]!;
    const down = grid[coordinates.down.row]![coordinates.down.col]!;
    const left = grid[coordinates.left.row]![coordinates.left.col]!;
    const right = grid[coordinates.right.row]![coordinates.right.col]!;
    const sum = up + down + left + right;
    const deltaEnergy = 2 * spinBefore * sum;
    const probability = acceptanceProbability(deltaEnergy, input.temperature);
    const accepted = shouldAccept(deltaEnergy, input.temperature, proposal.u);
    const rejectReason: ProposalResult["rejectReason"] = accepted
      ? "accepted"
      : deltaEnergy > 0 && input.temperature === 0
        ? "positive_delta_zero_temperature"
        : "random_compare_rejected";

    if (accepted) {
      grid[proposal.row]![proposal.col] = spinBefore === 1 ? -1 : 1;
      energy += deltaEnergy;
      magnet -= 2 * spinBefore;
    }
    const spinAfter = grid[proposal.row]![proposal.col]!;
    results.push({
      ...proposal,
      index,
      beforeVersion: initialVersion + index,
      afterVersion: initialVersion + index + 1,
      neighbors: { up, down, left, right, sum },
      energyBefore,
      magnetizationBefore,
      deltaEnergy,
      acceptanceProbability: probability,
      accepted,
      rejectReason,
      energyAfter: energy,
      magnetizationAfter: magnet,
      spinBefore,
      spinAfter,
    });
  });

  return {
    startGrid: cloneGrid(initialGrid),
    finalGrid: grid,
    startEnergy: totalEnergy(initialGrid),
    finalEnergy: energy,
    startMagnetization: magnetization(initialGrid),
    finalMagnetization: magnet,
    startVersion: initialVersion,
    finalVersion: initialVersion + input.proposals.length,
    results,
  };
}

export function inspectStep(grid: Grid, row: number, col: number, temperature: number) {
  const spin = grid[row]![col]!;
  const coordinates = neighborCoordinates(grid.length, row, col);
  const up = grid[coordinates.up.row]![coordinates.up.col]!;
  const down = grid[coordinates.down.row]![coordinates.down.col]!;
  const left = grid[coordinates.left.row]![coordinates.left.col]!;
  const right = grid[coordinates.right.row]![coordinates.right.col]!;
  const sum = up + down + left + right;
  const deltaEnergy = 2 * spin * sum;
  return {
    coordinates,
    spin,
    neighbors: { up, down, left, right, sum },
    deltaEnergy,
    acceptanceProbability: acceptanceProbability(deltaEnergy, temperature),
    rule:
      deltaEnergy <= 0
        ? "deltaEnergy <= 0: always accept"
        : temperature === 0
          ? "deltaEnergy > 0 and T = 0: reject"
          : "u < exp(-deltaEnergy / temperature)",
  };
}
