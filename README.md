<div align="center">

# cloudtunnel

**Expose any local port at a public HTTPS subdomain — on _your own_ Cloudflare domains.**

The tunnel and DNS live in **your** Cloudflare account, so you keep clean, stable URLs and full control.

[![npm version](https://img.shields.io/npm/v/@iamken/cloudtunnel?color=cb3837&logo=npm&style=flat-square)](https://www.npmjs.com/package/@iamken/cloudtunnel)
[![CI](https://img.shields.io/github/actions/workflow/status/thanhken/cloudtunnel/ci.yml?branch=main&label=CI&logo=github&style=flat-square)](https://github.com/thanhken/cloudtunnel/actions)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](#license)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen?style=flat-square&logo=node.js)](#requirements)

</div>

```bash
npm i -g @iamken/cloudtunnel

cloudtunnel login      # once — paste a Cloudflare token; account + domain auto-resolved
cloudtunnel 8080       # → https://brave-otter-1a2b.example.com is live
```

> Prefer less typing? **`ctun`** is a built-in short alias — `ctun 8080`, `ctun ls`, `ctun delete 1`.

---

## Why cloudtunnel

- **Your domains, real subdomains** — native Cloudflare Tunnel to `*.your-domain.com`, not a shared third-party host.
- **One command, one or many** — `cloudtunnel api:8080 web:5173` brings up several tunnels at once, each a live HTTPS URL.
- **Spec-driven** — a tunnel is just `[subdomain:]port[@host]`. No profiles to define, nothing to save.
- **Two states** — `up` brings subdomains online; `delete` (or <kbd>Ctrl-C</kbd>) releases them (tunnel + DNS + any boot service). Re-running `up` always starts clean.
- **Secure by default** — token passed via env (never argv), stored `0600`, destructive ops ownership-gated and re-verified.

---

## Quickstart

```bash
cloudtunnel login                          # authenticate once
cloudtunnel 8080                           # asks for a subdomain (+ domain), then goes live
cloudtunnel api:8080                       # api.<your-domain> → localhost:8080
cloudtunnel api:8080@192.168.1.20          # forward to another host/IP (IPv4/IPv6)
cloudtunnel api:8080 web:5173 -d foo.io    # several tunnels at once, under foo.io
cloudtunnel api:8080 --detach              # run in the background
cloudtunnel api:8080 --service             # register a boot service
```

A **spec** is `[subdomain:]port[@host]`:

| Spec | Means |
| --- | --- |
| `8080` | random subdomain → `localhost:8080` |
| `api:8080` | `api.<domain>` → `localhost:8080` |
| `api:8080@192.168.1.20` | `api.<domain>` → `192.168.1.20:8080` (a LAN device, container, another server) |
| `@:8080` | the root/apex domain itself |

Run `cloudtunnel` with no arguments and it guides you (port → subdomain → domain). A missing subdomain becomes a random name; a missing host is `localhost`. The local-service protocol is `--proto http|https` (default `http`); replacing an existing DNS record asks first — `-y` to skip, `-f` to also replace a non-tunnel record.

---

## Commands

| Command | What it does |
| --- | --- |
| `login` | Authenticate; resolve account + list your domains. `--status` to inspect. |
| `<spec…>` · `up` | Bring one or more tunnels online. `-d`, `--proto`, `--protocol`, `--detach`, `--service`, `-f`, `-y`. |
| `ls` · `ps` | List tunnels — `# · URL · TARGET · PROTOCOL · STATE · SERVICE · PID`. `--all` scans the whole account. |
| `delete <target…>` | Release tunnel(s) — connector + tunnel + DNS + boot service. `--all`, `--dry-run`, `-f`. |
| `logs <target>` | Show a connector's log. `-f` to follow, `-n` for line count. |
| `relay [sub]` | Expose a locked Cloudflare-API proxy — manage tunnels from behind a CF-API block (see below). |
| `service repair` | Regenerate + restart boot services that are outdated, broken, stopped, or duplicated. `-y`, `--dry-run`. |

A **`<target>`** is a `#` number, a subdomain, a full hostname/URL, or a tunnel-id prefix. `ls --all` also numbers tunnels created elsewhere (or leaked by a failed run); pair with `-f` when they aren't cloudtunnel-managed.

```
$ cloudtunnel ls
┌───┬────────────────────────────┬────────────────────────┬──────────┬───────┬─────────┬───────┐
│ # │ URL                        │ TARGET                 │ PROTOCOL │ STATE │ SERVICE │ PID   │
├───┼────────────────────────────┼────────────────────────┼──────────┼───────┼─────────┼───────┤
│ 1 │ https://api.example.com    │ http://localhost:8080  │ http2    │ up    │ active  │ 48213 │
│ 2 │ https://web.example.com    │ https://localhost:5173 │ auto     │ down  │ -       │ -     │
└───┴────────────────────────────┴────────────────────────┴──────────┴───────┴─────────┴───────┘

$ cloudtunnel delete 1        # release by number
$ cloudtunnel delete --all    # release everything
```

---

## More features

Each is just a flag or subcommand away:

- **Edge transport** — `--protocol auto|http2|quic`. cloudflared uses QUIC (UDP) by default; force `http2` (TCP) on networks that drop idle UDP and cause intermittent 530/502. Shows in the `ls` PROTOCOL column, works with `--detach`/`--service`.
- **Run on boot** — `--service` registers a native OS service **per subdomain** so it comes back after a restart: systemd (Linux, sudo) · launchd (macOS) · Task Scheduler (Windows). The subdomain is baked in, so the URL stays stable; `delete` removes it. After install it waits (≤30s) for each connector and prints `ls`. A service never gives up: it waits for the network at boot, restarts a crashed connector right away, and a restart reuses the existing tunnel + DNS (no churn).
- **Self-healing upgrades** — after `npm i -g` a running service restarts itself onto the new version (Linux/macOS). The first interactive command after an upgrade finds boot services written by an older version (or broken, stopped, duplicated) and offers to repair them in one go; `ls` flags them as `(stale)` / `(broken)` / `(dead)` / `(duplicate)`. Run `cloudtunnel service repair` any time.
- **Background** — `--detach` keeps connectors running after the CLI exits. Release with `delete <target>`, tail with `logs <target> -f`.
- **Behind a proxy** — auto-routes `fetch` through `HTTPS_PROXY`/`HTTP_PROXY` (and, on Linux/GNOME, the system proxy). Set `HTTPS_PROXY` once if needed.

---

## Relay: blocked Cloudflare API

Some networks block `api.cloudflare.com` (used to create tunnels + DNS) but leave `*.your-domain.com` reachable. Run a **relay** on a host that _can_ reach the API, then point the blocked client at it — every `login`/`up`/`ls`/`delete` rides a data-plane tunnel instead of hitting the API directly.

```bash
# On the relay host (API reachable):
cloudtunnel relay cfapi -d you.com            # → https://cfapi.you.com + prints a relay key
                                              #   add --detach / --service to run in background / on boot

# On the blocked client:
cloudtunnel login --relay ctr_XXXXXXXX…       # paste the key + mint a CF token when asked
cloudtunnel up web:8080 -d you.com            # now manages tunnels through the relay
```

The proxy forwards to `api.cloudflare.com` only (no open-proxy / SSRF) and returns `403` to any request missing the shared secret.

**Security:** the relay terminates the tunnel and sees the client's CF token in **plaintext** — only relay through a host **you control**, with a least-privilege token (the four scopes in [Authentication](#authentication)). Env/flag alternatives (`CLOUDTUNNEL_API_BASE`, `CLOUDTUNNEL_RELAY_SECRET`) and `CLOUDTUNNEL_DEBUG=1` request tracing are also supported.

---

## Authentication

`cloudtunnel login` opens the Cloudflare API-tokens page and walks you through **Create Token → Create Custom Token**, then add these scopes (least-privilege — limit the token to the domains you tunnel into):

| Resource | Permission |
| --- | --- |
| Account | Cloudflare Tunnel · **Edit** |
| Account | Account Settings · **Read** |
| Zone | DNS · **Edit** |
| Zone | Zone · **Read** |

Provide the token via (highest precedence first): `CLOUDFLARE_API_TOKEN` env → `cloudtunnel login --token-stdin` → the hidden prompt from `cloudtunnel login`. The token is **never** passed on the command line and is stored `0600`.

---

## Requirements

- **Node.js ≥ 20**
- **`cloudflared`** — auto-installed on first run (pinned version, checksum-verified, cached under `~/.config/cloudtunnel/bin`). A copy already on `PATH` is used instead. On Alpine/musl, Windows-on-ARM, or other unsupported targets, install manually from the [releases page](https://github.com/cloudflare/cloudflared/releases) (or `brew install cloudflared`).

---

## Troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| **HTTP 1016** / subdomain won't load | The connector isn't running (`STATE = down` in `ls`). Bring it back up: `cloudtunnel <spec>`. |
| **`--service` set but `STATE = down`** | Run `cloudtunnel service repair`. Logs: Linux `journalctl -u cloudtunnel-<slug>` · macOS `~/Library/Preferences/cloudtunnel/logs/<slug>.service.log` · Windows `schtasks /Query /TN "cloudtunnel\<slug>" /V`. |
| **"already being served by another cloudtunnel process"** | A boot service owns that hostname — use `ls` / `logs`, or `delete <#>` before running it by hand. |
| **`delete` says "active connections"** | Handled automatically — cloudtunnel cleans up the connections and retries. |
| **"grey-clouded" error** | cfargotunnel routing needs an orange-cloud (proxied) CNAME. |
| **A DNS record already occupies the name** | Pick another subdomain/domain, or pass `-f/--force` to replace a non-tunnel record. |

---

## License

[MIT](LICENSE) © thanhken
