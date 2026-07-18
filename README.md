# cloudtunnel

Expose a local port at a public HTTPS subdomain on **your own Cloudflare domains** — nport-style, but the tunnel and DNS live in your Cloudflare account. Manage every tunnel subdomain across the whole account from one CLI.

## Quickstart

```bash
npm i -g @iamken/cloudtunnel

cloudtunnel login     # once — paste a token (or set CLOUDFLARE_API_TOKEN); account + zone auto-resolved
cloudtunnel 3000      # → https://brave-otter-1a2b.example.com is live
```

`cloudtunnel 3000` is shorthand for `cloudtunnel up 3000`. Press **Ctrl-C** to stop the connector — the subdomain is **kept** (delete it with `cloudtunnel rm`). Want the nport-style throwaway behaviour? add `--ephemeral`.

## How it works

`cloudtunnel` uses **native Cloudflare Tunnel**: it creates a remotely-managed tunnel via the Cloudflare API, points a proxied CNAME at it (`<id>.cfargotunnel.com`), and runs the `cloudflared` connector for you. Traffic flows `browser → Cloudflare edge → cloudflared → your local port`.

## Commands

| Command | Does |
|---------|------|
| `cloudtunnel login` | Authenticate; auto-resolve account + default zone. `--status` to inspect. |
| `cloudtunnel <port>` / `up <port>` | Create + serve a subdomain. Flags: `-s/--subdomain`, `-d/--domain`, `--hostname`, `--detach`, `--ephemeral`, `--proto`. Pick a domain interactively when you have several and none is passed. |
| `cloudtunnel ls [--all]` | List tunnel subdomains. `--all` also scans the account for unmanaged ones. |
| `cloudtunnel update <name> --port <p>` | Repoint a subdomain to a new port — **zero downtime** (hot-reload, no restart). |
| `cloudtunnel rm <name> [--dry-run] [--force]` | Delete a subdomain (stops connector, removes tunnel + DNS). |
| `cloudtunnel status <name>` | Tunnel health + connector state. |
| `cloudtunnel down [name] [--all]` | Stop connector(s); keep the tunnel + DNS. |
| `cloudtunnel gc [--yes]` | Prune crash orphans. |
| `cloudtunnel zones` | List the domains in your account. |

## Authentication

Create a **Cloudflare API token** with these scopes (least-privilege; a zone-scoped token limited to the domains you tunnel into is recommended):

- Account · **Cloudflare Tunnel** · Edit
- Account · **Account Settings** · Read
- Zone · **DNS** · Edit
- Zone · **Zone** · Read

Provide it via (in order of precedence): `CLOUDFLARE_API_TOKEN` env var → `cloudtunnel login --token-stdin` → the hidden prompt from `cloudtunnel login`. The token is **never** passed on the command line (it would leak into `ps` / shell history) and is stored `0600`. Rotate it if a shared host is compromised.

## Requirements

- Node.js ≥ 20
- `cloudflared` on your `PATH` — install via `brew install cloudflared` / your package manager, or from <https://github.com/cloudflare/cloudflared/releases>. (Auto-download is built in and fetches a pinned, SHA256-verified binary, but stays disabled until release checksums are pinned — so treat `cloudflared` as a prerequisite for now.)

## Troubleshooting

- **HTTP 1016 / subdomain not loading** — the connector isn't running. Start it with `cloudtunnel <port> --name <sub>` (re-attaches) or check `cloudtunnel status <sub>`.
- **"grey-clouded" error** — the zone couldn't proxy the record; cfargotunnel routing needs an orange-cloud (proxied) CNAME.

## License

MIT
