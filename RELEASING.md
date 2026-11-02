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

Steps 1 to 3 can be done at any pace. Step 4 cannot: it starts a two-day window, so do it only once
everything before it is done and the hosted catalogue is current.

1. **The release gates.** The workflow publishes to npm through trusted publishing (OIDC), with no npm
   token stored anywhere, and each publishing job waits for the owner.

   1. Create the npm organisation `growwer`.
   2. Required reviewers on both environments. Create the GitHub environments `npm-release` and
      `mcp-registry`, and add the owner as a required reviewer on each, so no job in either runs
      until the owner approves it.
   3. A deployment rule on each environment. Under "Deployment branches and tags", choose "Selected
      branches and tags" and add a single tag rule, `v*`, on both `npm-release` and
      `mcp-registry`, so a branch, or a workflow edited on one, cannot deploy to either.
   4. A tag ruleset that restricts who creates `v*` tags: target `refs/tags/v*`, the "Restrict
      creations" rule, and repository admins as the only bypass. A tag starts a release, so only
      those who may release can create one. Keep it separate from the step 3 ruleset, which has no
      bypass at all.

2. **MCP registry.** The registry proves ownership of `com.growwer` through DNS.

   ```bash
   openssl genpkey -algorithm Ed25519 -out key.pem
   openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64
   openssl pkey -in key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n' |
     gh secret set MCP_REGISTRY_PRIVATE_KEY --env mcp-registry --repo viralitymedia/growwer-mcp
   rm key.pem
   ```

   The third command stores the private key as the secret `MCP_REGISTRY_PRIVATE_KEY` in the
   environment `mcp-registry` from step 1.2: `gh secret set` reads it from standard input, so it is
   never printed or put on a command line. Then add a TXT record on `growwer.com`, with the second
   command's output as the public key:

   ```
   growwer.com. IN TXT "v=MCPv1; k=ed25519; p=<public key>"
   ```

3. **Repository settings.**
   - A ruleset on `main`: pull requests only, squash or merge, no force pushes and no deletion, with
     the `CI passed` check required and up to date, and organisation admins as the only bypass.
   - A ruleset on the tags `refs/tags/v*`: no force pushes and no deletion, with no bypass. Who may
     create such a tag is the separate ruleset of step 1.4.
   - Under Settings > Advanced Security > Dependabot, "Dependabot alerts" and "Dependabot security
     updates" enabled, "Grouped security updates" disabled. `.github/dependabot.yml` says why.

4. **npm's trusted publisher, then the tag.** npm adds a trusted publisher only to a package that
   already exists, so a throwaway pre-release creates the package first. A new trusted publisher
   configuration must then complete its first successful publish within 2 days, or it expires and
   can no longer be used or edited ([npm docs](https://docs.npmjs.com/trusted-publishers)). The
   workflow's publish of `1.0.0` is that first publish, so steps 4.3 to 4.5 belong to the same two
   days.

   1. Run the `catalog-drift` workflow from the Actions tab. If it is red, the hosted catalogue
      differs from the committed one: run `npm run sync:catalog`, merge that change in a pull
      request, and run the workflow again. Go on only once it is green, since a red catalogue stops
      the release and the window keeps running.
   2. Publish the pre-release `0.0.0-bootstrap.0` with a short-lived token. On npmjs.com, create a
      granular access token with read and write on the `@growwer` scope and the shortest expiry
      offered. Then, in a throwaway clone:

      ```bash
      git clone --depth 1 https://github.com/viralitymedia/growwer-mcp.git /tmp/growwer-mcp-bootstrap
      cd /tmp/growwer-mcp-bootstrap && npm ci
      npm version 0.0.0-bootstrap.0 --no-git-tag-version
      read -rs NPM_TOKEN && export NPM_TOKEN   # paste the token: not echoed, not kept in history
      printf '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n' > /tmp/npmrc-growwer-release
      npm publish --tag bootstrap --provenance=false --userconfig /tmp/npmrc-growwer-release
      npm deprecate @growwer/mcp@0.0.0-bootstrap.0 'Created the package for trusted publishing. Install @growwer/mcp@latest.' \
        --userconfig /tmp/npmrc-growwer-release
      rm /tmp/npmrc-growwer-release && unset NPM_TOKEN
      cd - && rm -rf /tmp/growwer-mcp-bootstrap
      ```

      The npmrc holds the variable's name, not the token. npm refuses to publish a pre-release
      without `--tag`, and `--provenance=false` is needed because provenance can only be signed in
      CI. The pre-release is deprecated at once, with the same token, so an install of it warns;
      once `1.0.0` is published without a tag it becomes `latest`. It is not unpublished: npm never
      lets a version number be used again, and unpublishing a package's only version removes the
      package, after which nothing can be published to it for 24 hours
      ([npm unpublish policy](https://docs.npmjs.com/policies/unpublish)).
   3. Configure the trusted publisher, then remove every token. In the package's settings on
      npmjs.com, add a trusted publisher for GitHub Actions: organisation `viralitymedia`,
      repository `growwer-mcp`, workflow `release.yml`, environment `npm-release`. Set publishing
      access to "Require two-factor authentication and disallow tokens", revoke the granular token,
      and delete the secret `NPM_TOKEN` wherever one was stored (repository or environment). The two
      days start here.
   4. Tag `v1.0.0` on `main`:

      ```bash
      git tag v1.0.0
      git push origin v1.0.0
      ```

   5. Approve the deployments. The `Release` workflow checks the catalogue again, then asks the owner
      to approve `npm-release`; its npm job publishes `1.0.0` with provenance, which validates the
      trusted publisher. The GHCR image follows npm, then the workflow asks for `mcp-registry`, and
      the registry entry and the GitHub release follow.

   If the two days pass before `1.0.0` is on npm, the configuration has expired and cannot be
   edited: delete it in the package's settings, add it again as in step 4.3, and publish within two
   days of that. No new pre-release is needed, since the package exists. A tag already pushed can
   be run again from the Actions tab.

   Then check the package from npm:

   ```bash
   read -rs GROWWER_API_KEY && export GROWWER_API_KEY   # paste a key: not echoed, not kept in history
   npx -y @growwer/mcp --version
   npx -y @growwer/mcp doctor
   ```

5. **Glama.** Claim the listing. `glama.json` names the maintainers it accepts.
