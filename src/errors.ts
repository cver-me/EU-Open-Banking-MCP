export class PublicError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "PublicError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof PublicError) return error.message;
  return "The financial data provider could not complete this request.";
}
