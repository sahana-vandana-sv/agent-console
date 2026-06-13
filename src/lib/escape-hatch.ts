// The ONLY file where `any` is permitted.
// Every use must be documented with a rationale comment.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unsafeJsonParse(raw: string): any {
  // Rationale: WebSocket message payloads are untyped at the boundary;
  // callers must narrow via ServerMessage discriminated union before use.
  return JSON.parse(raw);
}
