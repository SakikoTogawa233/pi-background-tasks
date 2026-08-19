import { join } from 'node:path';

const POSIX_PROCESS_KEYS = ['PATH', 'TMPDIR', 'TEMP', 'TMP'] as const;
const WINDOWS_PROCESS_KEYS = [
  'PATH',
  'ComSpec',
  'SystemRoot',
  'WINDIR',
  'PATHEXT',
  'TEMP',
  'TMP',
] as const;

function environmentValue(
  source: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return source[key];
  const sourceKey = Object.keys(source).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return sourceKey === undefined ? undefined : source[sourceKey];
}

/**
 * Keep only the host process variables required to start npm lifecycle
 * commands, then isolate every npm location that can carry user state.
 */
export function isolatedNpmEnvironment(
  rootDir: string,
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  const keys = platform === 'win32' ? WINDOWS_PROCESS_KEYS : POSIX_PROCESS_KEYS;
  for (const key of keys) {
    const value = environmentValue(source, key, platform);
    if (value !== undefined) inherited[key] = value;
  }

  return {
    ...inherited,
    HOME: join(rootDir, 'home'),
    USERPROFILE: join(rootDir, 'home'),
    XDG_CONFIG_HOME: join(rootDir, 'config'),
    NPM_CONFIG_CACHE: join(rootDir, 'cache'),
    NPM_CONFIG_USERCONFIG: join(rootDir, 'npmrc'),
    NPM_CONFIG_REGISTRY: 'http://127.0.0.1.invalid/',
    npm_config_cache: join(rootDir, 'cache'),
    npm_config_userconfig: join(rootDir, 'npmrc'),
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    CI: '1',
  };
}
