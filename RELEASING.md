# Release preparation

The repository is designed to be moved to its own public Git host without importing backend implementation, credentials, or deployment configuration. Package naming is provisional until the npm scope is confirmed.

Before the first public release:

1. Confirm ownership of the `@dioko` npm scope and the final package name.
2. Keep the MIT `LICENSE` file and copyright notice in the repository and published package.
3. Set the final repository, homepage, and issue tracker URLs in package metadata.
4. Run `npm ci`, `npm run check`, and `npm pack --dry-run`. Inspect the tarball and install it in a consumer app, testing the browser, server, and React imports.
5. Exercise a browser source against the deployed collector with its allowed origin. Confirm CORS, events appearing in reports, and consent behavior. Local mocked transport checks do not verify production delivery.
6. Publish a versioned release with `npm publish --access public` using the owner's npm credentials or trusted publishing configuration.

Keep both clients aligned with version 1 of `POST /v1/batch`: public `source_key` for browsers or a bearer secret for backends, JSON event envelopes, stable UUIDs and timestamps on retry, 100 events per batch, 256 KiB per request, and 32 KiB per event. React bindings are an optional subpath of the same package so both interfaces share a version and transport implementation.
