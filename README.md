# @burdenoff/vibe-plugin-tunnel-cloudflare

Cloudflare Tunnel provider for [VibeControls Agent](https://www.npmjs.com/package/@vibecontrols/agent).

## Installation

```bash
vibe plugin install @burdenoff/vibe-plugin-tunnel-cloudflare
```

Or install globally alongside the agent:

```bash
npm install -g @burdenoff/vibe-plugin-tunnel-cloudflare
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

## License

Proprietary -- Copyright Burdenoff Consultancy Services Pvt. Ltd.
