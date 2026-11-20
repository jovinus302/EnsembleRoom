/** 도메인 오류. HTTP 상태와 안정적인 code를 가진다. app.ts의 오류 핸들러가 응답으로 바꾼다. */
export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
}

export const badRequest = (code: string, message?: string) => new DomainError(400, code, message);
export const unauthorized = (message = 'unauthorized') => new DomainError(401, 'unauthorized', message);
export const forbidden = (code: string, message?: string) => new DomainError(403, code, message);
export const notFound = (code: string, message?: string) => new DomainError(404, code, message);
export const conflict = (code: string, message?: string, data?: Record<string, unknown>) =>
  new DomainError(409, code, message, data);
