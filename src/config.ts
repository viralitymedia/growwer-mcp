export const DEFAULT_MCP_URL = 'https://tool.growwer.com/mcp';

export const TOKEN_MARKER = 'gw_sk_';

/**
 * A Growwer API key: the marker, then 43 base64url characters, of which the first 12 are the public
 * prefix Growwer looks the key up by.
 */
export const TOKEN_FORMAT = /^gw_sk_[A-Za-z0-9_-]{43}$/;

export const PUBLIC_PREFIX_LENGTH = 18;

export const BUYER_KEYS_URL = 'https://tool.growwer.com/user/buyer/api-keys';

export const SELLER_KEYS_URL = 'https://tool.growwer.com/user/seller/api-keys';

export const TOKEN_ENV_VAR = 'GROWWER_API_KEY';

export const URL_ENV_VAR = 'GROWWER_MCP_URL';

export type Command = 'serve' | 'doctor' | 'help' | 'version';

export interface Config {
  readonly command: Command;
  readonly url: URL;
  /** Absent when no credential was supplied; the CLI then runs in setup mode. */
  readonly token: string | undefined;
  /** Extra headers from `--header`, already merged with the bearer credential. */
  readonly headers: Readonly<Record<string, string>>;
  /** Non-fatal problems worth telling the user about on stderr. */
  readonly warnings: readonly string[];
}

export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Never echo the argument back. The value of a `--header` is routinely the
 * credential itself, and the likeliest way to reach this error is omitting the
 * colon — so quoting what was passed would print the token into the terminal and
 * into whatever captures the host's stderr.
 */
const parseHeader = (raw: string): readonly [string, string] => {
  const separator = raw.indexOf(':');

  if (separator <= 0) {
    throw new ConfigError('--header expects "Name: value" — the value is missing its ":" separator.');
  }

  const name = raw.slice(0, separator).trim();
  const value = raw.slice(separator + 1).trim();

  if (name === '' || value === '') {
    throw new ConfigError('--header expects "Name: value" — the name or the value is empty.');
  }

  return [name, value];
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const isLoopback = (url: URL): boolean => LOOPBACK_HOSTS.has(url.hostname) || url.hostname.endsWith('.localhost');

const parseUrl = (raw: string, source: string): URL => {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    // The raw value is not echoed: an endpoint string is an occasional place to
    // find a credential, and it is untrusted input either way.
    throw new ConfigError(`${source} is not a valid URL.`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`${source} must be an http(s) URL, got the "${url.protocol}" scheme.`);
  }

  // A bearer token over plaintext is readable by anything on the path. Loopback
  // stays allowed so a local Growwer instance can be pointed at during development.
  if (url.protocol === 'http:' && !isLoopback(url)) {
    throw new ConfigError(
      `${source} must use https for a non-loopback host; "${url.host}" over http would send the credential in cleartext.`
    );
  }

  return url;
};

/**
 * A credential may arrive as the bare token or as a full `Bearer …` header
 * value, because several MCP hosts ask the user for "the authorization header"
 * rather than for the token. Normalise to the bare token.
 */
const normaliseToken = (raw: string): string => {
  const trimmed = raw.trim();

  return trimmed.toLowerCase().startsWith('bearer ') ? trimmed.slice('bearer '.length).trim() : trimmed;
};

export const parseArgs = (argv: readonly string[], env: NodeJS.ProcessEnv): Config => {
  const warnings: string[] = [];
  const headers: Record<string, string> = {};

  let command: Command = 'serve';
  let urlValue = env[URL_ENV_VAR]?.trim() ?? '';
  let urlSource = `${URL_ENV_VAR} environment variable`;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;

    switch (argument) {
      case 'doctor':
        command = 'doctor';
        break;
      case 'serve':
        command = 'serve';
        break;
      case '-h':
      case '--help':
        return { command: 'help', url: new URL(DEFAULT_MCP_URL), token: undefined, headers: {}, warnings: [] };
      case '-v':
      case '--version':
        return { command: 'version', url: new URL(DEFAULT_MCP_URL), token: undefined, headers: {}, warnings: [] };
      case '--url': {
        index += 1;
        const value = argv[index];

        if (value === undefined) {
          throw new ConfigError('--url expects a value.');
        }

        urlValue = value;
        urlSource = '--url';
        break;
      }
      case '--header': {
        index += 1;
        const value = argv[index];

        if (value === undefined) {
          throw new ConfigError('--header expects a value.');
        }

        const [name, headerValue] = parseHeader(value);
        headers[name] = headerValue;
        break;
      }
      default:
        throw new ConfigError(`Unknown argument "${argument}". Run "growwer-mcp --help".`);
    }
  }

  const url = urlValue === '' ? new URL(DEFAULT_MCP_URL) : parseUrl(urlValue, urlSource);

  const explicitAuthorization = Object.keys(headers).find((name) => name.toLowerCase() === 'authorization');
  const envToken = env[TOKEN_ENV_VAR]?.trim() ?? '';

  let token: string | undefined;

  if (explicitAuthorization !== undefined) {
    token = normaliseToken(headers[explicitAuthorization] as string);
    delete headers[explicitAuthorization];

    if (envToken !== '') {
      warnings.push(`Both ${TOKEN_ENV_VAR} and an Authorization --header were given; the header wins.`);
    }
  } else if (envToken !== '') {
    token = normaliseToken(envToken);
  }

  if (token === '') {
    token = undefined;
  }

  if (token !== undefined && !token.startsWith(TOKEN_MARKER)) {
    warnings.push(`The credential does not look like a Growwer API key (expected a "${TOKEN_MARKER}…" value).`);
  }

  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`;

    // Pointing the bridge elsewhere is legitimate — staging, a local instance —
    // but it hands the credential to that host, so say so rather than doing it
    // silently. Config for MCP clients gets copied between machines and blog posts.
    if (url.origin !== new URL(DEFAULT_MCP_URL).origin) {
      warnings.push(`Sending the credential to ${url.origin}, which is not the default ${new URL(DEFAULT_MCP_URL).origin}.`);
    }
  }

  return { command, url, token, headers, warnings };
};
