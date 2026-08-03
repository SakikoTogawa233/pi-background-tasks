import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { canonicalJson } from '../attested-pi-run.js';
import { isJsonObject, parseJsonText } from '../common.js';
import {
  FUSION_SOURCE_POLICY_SCHEMA_VERSION,
  FusionError,
  type FusionDeclaredSourceV1,
  type FusionSourcePolicyV1,
} from './types.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isPrivateIp(host: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4 !== null) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a = 0, b = 0] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return false;
}

export function canonicalizeFusionPublicUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new FusionError(
      `fusion research declared source URL is malformed: ${error instanceof Error ? error.message : String(error)}`,
      { code: 'orchestration_failed', childCreated: false },
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new FusionError('fusion research source URL must not contain credentials', {
      code: 'orchestration_failed',
      childCreated: false,
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FusionError('fusion research source URL must use http or https', {
      code: 'orchestration_failed',
      childCreated: false,
    });
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || isPrivateIp(url.hostname)) {
    throw new FusionError('fusion research source URL must be public, not localhost/private', {
      code: 'orchestration_failed',
      childCreated: false,
    });
  }
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  if (url.pathname === '') url.pathname = '/';
  return url.toString();
}

export interface DeclaredFusionSourceInput {
  url: string;
  purpose: string;
}

export function normalizeFusionDeclaredSources(
  sources: readonly DeclaredFusionSourceInput[] = [],
): readonly FusionDeclaredSourceV1[] {
  return sources.map((source, index) => {
    if (typeof source.purpose !== 'string' || source.purpose.trim().length === 0) {
      throw new FusionError(`fusion research source ${String(index)} requires non-blank purpose`, {
        code: 'orchestration_failed',
        childCreated: false,
      });
    }
    const canonicalUrl = canonicalizeFusionPublicUrl(source.url);
    return {
      url: source.url,
      canonical_url: canonicalUrl,
      purpose: source.purpose,
      sha256: sha256Text(`${canonicalUrl}\u0000${source.purpose}`),
    };
  });
}

export function buildFusionSourcePolicy(
  cwd: string,
  sources: readonly FusionDeclaredSourceV1[],
): FusionSourcePolicyV1 {
  const body = {
    schema_version: FUSION_SOURCE_POLICY_SCHEMA_VERSION,
    workflow: 'research' as const,
    cwd,
    sources,
  } as const;
  return { ...body, root_sha256: sha256Text(canonicalJson(body)) };
}

export function sourcePolicyCanonicalBytes(policy: FusionSourcePolicyV1): string {
  return canonicalJson(policy);
}

function requireString(record: Record<PropertyKey, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}.${key} must be non-blank string`);
  return value;
}

export function parseFusionSourcePolicy(value: unknown): FusionSourcePolicyV1 {
  if (!isJsonObject(value) || Array.isArray(value)) throw new Error('fusion source policy must be object');
  const keys = Object.keys(value).sort();
  const expected = ['cwd', 'root_sha256', 'schema_version', 'sources', 'workflow'];
  if (keys.join('\0') !== expected.join('\0')) throw new Error('fusion source policy keys mismatch');
  if (value['schema_version'] !== FUSION_SOURCE_POLICY_SCHEMA_VERSION) throw new Error('fusion source policy schema_version mismatch');
  if (value['workflow'] !== 'research') throw new Error('fusion source policy workflow must be research');
  const cwd = requireString(value, 'cwd', 'fusion source policy');
  const rootSha256 = requireString(value, 'root_sha256', 'fusion source policy');
  if (!SHA256_HEX.test(rootSha256)) throw new Error('fusion source policy.root_sha256 must be sha256');
  if (!Array.isArray(value['sources'])) throw new Error('fusion source policy.sources must be array');
  const sources = value['sources'].map((item, index): FusionDeclaredSourceV1 => {
    const label = `fusion source policy.sources[${String(index)}]`;
    if (!isJsonObject(item) || Array.isArray(item)) throw new Error(`${label} must be object`);
    const itemKeys = Object.keys(item).sort();
    const itemExpected = ['canonical_url', 'purpose', 'sha256', 'url'];
    if (itemKeys.join('\0') !== itemExpected.join('\0')) throw new Error(`${label} keys mismatch`);
    const url = requireString(item, 'url', label);
    const purpose = requireString(item, 'purpose', label);
    const canonical_url = requireString(item, 'canonical_url', label);
    const sha256 = requireString(item, 'sha256', label);
    if (!SHA256_HEX.test(sha256)) throw new Error(`${label}.sha256 must be sha256`);
    if (canonicalizeFusionPublicUrl(url) !== canonical_url) throw new Error(`${label}.canonical_url mismatch`);
    if (sha256Text(`${canonical_url}\u0000${purpose}`) !== sha256) throw new Error(`${label}.sha256 mismatch`);
    return { url, canonical_url, purpose, sha256 };
  });
  const body = { schema_version: FUSION_SOURCE_POLICY_SCHEMA_VERSION, workflow: 'research' as const, cwd, sources } as const;
  if (sha256Text(canonicalJson(body)) !== rootSha256) throw new Error('fusion source policy root_sha256 mismatch');
  return { ...body, root_sha256: rootSha256 };
}

export async function readFusionSourcePolicyFile(path: string, expectedSha256: string): Promise<FusionSourcePolicyV1> {
  if (!SHA256_HEX.test(expectedSha256)) throw new Error('fusion source policy expected hash is malformed');
  const stats = await lstat(path);
  if (!stats.isFile()) throw new Error(`fusion source policy at ${path} is not a regular file`);
  const bytes = await readFile(path);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha256) throw new Error('fusion source policy artifact hash mismatch');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('fusion source policy is not UTF-8');
  return parseFusionSourcePolicy(parseJsonText(text));
}
