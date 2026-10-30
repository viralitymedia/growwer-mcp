# Releasing

The steps that publish `v1.0.0`. They are the owner's: each one needs an account, a secret or a
setting that no pull request can hold. Later releases need only the tag, as the README's
[Development](README.md#development) section says.

## Before anything here

1. Deploy the hosted server with Growwer pull requests #406, #415 and #408. Until then
   `/public/v1/mcp` serves an older catalogue, the `catalog-drift` workflow stays red and a tag
   publishes nothing.
2. Publish `https://growwer.com/mcp/`, which `server.json` and the package name as their website.

## Steps

1. **npm.** Create the npm organisation `growwer`. Create an automation token that can publish
   `@growwer/mcp`, and store it as the secret `NPM_TOKEN` in the GitHub environment `npm-release`.

2. **MCP registry.** The registry proves ownership of `com.growwer` through DNS.

   ```bash
   openssl genpkey -algorithm Ed25519 -out key.pem
   openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64
   openssl pkey -in key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n'
   ```

   Add a TXT record on `growwer.com`, with the second command's output as the public key:

   ```
   growwer.com. IN TXT "v=MCPv1; k=ed25519; p=<public key>"
   ```

   Store the third command's output as the secret `MCP_REGISTRY_PRIVATE_KEY` in the GitHub environment
   `mcp-registry`, then delete `key.pem`.

3. **Repository settings.**
   - A ruleset on `main`: pull requests only, squash or merge, no force pushes and no deletion, with
     the `CI passed` check required and up to date, and organisation admins as the only bypass.
   - A ruleset on the tags `refs/tags/v*`: no force pushes and no deletion, with no bypass.
   - Under Settings > Advanced Security > Dependabot, "Dependabot alerts" and "Dependabot security
     updates" enabled, "Grouped security updates" disabled. `.github/dependabot.yml` says why.

4. **Tag.** Run the `catalog-drift` workflow from the Actions tab. If it is red, the hosted catalogue
   differs from the committed one: run `npm run sync:catalog`, merge that change in a pull request,
   and run the workflow again. Once it is green:

   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

   The `Release` workflow checks the catalogue again, then publishes npm, the GHCR image, the registry
   entry and the GitHub release. Then check the package from npm:

   ```bash
   npx -y @growwer/mcp --version
   GROWWER_API_KEY=<a key> npx -y @growwer/mcp doctor
   ```

5. **Glama.** Claim the listing. `glama.json` names the maintainers it accepts.
