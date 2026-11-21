/** Error from a non-2xx response. `code` is the backend's machine-readable reason
 *  where it gives one (internal/api/expect.go) — branch on it, not the message. */
export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export const apiErrorCode = (e: unknown): string | undefined => e instanceof ApiError ? e.code : undefined
