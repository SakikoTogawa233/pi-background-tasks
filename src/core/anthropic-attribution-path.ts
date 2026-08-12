import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the package-owned global Anthropic attribution extension.
 *
 * Package-owned child Pi processes disable ambient extension discovery, so they
 * must explicitly load this public extension entrypoint. Keeping path resolution
 * in one module prevents Fusion, delegation, and attested runs from deriving
 * different package paths.
 */
export function resolveAnthropicAttributionExtensionPath(
  moduleUrl = import.meta.url,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const modulePath = fileURLToPath(moduleUrl);
  const extension = modulePath.endsWith('.ts')
    ? 'anthropic-attribution.ts'
    : 'anthropic-attribution.js';
  const candidate = resolve(dirname(modulePath), '../../extensions', extension);
  if (!pathExists(candidate)) {
    throw new Error(`Anthropic attribution extension is missing: ${candidate}`);
  }
  return candidate;
}
