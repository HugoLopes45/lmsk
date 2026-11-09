/** An error whose `code` is the only part that may be reported; the message may hold details. */
export class CodedError<C extends string = string> extends Error {
  readonly code: C;

  constructor(code: C, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.code = code;
  }
}

export function errorCode(error: unknown): string {
  return error instanceof CodedError ? error.code : "UNEXPECTED_ERROR";
}
