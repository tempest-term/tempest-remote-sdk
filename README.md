# Tempest Remote SDK

MIT-licensed Node.js client for **Tempest CLI remote protocol v1**. Reuse saved
SSH servers, credentials, proxies and jump hosts in an editor, terminal or tool.
The SDK adapts the CLI's NDJSON control protocol; the CLI owns authentication,
the SSH relay, generated SSH config and connection keys. No upstream credentials
are exported. The Tempest desktop app does not need to remain open.

Source: https://github.com/tempest-term/tempest-remote-sdk

## Install

```sh
npm install @tempest-term/remote-sdk
```

Requires Node.js 18+ and a separately installed [Tempest CLI](https://gotempest.app/download)
with `tempest remote control` and `tempest remote pipe`. The npm package contains
no CLI binary and no runtime dependencies. Before the first npm release, use
`npm install ../tempest-remote-sdk` in a sibling checkout or install a locally
packed tarball. Registry installation requires a published version.

The package is published to **GitHub Packages**, not npmjs. Configure the scope
in your project's `.npmrc` (included in this repository):

```ini
@tempest-term:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Use a GitHub token with `read:packages` as `NODE_AUTH_TOKEN` when installing
locally. Do not commit the token. GitHub Actions consumers use `GITHUB_TOKEN`
with `packages: read`; grant their repositories access in the SDK package's
Actions access settings. GitHub's npm registry requires authentication even for
public packages. The VS Code VSIX and built Codex plugin bundle the SDK, so
end users only need Tempest CLI, not a package-registry login.

## Use

```js
const { ControlClient } = require('@tempest-term/remote-sdk');

const control = new ControlClient('tempest', async prompt => {
  // Implement these with your host's local UI. Never log prompt answers.
  if (prompt.kind === 'password') return ui.hiddenInput(prompt.message);
  if (prompt.kind === 'text') return ui.textInput(prompt.message);
  if (prompt.kind === 'confirm') return ui.confirm(prompt.message);
  return undefined; // Explicitly cancel unsupported prompts.
});

try {
  const servers = await control.listServers();
  const server = await ui.pickServer(servers);
  if (!server) return;
  const remote = await control.ensureRemote(server.id);
  await editor.openSshFolder(remote.sshHost, '/home/alice/project');
} finally {
  control.dispose();
}
```

The example body runs inside your application's async function. Supply your own
`ui` and `editor` adapters. ESM can use `import { ControlClient } from '@tempest-term/remote-sdk'`.
TypeScript declarations are included.

`listServers()` and `ensureRemote(serverId, { configFile? })` check protocol v1
and validate results. The lower-level `request(method, params)` API is available
for consumers already implementing those checks. Send requests sequentially;
the CLI has a bounded request queue. IDs are opaque and must be used intact.

SSH aliases are names, not encoded identities. New connections can use readable
names such as `tempest-ubuntu-cloudnet-6e0f3044c311`; the CLI reuses an already
assigned alias when reconnecting. Consumers must not assume a 64-character hash.
`isSshHost(value)` validates an alias for use by a host integration.

Constructor options: `account` selects a CLI account for this process;
`timeoutMs` defaults to 600000; `maxFrameBytes` defaults to 8 MiB for incoming
frames; `onTrace` receives safe method/outcome messages. Outgoing protocol
frames are limited to 65536 bytes including the newline. CLI stderr is not
parsed or logged. The SDK never reflects arbitrary error messages from CLI.

## Prompts and lifecycle

- Return a string for password/text, a boolean for confirmation, or `undefined`
  to cancel. Empty strings and explicit `false` are preserved. Show the full
  host-key/security-key confirmation and require the user's answer.
- `cancel()` rejects pending work and terminates this client's setup process.
- `dispose()` before successful setup terminates the setup process. After
  successful `remote.ensure`, it closes control stdin and detaches without
  killing the tunnel. Do not wait for CLI process exit as readiness.
- The editor/OpenSSH consumes `sshHost` through the generated ProxyCommand.
  It must attach within 120 seconds. Once attached, data pipes drive lifetime;
  the last closed pipe gives a short reconnect grace. Consider a temporary SSH
  keepalive while waiting for a user to complete a host-selection UI.
- Ensure again before reopening a saved/recent connection. A stored alias does
  not create a new tunnel, and the SDK never replays interrupted commands.

Use `~/.ssh/config` by default. If you supply `configFile`, the consumer must
use the same effective config, e.g. `ssh -F`. Do not read private session
descriptors or manually rebuild ProxyCommand settings.

## Consumers

- [Tempest Remote for VS Code](https://github.com/tempest-term/tempest-remote-vscode)
  supplies VS Code authentication UI and opens Remote - SSH workspaces.
- [Tempest Remote for Codex](https://github.com/tempest-term/tempest-remote-codex) supplies local-terminal prompts, a Codex
  add-host link and an SSH keepalive. Its separate MCP configuration runs
  `tempest mcp`; MCP is not part of this remote-control SDK.

See the [remote integration protocol](https://docs.gotempest.app/integrations/tempest-remote-plugin-protocol)
for wire format, relay support and policy boundaries.

## Develop and publish

```sh
npm ci
npm run check
npm test
npm run test:package
npm pack
```

CI tests Linux, macOS and Windows with Node 18, 22 and 24, including package
installation and type declarations. Release tags `vX.Y.Z` must match
`package.json`; `.github/workflows/publish.yml` publishes to GitHub Packages
using `GITHUB_TOKEN` with `packages: write`. No npmjs account or stored publish
token is needed. The package is linked to `tempest-term/tempest-remote-sdk`.
Use package settings to select visibility and grant consumer repositories
Actions access. A tag triggers publication; normal pushes only run CI.

## License

MIT, copyright Altas Express LLC. Extracted from the MIT-licensed Tempest Remote
VS Code client's control implementation. Tempest CLI, apps and services have
their own licenses and subscription terms.
