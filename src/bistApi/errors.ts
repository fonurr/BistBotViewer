export type BistErrorKind = 'refused' | 'unknown' | 'unavailable' | 'protocol';

export class BistApiError extends Error {
  readonly kind: BistErrorKind;
  readonly type: string;
  readonly status: number | null;
  readonly mayHaveReachedExchange: boolean;
  readonly queued: boolean;
  readonly retryAt: number | null;
  readonly attemptsLeft: number | null;

  constructor(options: {
    message: string;
    kind: BistErrorKind;
    type?: string;
    status?: number | null;
    mayHaveReachedExchange?: boolean;
    queued?: boolean;
    retryAt?: number | null;
    attemptsLeft?: number | null;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = 'BistApiError';
    this.kind = options.kind;
    this.type = options.type ?? 'Unspecified';
    this.status = options.status ?? null;
    this.mayHaveReachedExchange = options.mayHaveReachedExchange ?? false;
    this.queued = options.queued ?? false;
    this.retryAt = options.retryAt ?? null;
    this.attemptsLeft = options.attemptsLeft ?? null;
  }
}

export function asBistApiError(error: unknown): BistApiError {
  if (error instanceof BistApiError) return error;
  return new BistApiError({
    message:
      error instanceof Error ? error.message : 'The request failed without a readable reply.',
    kind: 'protocol',
    cause: error,
  });
}
