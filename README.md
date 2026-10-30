<p align="center">
  <img src="assets/growwer-icon-256.png" alt="Growwer" width="96" height="96">
</p>

<h1 align="center">Growwer MCP server</h1>

<p align="center">
  Ask an AI assistant to find media for your project, buy sponsored articles and follow your orders, sales and wallet on Growwer, in plain language.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@growwer/mcp"><img src="https://img.shields.io/npm/v/%40growwer%2Fmcp?logo=npm&logoColor=white&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://registry.modelcontextprotocol.io/?search=com.growwer%2Fgrowwer"><img src="https://img.shields.io/badge/MCP%20registry-com.growwer%2Fgrowwer-5a45ff" alt="MCP registry"></a>
  <a href="https://github.com/viralitymedia/growwer-mcp/pkgs/container/growwer-mcp"><img src="https://img.shields.io/badge/ghcr.io-viralitymedia%2Fgrowwer--mcp-2496ed?logo=docker&logoColor=white" alt="GitHub Container Registry"></a>
  <a href="https://github.com/viralitymedia/growwer-mcp/actions/workflows/ci.yml"><img src="https://github.com/viralitymedia/growwer-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT licence"></a>
</p>

---

Growwer is a marketplace of sponsored articles and link additions on third-party media, for brands,
agencies and publishers. The MCP server exposes it to any MCP client, for buyers and for sellers, as
**69 tools** (36 that read, 33 that change something) and **6 prompts**. One tool,
`growwer_get_guide`, answers questions about Growwer itself and works without signing in, and so do
the prompts.

The server is **hosted**. Most clients should connect to it directly:

```
https://tool.growwer.com/mcp
```

This repository holds the public metadata for that server plus a small stdio bridge
(`@growwer/mcp`) for hosts that can only launch a local process. It does **not** contain the
Growwer application source.

## Connect

### Clients that speak remote MCP (recommended)

No install, no local process. Sign in with OAuth, or paste an API key as a header.

| Client | How |
|---|---|
| **Claude** (web, Desktop, mobile) | Customize → Connectors → **+ Add** → *Add custom connector*, name it Growwer, paste the URL, choose Continue and sign in. |
| **ChatGPT** | Open [chatgpt.com/plugins](https://chatgpt.com/plugins), choose the plus button → *Add custom MCP server*, name it Growwer, paste the URL and sign in. |
| **Claude Code** | `claude mcp add --transport http growwer https://tool.growwer.com/mcp` then `/mcp` to sign in |
| **Cursor** | [config below](#client-configuration) |
| **OpenAI Codex** | [config below](#client-configuration) |
| **VS Code** | [config below](#client-configuration) |
| **Gemini CLI** | [config below](#client-configuration) |

### Clients that can only spawn a local process

Hosts that only start a local process, such as Claude Desktop's manual configuration and older
stdio-only clients, need a bridge. That is what this package is:

```bash
npx -y @growwer/mcp
```

```jsonc
// claude_desktop_config.json
{
  "mcpServers": {
    "growwer": {
      "command": "npx",
      "args": ["-y", "@growwer/mcp"],
      "env": { "GROWWER_API_KEY": "gw_sk_your_key" }
    }
  }
}
```

The key goes through the environment rather than an argument, so it does not appear in `ps` output
and does not have to survive the host's argument splitting.

## Authentication

Two ways in. Neither can ever do more than your own Growwer account allows:

| Permission | Allows |
|---|---|
| Read | Every read tool. Always granted. |
| Read and write | Also creating projects, placing and cancelling orders, approving deliveries, delivering orders and everything else that changes something. |

**OAuth 2.1**: the one-click path. Supported by Claude, ChatGPT, Claude Code and any client that
implements the MCP authorization spec. Nothing to copy or paste; revoke it from your account's MCP
page. The scopes are `read` and `write`, and `write` implies `read`. The server advertises PKCE
(`S256`), Client ID Metadata Documents, Dynamic Client Registration and RFC 9728 resource metadata,
so clients discover everything they need from
`https://tool.growwer.com/.well-known/oauth-protected-resource/mcp`. Calling a tool the connection
lacks the scope for answers `403 insufficient_scope` naming the scopes to request, so a client that
supports step-up authorization asks you to approve the extra permission.

**API key**: for CLI clients, config files and this bridge. Create one on the
[buyer keys page](https://tool.growwer.com/user/buyer/api-keys) or the
[seller keys page](https://tool.growwer.com/user/seller/api-keys). It is shown once, starts with
`gw_sk_`, and is either read-only or read and write. Send it as `Authorization: Bearer gw_sk_…`.

> ChatGPT cannot send a custom `Authorization` header to a remote connector, so use OAuth there.

## Client configuration

Each client below signs in with OAuth by default; the second block, where there is one, uses an API
key instead.

**Claude Code**

```bash
claude mcp add --transport http growwer https://tool.growwer.com/mcp
# Then run /mcp to sign in. With an API key instead:
claude mcp add --transport http growwer https://tool.growwer.com/mcp --header "Authorization: Bearer gw_sk_YOUR_KEY"
```

**Cursor** (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "growwer": {
      "url": "https://tool.growwer.com/mcp"
    }
  }
}
```

```json
{
  "mcpServers": {
    "growwer": {
      "url": "https://tool.growwer.com/mcp",
      "headers": {
        "Authorization": "Bearer gw_sk_YOUR_KEY"
      }
    }
  }
}
```

**OpenAI Codex** (`~/.codex/config.toml`), then `codex mcp login growwer` to sign in

```toml
[mcp_servers.growwer]
url = "https://tool.growwer.com/mcp"
```

With an API key, read from the environment:

```toml
[mcp_servers.growwer]
url = "https://tool.growwer.com/mcp"
bearer_token_env_var = "GROWWER_API_KEY"
```

**VS Code** (`.vscode/mcp.json`)

```json
{
  "servers": {
    "growwer": {
      "type": "http",
      "url": "https://tool.growwer.com/mcp"
    }
  }
}
```

With an API key, which VS Code asks for once and stores for you:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "growwer-api-key",
      "description": "Growwer API key",
      "password": true
    }
  ],
  "servers": {
    "growwer": {
      "type": "http",
      "url": "https://tool.growwer.com/mcp",
      "headers": {
        "Authorization": "Bearer ${input:growwer-api-key}"
      }
    }
  }
}
```

**Gemini CLI** (`~/.gemini/settings.json`), then `/mcp auth growwer` to sign in

```json
{
  "mcpServers": {
    "growwer": {
      "httpUrl": "https://tool.growwer.com/mcp"
    }
  }
}
```

```json
{
  "mcpServers": {
    "growwer": {
      "httpUrl": "https://tool.growwer.com/mcp",
      "headers": {
        "Authorization": "Bearer gw_sk_YOUR_KEY"
      }
    }
  }
}
```

## Tools

Each tool's input schema states what it takes, and [`catalog.json`](catalog.json) holds all of them.
Every tool that changes something takes a `requestId`: calling it again with the same `requestId` and
arguments returns the first result without writing twice.

### Reading

| Area | Tools |
|---|---|
| Account and reference | `growwer_get_me`, `growwer_get_guide`, `growwer_get_vocabulary` |
| Projects | `growwer_list_projects`, `growwer_get_project`, `growwer_list_saved_filters`, `growwer_count_saved_filter_medias` |
| Catalogue | `growwer_search_project_medias`, `growwer_get_catalogue_media`, `growwer_list_flash_offers` |
| Orders | `growwer_estimate_order`, `growwer_list_orders`, `growwer_get_order`, `growwer_download_order_briefing`, `growwer_download_order_draft` |
| Managed service | `growwer_list_managed_service_campaigns`, `growwer_get_managed_service_campaign`, `growwer_list_managed_service_proposals`, `growwer_estimate_managed_service_proposals`, `growwer_get_managed_service_proposals_summary` |
| Buyer wallet and billing | `growwer_get_buyer_wallet`, `growwer_list_buyer_transactions`, `growwer_download_buyer_transaction_document`, `growwer_list_invoices`, `growwer_get_invoice_pdf` |
| Selling | `growwer_list_seller_medias`, `growwer_get_seller_media`, `growwer_list_seller_orders`, `growwer_get_seller_order`, `growwer_download_seller_order_briefing`, `growwer_download_seller_order_draft` |
| Seller wallet | `growwer_get_seller_wallet`, `growwer_list_seller_transactions`, `growwer_download_seller_transaction_document`, `growwer_list_withdrawals`, `growwer_download_withdrawal_invoice` |

### Changing things

Tools in **bold** are guarded: they move money or cannot be undone, so the server asks you to confirm
in your client before anything happens. See [Limits](#limits).

| Area | Tools |
|---|---|
| Projects | `growwer_create_project`, `growwer_update_project`, **`growwer_delete_project`**, `growwer_create_saved_filter`, `growwer_delete_saved_filter` |
| Catalogue | `growwer_favourite_media`, `growwer_unfavourite_media`, `growwer_discard_media`, `growwer_undiscard_media`, `growwer_request_medias` |
| Orders | **`growwer_create_order`**, **`growwer_cancel_order`**, **`growwer_approve_order`**, `growwer_approve_order_draft`, `growwer_request_order_draft_update`, `growwer_request_order_update`, `growwer_upload_file` |
| Managed service | `growwer_request_managed_service_campaign`, `growwer_request_managed_service_info`, **`growwer_review_managed_service_proposals`** |
| Media you sell on | `growwer_create_seller_media`, `growwer_update_seller_media`, **`growwer_delete_seller_media`**, `growwer_apply_seller_media_competitive_fees`, `growwer_put_seller_holiday` |
| Orders you sell | `growwer_accept_seller_order`, **`growwer_reject_seller_order`**, `growwer_deliver_seller_order`, `growwer_deliver_seller_order_draft`, `growwer_deliver_seller_order_draft_update`, `growwer_deliver_seller_order_update`, `growwer_refute_seller_order_draft_update`, `growwer_refute_seller_order_update` |

## Prompts

Prompts are guided flows your client can offer as commands. They are static text with no account
data, so they answer without signing in, and each one stops for your approval before it changes
anything.

| Prompt | Workflow |
|---|---|
| `find_media_for_project` | Search the catalogue for media that fit one of your projects and compare the best candidates. |
| `safe_purchase` | Estimate an order, then place it with its confirmed price, without charging anything by surprise. |
| `track_orders` | See where your orders stand and act on the drafts and deliveries that wait for you. |
| `seller_fulfilment` | Work through the orders placed on your media: accept them, deliver them and answer update requests. |
| `review_managed_service_proposals` | Compare the media Growwer proposed for a campaign, see the cost and decide on each one. |
| `wallet_and_spend_report` | Summarise your wallet balances, recent movements, invoices and, if you sell, your earnings. |

## Skills

Six optional skills turn the tools into reusable workflows, one per prompt, for hosts that do not
surface MCP prompts:

- [Find media for a project](skills/growwer-find-media-for-project/SKILL.md)
- [Safe purchase](skills/growwer-safe-purchase/SKILL.md)
- [Track orders](skills/growwer-track-orders/SKILL.md)
- [Seller fulfilment](skills/growwer-seller-fulfilment/SKILL.md)
- [Review managed service proposals](skills/growwer-review-managed-service-proposals/SKILL.md)
- [Wallet and spend report](skills/growwer-wallet-and-spend-report/SKILL.md)

Each folder holds `SKILL.md` and `agents/openai.yaml`, which declares the Growwer MCP connection.
They need no additional backend endpoint or local executable.

## The bridge

### Run it

```bash
export GROWWER_API_KEY=gw_sk_your_key
npx -y @growwer/mcp            # serve on stdio
npx -y @growwer/mcp doctor     # check the endpoint, the key, and list the tools
```

### Docker

```bash
docker run --rm -i -e GROWWER_API_KEY=gw_sk_your_key ghcr.io/viralitymedia/growwer-mcp
```

`-i` is required and `-t` must be omitted: the MCP transport is this process's stdin and stdout.

### Options

| | |
|---|---|
| `GROWWER_API_KEY` | API key. Without it the bridge still starts and still advertises the full catalogue; `growwer_get_guide` and the prompts answer from the public endpoint, and every other tool answers with setup instructions instead of data. |
| `GROWWER_MCP_URL` | Upstream endpoint. Defaults to `https://tool.growwer.com/mcp`. |
| `--url <url>` | Same, as an argument. |
| `--header "Name: value"` | Extra HTTP header, repeatable. An `Authorization` header here overrides `GROWWER_API_KEY`. |
| `doctor` | Connect once, print the server version, negotiated protocol, tool and prompt catalogue, then exit. |
| `--help`, `--version` | |

### What it actually does

It splices your client's stdio transport onto a Streamable HTTP transport and forwards every
JSON-RPC frame verbatim, in both directions. The only frame it looks inside is the handshake,
enough to echo the negotiated protocol version back upstream and to rebuild the session if the
server evicts it, which a deploy or a scale-down will do. It knows no other method, so it cannot
drift from the server: tools, prompts, guarded writes on either protocol, progress notifications
and anything added later all pass straight through.

The bridge never leaves a request unanswered:

- **Every request gets a reply.** A status such as 429 or 503, a refused connection, a wrong content
  type or a stream that ends with no result reaches your client as a JSON-RPC error on that
  request's id, naming the status or the cause. An upstream body is never repeated, in that error or
  on stderr. Notifications and responses have no one to answer, so a failure of theirs is logged.
- **Only a 404 rebuilds the session**, once however many requests hit it at the same time, and a 400
  never does. The request that got the 404 never ran, so it alone is sent again, once. A response is
  never sent again.
- **A request that was open when the session died gets an error, not a retry**, because it may have
  run. That includes a guarded write waiting for your confirmation: your answer to it is dropped,
  and never reaches the new session. The write's `requestId` makes a repeat safe.
- **A failed rebuild keeps the bridge up.** The request that needed it gets an error, and the next
  one rebuilds first.
- **A rejected key ends the bridge.** On a 401, every open request gets the explanation, then the
  process exits.

### Without a credential

The bridge starts anyway, serving [`catalog.json`](catalog.json), a committed copy of what the hosted
server advertises, plus a `growwer_setup` tool. So `npx -y @growwer/mcp` introspects to the same
tools and prompts a credentialed run does, and anything that scans the package sees a real catalogue
rather than a server that looks empty. Calling one of those tools returns the setup instructions as
an error; it never returns invented data. The exceptions read only published material:
`growwer_get_guide` and `prompts/get` go to the hosted server's anonymous endpoint, with no
credential, and return the real answer.

`npm run sync:catalog` refreshes the file from that endpoint, and `npm run check:catalog` fails if
the committed copy has fallen behind. A scheduled workflow runs the check weekly, because the
catalogue it mirrors lives in another repository and nothing in a pull request here would notice it
drifting. A release runs the same check first, so a stale catalogue publishes nothing.

## Limits

| | |
|---|---|
| Access | `read` always; `write` only when granted, and never beyond your own account. |
| Confirmation | Seven writes need your confirmation in a client that can show a form (MCP form elicitation). A client without it gets `elicitation_unsupported` and nothing is written; a decline gives `confirmation_declined`; no answer in time gives `confirmation_not_answered`; a price that changed meanwhile gives `price_changed`. |
| Money | Spending comes from your Growwer wallet. Top-ups happen on [growwer.com](https://growwer.com/), never through a tool. |
| Catalogue | The full catalogue opens after a recent delivered order; until then a small daily trial quota applies (`catalogue_requires_recent_order`). Accounts also have a daily quota of distinct media (`catalogue_daily_cap_reached`). |
| Protocols | MCP 2025-11-25 and 2026-07-28 over Streamable HTTP. |
| Rate limiting | Tool calls share a per-minute budget with the REST API, per user and per key (`rate_limit_exceeded`). Repeatedly presenting an invalid credential is rate limited too. |
| Result size | Large result sets are paginated; each tool's input schema states its limits. |

## Repository contents

| | |
|---|---|
| `src/`, `test/` | The stdio bridge published as `@growwer/mcp`. |
| `catalog.json` | What the hosted server advertises, served by the bridge when it has no credential. |
| `scripts/` | Manifest and catalogue checks run by CI, and the end-to-end host driver. |
| `server.json` | The [MCP registry](https://registry.modelcontextprotocol.io) manifest. |
| `glama.json` | Glama directory ownership metadata. |
| `skills/` | Six reusable Growwer workflows, one per prompt. |
| `Dockerfile` | The image published to `ghcr.io/viralitymedia/growwer-mcp`. |
| `assets/` | Brand assets used by directory listings. |
| `RELEASING.md` | The steps that publish the first release. |

## Development

```bash
npm ci
npm run typecheck
npm test            # builds first, then runs the suite
npm run check:manifests
npm run check:catalog   # asks the hosted server whether catalog.json is still current
```

Tests run the TypeScript sources directly through Node's type stripping, so development needs
Node 22.18 or newer. The published package targets Node 20.19+, which CI verifies separately against
the built artifact.

`scripts/e2e-host.mjs` drives the built bridge as a real host would, against a running Growwer stack,
on both protocols: a read, a plain write, and a guarded write declined and accepted. It deletes
projects, so point it at a development stack, with a read and write key of that stack in
`GROWWER_API_KEY` whose account owns two disposable projects named `bridge-e2e`:

```bash
npm run build
node scripts/e2e-host.mjs --url http://localhost:<stack port>/mcp
```

Releases are cut by tagging. `npm version <patch|minor|major>`, mirror the new version into
`server.json` (`.version`, the npm package entry, and the image tag), run
`npm run check:manifests`, then push the tag. CI publishes to npm, GHCR and the MCP registry, in that
order, then creates the GitHub release, which is what Glama builds a new version from. The first
release has owner steps of its own, in [RELEASING.md](RELEASING.md).

## Support

* Product and account questions: [support@growwer.com](mailto:support@growwer.com)
* Bugs in this package: [open an issue](https://github.com/viralitymedia/growwer-mcp/issues)
* Security: see [SECURITY.md](SECURITY.md)
* About the server: [growwer.com/mcp](https://growwer.com/mcp/)
* Privacy policy: [growwer.com/legal/privacy-policy](https://growwer.com/legal/privacy-policy/)
* Terms of use: [growwer.com/legal/terms-of-use](https://growwer.com/legal/terms-of-use/)

## Licence

MIT. See [LICENSE](LICENSE).

The Growwer name, logo and brand assets in `assets/` are trademarks of Virality Media, S.L. and are
not covered by that licence.
