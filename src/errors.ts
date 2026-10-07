export type ErrorCode =
  | "INVALID_JSON"
  | "INVALID_GRID"
  | "INVALID_DIMENSIONS"
  | "INVALID_SPIN"
  | "INVALID_TEMPERATURE"
  | "INVALID_PROPOSAL"
  | "INVALID_U"
  | "OUT_OF_BOUNDS"
  | "INVALID_PAGINATION"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "REQUEST_ID_REPLAY"
  | "METHOD_NOT_ALLOWED"
  | "BAD_REQUEST";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function errorBody(code: ErrorCode, message: string, details?: unknown) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}
