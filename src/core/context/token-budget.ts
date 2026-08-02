/**
 * Shared, dependency-free size arithmetic for prompt budgeting.
 *
 * Fusion and delegate both need to convert UTF-8 byte counts into a conservative
 * input-token upper bound and to subtract fixed reserves from a route's context
 * window. Only that arithmetic is shared. Fusion keeps its own stage forecaster
 * and delegate keeps its own admission/governor policy, because a single-shot
 * five-stage workflow and a multi-turn tool-using agent have genuinely different
 * budget shapes.
 *
 * The divisor is a deliberate ceiling rather than an estimate: across 159 real
 * large Fusion prompts the densest observed ratio was 3.552 bytes per input
 * token, so dividing by 2 keeps roughly a 1.7x margin and also bounds dense
 * non-ASCII input.
 */
export const BYTES_PER_TOKEN_DIVISOR = 2;

export function tokenUpperBound(utf8Bytes: number): number {
  return Math.ceil(utf8Bytes / BYTES_PER_TOKEN_DIVISOR);
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export interface RouteReserves {
  reservedOutputTokens: number;
  framingReserveTokens: number;
  safetyReserveTokens: number;
}

/**
 * Usable input tokens for one route.
 *
 * Returns a signed value. A caller that requires a minimum must check it and
 * fail loudly; this helper never clamps, never substitutes a default window, and
 * never silently returns zero for an unusable route.
 */
export function allowedInputTokens(contextWindowTokens: number, reserves: RouteReserves): number {
  return (
    contextWindowTokens -
    reserves.reservedOutputTokens -
    reserves.framingReserveTokens -
    reserves.safetyReserveTokens
  );
}

/** True only for a positive, finite, integral context window. */
export function isUsableContextWindow(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value > 0;
}
