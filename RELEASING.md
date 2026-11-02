# Releasing

The steps that publish `v1.0.0`. They are the owner's: each one needs an account, a secret or a
setting that no pull request can hold. Later releases need only the tag and the owner's approval of
the two deployments it asks for, as the README's [Development](README.md#development) section says.

## Before anything here

1. Deploy the hosted server with Growwer pull requests #406, #415 and #408. Until then
   `/public/v1/mcp` serves an older catalogue, the `catalog-drift` workflow stays red and a tag
   publishes nothing.
2. `https://growwer.com/link-building-mcp/`, which `server.json` and the package name as their website, is live
   (published 2026-10-31; `/mcp/` redirects to it).

## Steps

1. **npm and the release gates.** The workflow publishes to npm through trusted publishing (OIDC),
   with no npm token stored anywhere. npm configures a trusted publisher only for a package that
   already exists, so `v1.0.0` alone is published by hand.

   1. Create the npm organisation `growwer`.
   2. Publish `v1.0.0` with a short-lived granular token. Run the `catalog-drift` workflow first and
      stop if it is red (step 4): the version is immutable, catalogue included. On npmjs.com, create a
      granular access token with read and write on the `@growwer` scope and the shortest expiry
      offered. Then, in a clean checkout of the `main` commit you will tag in step 4:

      ```bash
      npm ci && npm test
      read -rs NPM_TOKEN && export NPM_TOKEN   # paste the token: not echoed, not kept in history
      printf '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n' > /tmp/npmrc-growwer-release
      npm publish --provenance=false --userconfig /tmp/npmrc-growwer-release
      rm /tmp/npmrc-growwer-release && unset NPM_TOKEN
      ```

      The npmrc holds the variable's name, not the token. `--provenance=false` is needed because
      provenance can only be signed in CI, so `1.0.0` alone ships without it.
   3. Configure the trusted publisher, then remove every token. In the package's settings on
      npmjs.com, add a trusted publisher for GitHub Actions: organisation `viralitymedia`,
      repository `growwer-mcp`, workflow `release.yml`, environment `npm-release`. Set publishing
      access to "Require two-factor authentication and disallow tokens", revoke the granular token,
      and delete the secret `NPM_TOKEN` wherever one was stored (repository or environment).
   4. Required reviewers on both environments. Create the GitHub environments `npm-release` and
      `mcp-registry`, and add the owner as a required reviewer on each, so no job in either runs
      until the owner approves it.
   5. A deployment rule on each environment. Under "Deployment branches and tags", choose "Selected
      branches and tags" and add a single tag rule, `v*`, on both `npm-release` and
      `mcp-registry`, so a branch, or a workflow edited on one, cannot deploy to either.
   6. A tag ruleset that restricts who creates `v*` tags: target `refs/tags/v*`, the "Restrict
      creations" rule, and repository admins as the only bypass. A tag starts a release, so only
      those who may release can create one. Keep it separate from the step 3 ruleset, which has no
      bypass at all.

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
   - A ruleset on the tags `refs/tags/v*`: no force pushes and no deletion, with no bypass. Who may
     create such a tag is the separate ruleset of step 1.6.
   - Under Settings > Advanced Security > Dependabot, "Dependabot alerts" and "Dependabot security
     updates" enabled, "Grouped security updates" disabled. `.github/dependabot.yml` says why.

4. **Tag.** Run the `catalog-drift` workflow from the Actions tab. If it is red, the hosted catalogue
   differs from the committed one: run `npm run sync:catalog`, merge that change in a pull request,
   and run the workflow again. Once it is green:

   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

   The `Release` workflow checks the catalogue again, then asks the owner to approve the
   `npm-release` and `mcp-registry` deployments. Its npm job finds `1.0.0` already on npm from
   step 1.2 and skips the publish; the GHCR image, the registry entry and the GitHub release follow. Then check the package from npm:

   ```bash
   npx -y @growwer/mcp --version
   GROWWER_API_KEY=<a key> npx -y @growwer/mcp doctor
   ```

5. **Glama.** Claim the listing. `glama.json` names the maintainers it accepts.
