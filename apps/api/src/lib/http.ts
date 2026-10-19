export class HttpError extends Error {
  constructor(public status: number, message: string, public code = "error") {
    super(message);
  }
}

export const notFound = (what = "Resource") => new HttpError(404, `${what} not found`, "not_found");
export const forbidden = () => new HttpError(403, "You do not have permission for this action", "forbidden");
export const conflict = (msg: string) => new HttpError(409, msg, "conflict");
