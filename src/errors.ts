export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function invalid(message: string, details?: unknown): AppError {
  return new AppError("INVALID_ARGUMENT", message, 400, details);
}

export function notFound(message: string, details?: unknown): AppError {
  return new AppError("NOT_FOUND", message, 404, details);
}

export function conflict(message: string, details?: unknown): AppError {
  return new AppError("CONFLICT", message, 409, details);
}
