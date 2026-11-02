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
 * Only printable ASCII can travel in an HTTP header. Anything else — most often a line break
 * from a two-line paste — makes undici refuse the header with a message that quotes the whole value,
 * so it is refused here first, by name and without the value: it is the credential, or may be.
 */
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;

const UNPRINTABLE =
  'contains a character that cannot go in an HTTP header, such as a line break, a tab or a NUL, so it was not used ' +
  'and is not shown. Copy it again as a single line.';

/**
 * A header name is an RFC 9110 token. Anything else, such as the spaces of "X Api Key", makes undici
 * refuse the header with a message quoting it, and a name is sometimes a pasted value, so it is
 * refused here first, without the name.
 */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** How a printed endpoint reads: no user name, password, query or fragment, which may carry a credential. */
export const displayUrl = (url: URL): string => `${url.origin}${url.pathname}`;

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

  if (!PRINTABLE_ASCII.test(name)) {
    throw new ConfigError(`A --header name ${UNPRINTABLE}`);
  }

  if (!HEADER_NAME.test(name)) {
    throw new ConfigError(
      "A --header name must be an HTTP token: letters, digits and !#$%&'*+-.^_`|~, with no spaces or other " +
        'punctuation, such as X-Api-Key. It was not used and is not shown.'
    );
  }

  if (!PRINTABLE_ASCII.test(value)) {
    throw new ConfigError(`The value of --header "${name}" ${UNPRINTABLE}`);
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

  // A user name or password in the URL is a credential the bridge would print and undici would refuse
  // with a message quoting it. Neither part is echoed.
  if (url.username !== '' || url.password !== '') {
    throw new ConfigError(`${source} must not carry a user name or password; set the key in ${TOKEN_ENV_VAR} instead.`);
  }

  // The scheme is not echoed either: "alice:hunter2" parses as a URL whose scheme is the user name.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`${source} must be an http(s) URL.`);
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

/** Letters and dashes after one or two dashes: an option's name, which cannot be a credential. */
const OPTION_NAME = /^--?[A-Za-z][A-Za-z-]*$/;

const OPTIONS_WITH_A_VALUE: ReadonlySet<string> = new Set(['--url', '--header']);

/**
 * An argument this CLI does not know is never echoed whole. The likeliest ones are `--header=…` and
 * `--url=…`, whose values carry a credential, and the key itself pasted as an argument. Only an
 * option's name is shown, up to its "=", and anything else is named by its position.
 */
const unknownArgument = (argument: string, position: number): ConfigError => {
  const help = 'Run "growwer-mcp --help".';

  if (OPTION_NAME.test(argument)) {
    return new ConfigError(`Unknown option "${argument}". ${help}`);
  }

  const option = argument.slice(0, Math.max(argument.indexOf('='), 0));

  if (OPTION_NAME.test(option)) {
    return new ConfigError(
      OPTIONS_WITH_A_VALUE.has(option)
        ? `${option} takes its value as the next argument, not after "=", as in ${option} <value>. ` +
            'The value given was not used and is not shown.'
        : `Unknown option "${option}", and the value after its "=" is not shown. ${help}`
    );
  }

  return new ConfigError(
    `Argument ${position} is not one growwer-mcp knows, and is not shown, since it may be a credential. ${help}`
  );
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
        throw unknownArgument(argument, index + 1);
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
    if (!PRINTABLE_ASCII.test(envToken)) {
      throw new ConfigError(`${TOKEN_ENV_VAR} ${UNPRINTABLE}`);
    }

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
