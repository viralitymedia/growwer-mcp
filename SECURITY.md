# Security

## Reporting a vulnerability

Email **support@growwer.com** with a description, the steps to reproduce, and
the impact you believe it has. Please do not open a public issue for anything
exploitable.

## Scope

This repository holds the public stdio bridge and the published metadata for the
hosted Growwer MCP server. Reports about the hosted service are welcome at the
same address.

Growwer does not run a public bug-bounty or penetration-testing programme, and
nothing here authorises testing against the production service. If you find
something while using your own account in the normal course of things, please
tell us. Please do not run automated scanners against `tool.growwer.com`, and
never access, modify or exfiltrate data belonging to another account: use your
own account and your own data.

## What this package does with your key

* The key is read from the `GROWWER_API_KEY` environment variable (or an
  `--header` argument) and sent to the configured endpoint as
  `Authorization: Bearer <key>`. It is never written to disk, never logged, and
  never sent anywhere else. Without a key, the bridge reads the public catalogue
  anonymously and sends no credential at all.
* `growwer-mcp doctor` prints at most the first 18 characters of a Growwer key:
  the `gw_sk_` marker and the public prefix Growwer uses for lookup, not the
  secret. A credential in any other format prints nothing.
* Errors from the upstream reach the host and stderr as a status or a cause.
  The bridge does not repeat the body of an upstream error.
* The default endpoint is `https://tool.growwer.com/mcp`. `--url` /
  `GROWWER_MCP_URL` override it; anything you point at receives the key, so only
  point it at a Growwer environment you trust. Overriding it to a host other
  than the default prints a warning on stderr, and a plaintext `http://` endpoint
  is refused outright unless it is loopback.

Prefer the environment variable over `--header`: process arguments are visible
to other users on the machine through `ps`, environment variables of a running
process are not.

## Key properties

Growwer API keys (`gw_sk_…`) carry the permissions chosen when they were created,
read or read and write, and never act beyond the owner's account. They can be
revoked at any time from the API keys page of your Growwer account
(`https://tool.growwer.com/user/buyer/api-keys`, or `/user/seller/api-keys` if you
sell). Revoking a key takes effect immediately. A read key cannot change anything
on Growwer. With a read and write key, the writes that spend money, pay a seller,
refuse an order or delete for good run only after you accept a confirmation form
in your MCP client. A client that cannot show that form gets a link to the Growwer
page where you can do it yourself, and nothing changes.

This package holds no permissions of its own: it forwards the key it is given,
so it can do exactly what that key can do.
