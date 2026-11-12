export type ErrorCode = 'not_found' | 'validation' | 'invalid_transition' | 'conflict' | 'ambiguous_target' | 'forbidden' | 'unavailable';
const STATUS: Record<ErrorCode, number> = {
  not_found: 404, validation: 400, invalid_transition: 422, conflict: 409, ambiguous_target: 422, forbidden: 403, unavailable: 503,
};
export class KanbanError extends Error {
  code: ErrorCode;
  details: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
  get httpStatus(): number { return STATUS[this.code]; }
  toJSON() { return { error: { code: this.code, message: this.message, details: this.details ?? null } }; }
}
