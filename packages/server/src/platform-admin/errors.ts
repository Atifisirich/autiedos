/** Errors of the platform admin console. `code` is a stable machine string; the web maps it to an i18n key. */
export class AdminError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(code);
  }
}

export const forbidden = (code = 'forbidden') => new AdminError(403, code);
export const unauthorized = (code = 'unauthorized') => new AdminError(401, code);
export const notFound = (code = 'not_found') => new AdminError(404, code);
export const conflict = (code: string, details?: unknown) => new AdminError(409, code, details);
export const invalid = (code: string, details?: unknown) => new AdminError(422, code, details);

/** Maps a Postgres error code to an HTTP error the console understands. */
export function fromPg(e: { code?: string; message?: string; constraint?: string }): AdminError | null {
  switch (e.code) {
    case '42501':
      return forbidden();
    case '23505':
      return conflict(e.constraint === 'org_users_one_org_per_user' ? 'user_already_in_client' : 'duplicate', { constraint: e.constraint });
    case '23503':
      return invalid('invalid_reference', { constraint: e.constraint });
    case '23514':
    case '22P02':
    case '22023':
      return invalid('invalid_value', { message: e.message, constraint: e.constraint });
    default:
      return null;
  }
}
