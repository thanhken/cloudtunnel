<div align="center">

# cloudtunnel

**Expose any local port at a public HTTPS subdomain — on _your own_ Cloudflare domains.**
**CLI · Node API · MCP server for AI agents.**

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
- **Share safely** — `--ttl 2h` links that delete themselves, `--protect alice@x.com` for an email one-time-PIN login in front of the URL.
- **Built for scripts and AI agents** — `--json`, stable exit codes, a Node API and an MCP server (`ctun mcp`).
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
cloudtunnel demo:3000 --ttl 2h             # deletes itself after 2 hours
cloudtunnel admin:8080 --protect me@x.com  # only me@x.com gets in (email one-time PIN)
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
| `<spec…>` · `up` | Bring one or more tunnels online. `-d`, `--proto`, `--protocol`, `--detach`, `--service`, `--ttl`, `--protect`, `--json`, `-f`, `-y`. |
| `ls` · `ps` | List tunnels — `# · URL · TARGET · PROTOCOL · STATE · SERVICE · PID`. `--all` scans the whole account, `--json` for scripts. |
| `delete <target…>` | Release tunnel(s) — connector + tunnel + DNS + boot service. `--all`, `--dry-run`, `-f`. |
| `logs <target>` | Show a connector's log. `-f` to follow, `-n` for line count. |
| `url <target>` | Print a tunnel's public URL — `curl $(ctun url api)`. |
| `mcp` | Run the MCP server on stdio (for Claude Code, Cursor, …) — see [For AI agents](#for-ai-agents). |
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

## Share safely

A tunnel URL is **public** — anyone who has it reaches your service. Two flags narrow that:

- **`--ttl <duration>`** — release the tunnel (and its DNS record) automatically after `30m`, `2h`, `1d` (1m–30d). Works in the foreground and with `--detach` (a small background watcher does the release). It runs on your machine: if the machine is off at the deadline, the next `cloudtunnel` command cleans it up.
- **`--protect <emails>`** — put a [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) login in front of the URL. Visitors enter their email and get a one-time PIN; only listed addresses (`alice@x.com`) or whole domains (`@company.com`) get in. Free on Cloudflare Zero Trust's free plan (up to 50 users).

```bash
cloudtunnel demo:3000 --ttl 2h --protect alice@client.com,@mycompany.com
```

Notes on `--protect`:
- Needs two extra token scopes (see [Authentication](#authentication)) and Cloudflare Zero Trust enabled on the account (one-time, free: [one.dash.cloudflare.com](https://one.dash.cloudflare.com/)).
- It uses the **One-time PIN** login method. If your Zero Trust account already has other login methods (Google, Okta…) and no One-time PIN, cloudtunnel asks before adding it — that is an account-wide setting: Access apps that allow every login method will offer it too.
- Don't protect **webhook receivers** (Stripe, GitHub…) — they can't log in. Use an unguessable subdomain and verify the webhook signature instead.
- `@gmail.com`-style rules let *anyone* with an account there in; cloudtunnel warns about them.
- The Access app is named `cloudtunnel:<hostname>` and is removed together with the tunnel.

---

## For AI agents

cloudtunnel is meant to be driven by scripts and coding agents as well as people.

**MCP server** — give Claude Code (or any MCP client) tunnel tools:

```bash
claude mcp add --transport stdio cloudtunnel --scope user -- npx -y @iamken/cloudtunnel mcp
```

Other clients (Cursor, Windsurf, …): command `npx`, args `["-y", "@iamken/cloudtunnel", "mcp"]`. Run `cloudtunnel login` once first, or pass `CLOUDFLARE_API_TOKEN` in the server's env.

| Tool | Does |
| --- | --- |
| `tunnel_up` | Expose a local port: `{ port, subdomain?, domain?, proto?, ttl?, protect?, replace? }` → the URL |
| `tunnel_list` | List tunnels (and clean up expired / orphaned ones) |
| `tunnel_down` | Release a tunnel this MCP server created |
| `tunnel_logs` | Last lines of a tunnel's connector log |

Guard rails: forwards to **localhost only** (the user can allow LAN hosts with `CLOUDTUNNEL_MCP_ALLOW_REMOTE_HOST=1`; link-local / cloud-metadata addresses are always refused) · never takes over an existing hostname unless `replace: true` · `tunnel_down` only touches tunnels created through MCP · tunnels live as long as the MCP session (use `--detach` / `--service` from the CLI for durable ones).

**Node API** — the same thing from code, no output, errors thrown:

```ts
import { up } from "@iamken/cloudtunnel";

const session = await up("api:3000", { ttl: "1h" });   // also: domain, proto, protect, replace, detach
console.log(session.tunnels[0].url);                   // https://api.example.com
await session.release();                               // tunnel + DNS gone
```

Also exported: `ls()`, `down(target)`, `url(target)`, `CloudtunnelError`, and the `Tunnel` type.

**CLI in scripts** — `--json` prints one JSON document on stdout (progress goes to stderr):

```bash
cloudtunnel api:3000 --detach --ttl 1h --json   # {"schemaVersion":1,"tunnels":[{"url":…,"fqdn":…,"state":…,"expiresAt":…,"protected":…}],"failed":[]}
cloudtunnel ls --json
curl "$(cloudtunnel url api)/health"
```

Exit codes: `0` ok · `1` error · `2` invalid usage · `4` not found / hostname already in use · `130` cancelled.

---

## Compared to

| | cloudtunnel | `cloudflared` alone | ngrok | Tailscale Funnel |
| --- | --- | --- | --- | --- |
| URL on your own domain | ✅ any subdomain | ✅ after manual setup | paid plans | `*.ts.net` only |
| One command to a stable URL | ✅ | quick tunnels: random `trycloudflare.com` URL; named: create tunnel + route DNS + config | ✅ | ✅ |
| Release tunnel + DNS together | ✅ `delete` / Ctrl-C / `--ttl` | manual | n/a | n/a |
| Boot service per URL | ✅ `--service` | ✅ one service per tunnel config | agent service | via tailscaled |
| Login in front of the URL | ✅ `--protect` (email one-time PIN) | configure Cloudflare Access yourself | ✅ (OAuth, IP rules, …) | — (Funnel URLs are public) |
| MCP server / Node API | ✅ / ✅ | — | — / ✅ SDK | — |

cloudtunnel drives the official `cloudflared` connector and the Cloudflare API — it adds the provisioning, cleanup and ergonomics around them.

---

## Authentication

`cloudtunnel login` opens Cloudflare's **Create API token** form with these scopes already selected — check them, optionally limit the token to the domains you tunnel into, create it and paste it back:

| Resource | Permission |
| --- | --- |
| Account | Cloudflare Tunnel · **Edit** |
| Account | Account Settings · **Read** |
| Zone | DNS · **Edit** |
| Zone | Zone · **Read** |

For `--protect`, the token also needs **Account · Access: Apps and Policies · Edit** and **Account · Access: Organizations, Identity Providers, and Groups · Edit**. A token without them keeps working for everything else; `--protect` then fails with a link that opens the token form with all six scopes selected.

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
| **A new subdomain shows another site (your hosting) for a few minutes** | Your zone has a wildcard record (`*.your-domain`) and a DNS resolver cached its answer for the new name. It clears after that record's TTL; meanwhile `dig <host> @1.1.1.1` shows the right answer. |
| **`--protect` says Zero Trust isn't set up / token can't manage Access** | Enable Zero Trust once at [one.dash.cloudflare.com](https://one.dash.cloudflare.com/) (free plan), and add the two Access scopes to your token (see [Authentication](#authentication)). |
| **Cloudflare API errors / timeouts** | Re-run with `CLOUDTUNNEL_DEBUG=1` to trace every API request and its status. |

---

## License

[MIT](LICENSE) © thanhken
