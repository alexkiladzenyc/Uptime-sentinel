import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const message = result.error.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    throw new ApiError(400, message);
  }
  return result.data;
}

export function parseId(params: unknown): number {
  const id = Number((params as { id?: string }).id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(400, 'invalid id');
  return id;
}
