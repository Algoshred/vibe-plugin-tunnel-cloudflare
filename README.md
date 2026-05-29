# @vibecontrols/vibe-plugin-tunnel-cloudflare

Cloudflare Tunnel provider for [VibeControls Agent](https://www.npmjs.com/package/@vibecontrols/agent).

## Installation

```bash
vibe plugin install @vibecontrols/vibe-plugin-tunnel-cloudflare
```

Or install globally alongside the agent:

```bash
npm install -g @vibecontrols/vibe-plugin-tunnel-cloudflare
```

## Features

- **Cloudflare Tunnels** -- Create and manage Cloudflare quick tunnels (no account required)
- **Auto-Start** -- Automatically starts an agent tunnel on server boot
- **URL Extraction** -- Extracts the tunnel URL from cloudflared output
- **Process Management** -- Graceful start/stop with process cleanup
- **Storage Persistence** -- Tunnel state persisted via agent KV storage

## Provider Interface

This plugin registers a `tunnel` provider with the following capabilities:

| Method          | Description                                    |
| --------------- | ---------------------------------------------- |
| `start(config)` | Start a new Cloudflare tunnel for a local port |
| `stop(id)`      | Stop a running tunnel                          |
| `get(id)`       | Get tunnel info by ID                          |
| `list()`        | List all managed tunnels                       |
| `delete(id)`    | Delete a tunnel record                         |
| `getStatus()`   | Get overall tunnel provider status             |

## Requirements

- VibeControls Agent >= 2.0.0
- `cloudflared` installed on the host system
- Bun runtime >= 1.3.0

<!-- VIBECONTROLS_OSS_FOOTER_START -->

---

## About VibeControls

**VibeControls** is the agentic engineering mission control for AI-native teams. Vibe-plugins extend the VibeControls agent with new providers, tools, sessions, tunnels, storage backends, and security stages.

- Website: <https://vibecontrols.com>
- Documentation: <https://docs.vibecontrols.com>
- Plugin SDK: <https://github.com/algoshred/vibecontrols-plugin-sdk>
- All plugins: <https://github.com/algoshred?q=vibe-plugin-&type=all>

## Credits

This plugin builds on the following upstream open-source projects. All trademarks and copyrights remain with their respective owners.

- **Cloudflare Tunnel (Quick Tunnels)** — <https://try.cloudflare.com/>
- **cloudflared** — <https://github.com/cloudflare/cloudflared>

## License

Released under the [MIT License](./LICENSE).

Copyright (c) 2026 Burdenoff Consultancy Services Private Limited, Algoshred Technologies Private Limited, and all its sister companies.

Maintainer: **Vignesh T.V** — <https://github.com/tvvignesh>

**Note**: this plugin is open source under MIT. The `@vibecontrols/agent` runtime that loads and orchestrates plugins is **closed source** and proprietary to Burdenoff Consultancy Services Pvt. Ltd. If you want a fully self-hostable agent, please open an issue or contact the maintainer.

<!-- VIBECONTROLS_OSS_FOOTER_END -->
