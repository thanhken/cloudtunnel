<div align="center">

# ⛅ cloudtunnel

**Expose any local port at a public HTTPS subdomain — on _your own_ Cloudflare domains.**

Instant, self-owned tunnel sharing — the tunnel and DNS live in **your** Cloudflare account, so you keep clean, stable URLs and full control.

[![npm version](https://img.shields.io/npm/v/@iamken/cloudtunnel?color=cb3837&logo=npm&style=flat-square)](https://www.npmjs.com/package/@iamken/cloudtunnel)
[![CI](https://img.shields.io/github/actions/workflow/status/thanhken/cloudtunnel/ci.yml?branch=main&label=CI&logo=github&style=flat-square)](https://github.com/thanhken/cloudtunnel/actions)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](#-license)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen?style=flat-square&logo=node.js)](#-requirements)

</div>

```bash
npm i -g @iamken/cloudtunnel

cloudtunnel login      # once — paste a Cloudflare token; account + domain auto-resolved
cloudtunnel 8080       # → https://brave-otter-1a2b.example.com is live ✨
```

> 💨 Prefer less typing? **`ctun`** is a built-in short alias — `ctun 8080`, `ctun ls`, `ctun delete 1`.

---

## ✨ Why cloudtunnel

- 🔗 **Your domains, real subdomains** — routes through native Cloudflare Tunnel to `*.your-domain.com`, not a shared third-party host.
- ⚡ **One command, one or many** — `cloudtunnel api:8080 web:5173` brings up several tunnels at once, each a live HTTPS URL.
- 🎯 **Spec-driven** — a tunnel is just `[subdomain:]port[@host]`. No profiles to define, nothing to save.
- 🧭 **Two states** — `up` brings subdomains online; `delete` (or Ctrl-C) releases them (removes the tunnel + DNS). Re-running `up` always starts clean.
- 🌙 **Background & boot** — `--detach` keeps connectors running after you close the terminal; `--service` registers a native OS service (systemd · launchd · Task Scheduler) that survives restarts.
- 🔒 **Secure by default** — token passed via env (never argv), stored `0600`, destructive ops are ownership-gated and re-verified.

---

## 🚀 Quickstart

```bash
cloudtunnel login                          # authenticate once
cloudtunnel 8080                           # asks for a subdomain (+ domain), then goes live
cloudtunnel api:8080                       # api.<your-domain> → localhost:8080
cloudtunnel api:8080@192.168.1.20          # forward to another host/IP (IPv4/IPv6)
cloudtunnel api:8080 web:5173 -d foo.io    # several tunnels at once, under foo.io
cloudtunnel api:8080 --detach              # run in the background
cloudtunnel api:8080 --service             # register a boot service (Linux/macOS/Windows)
```

A **spec** is `[subdomain:]port[@host]`:

| Spec | Means |
| --- | --- |
| `8080` | random subdomain → `localhost:8080` |
| `api:8080` | `api.<domain>` → `localhost:8080` |
| `api:8080@192.168.1.20` | `api.<domain>` → `192.168.1.20:8080` (a LAN device, container, another server) |
| `@:8080` | the root/apex domain itself |

Run `cloudtunnel` with no arguments and it guides you (port → subdomain → domain). A missing subdomain becomes a friendly random name; a missing host is `localhost`. The local-service protocol is `--proto http|https` (default `http`); replacing an existing DNS record asks first — pass `-y` to skip, `-f` to also replace a non-tunnel record.

---

## 📦 Commands

| Command | What it does |
| --- | --- |
| `cloudtunnel login` | Authenticate; resolve account + list your domains. `--status` to inspect. |
| `cloudtunnel <spec…>` · `up` | Bring one or more tunnels online. `-d/--domain`, `--proto`, `--protocol`, `--detach`, `--service`, `-f/--force`, `-y/--yes`. |
| `cloudtunnel ls` · `ps` | List tunnels — `# · URL · TARGET · STATE · SERVICE · PID`. `--all` scans the whole account. |
| `cloudtunnel delete <target…>` | Release tunnel(s) — stop connector + delete tunnel + DNS + any boot service. `--all`, `--dry-run`, `-f`. |
| `cloudtunnel logs <target>` | Show a connector's log. `-f` to follow, `-n` for line count. |

> A **`<target>`** is a `#` number, a subdomain name, a full hostname/URL, or a tunnel-id prefix — all shown in `ls`.

```
$ cloudtunnel ls
┌───┬────────────────────────────┬────────────────────────┬───────┬─────────┬───────┐
│ # │ URL                        │ TARGET                 │ STATE │ SERVICE │ PID   │
├───┼────────────────────────────┼────────────────────────┼───────┼─────────┼───────┤
│ 1 │ https://api.example.com    │ http://localhost:8080  │ up    │ active  │ 48213 │
│ 2 │ https://web.example.com    │ https://localhost:5173 │ down  │ -       │ -     │
└───┴────────────────────────────┴────────────────────────┴───────┴─────────┴───────┘

$ cloudtunnel delete 1        # release by number
$ cloudtunnel delete --all    # release everything
```

---

## 🚄 Edge transport (`--protocol`)

cloudflared connects to Cloudflare over **QUIC** (UDP) by default — fastest, but
some networks drop idle UDP sessions, which surfaces as intermittent **530/502**
errors. Force **`http2`** (TCP) there:

```bash
cloudtunnel up 8080 --protocol http2
```

Values: `auto` (default) · `http2` · `quic`.

---

## 🔁 Run on boot (`--service`)

Add **`--service`** to register each subdomain as a native OS service so it comes
back automatically — cross-platform:

| OS | Backend | Autostart | Privilege |
| --- | --- | --- | --- |
| Linux | systemd unit (`/etc/systemd/system`) | boot | sudo |
| macOS | launchd LaunchAgent (`~/Library/LaunchAgents`) | login | none |
| Windows | Task Scheduler (`cloudtunnel\<name>`) | logon | none |

```bash
cloudtunnel api:8080 --service --protocol http2   # install + enable + start now
cloudtunnel api:8080 web:5173 --service           # one service per subdomain
cloudtunnel ls                                     # the SERVICE column shows each one's state
cloudtunnel delete api                             # stops + removes the tunnel and its service
```

Each subdomain gets its own service, so deleting one never touches the others.
The concrete subdomain is baked in, so the URL stays stable across restarts. All
backends restart the connector on failure.

After installing, `--service` waits for each service to bring its connector up
(up to 20s) and prints the `ls` view, so the tunnels show in `cloudtunnel ls`/`ps`
right away. A service that doesn't report up in time is flagged with where to read
its logs (e.g. it failed to start, or resolved a different config dir).

---

## 🧭 Two states: up & delete

There are only two states. **`up`** brings subdomains online (creating the tunnel
+ DNS). **`delete`** — or pressing <kbd>Ctrl-C</kbd> in a foreground `up` —
**releases** them: it stops the connector and deletes the tunnel + DNS on
Cloudflare (and any `--service` unit). Running `up` again recreates cleanly (any
leftover tunnel record for that name is cleaned up first, so you never hit conflicts).

Add **`--detach`** to keep connectors running in the **background** after the CLI
exits. Release them later with `cloudtunnel delete <target>` (or `--all`) and tail
their output with `cloudtunnel logs <target> -f`.

---

## 🔑 Authentication

Create a **Cloudflare API token** with these scopes (least-privilege — a token limited to the domains you tunnel into is recommended):

| Resource | Permission |
| --- | --- |
| Account | Cloudflare Tunnel · **Edit** |
| Account | Account Settings · **Read** |
| Zone | DNS · **Edit** |
| Zone | Zone · **Read** |

Provide it via (highest precedence first): `CLOUDFLARE_API_TOKEN` env → `cloudtunnel login --token-stdin` → the hidden prompt from `cloudtunnel login`.

> 🔒 The token is **never** passed on the command line (that would leak into `ps` / shell history) and is stored `0600`. Rotate it if a shared host is compromised.

---

## ✅ Requirements

- **Node.js ≥ 20**
- **`cloudflared`** on your `PATH` — install via `brew install cloudflared`, your package manager, or the [releases page](https://github.com/cloudflare/cloudflared/releases).

---

## 🧳 Upgrading from 0.3.x (profiles removed)

`save`, `run`, `profiles`, `zones`, and the `service …` sub-commands are gone —
everything is now inline specs on `up`, and reads live in `ls`:

| Old | New |
| --- | --- |
| `run mb` | `cloudtunnel api:8080 web:5173` (pass the specs directly) |
| `service enable mb --protocol http2` | `cloudtunnel <spec…> --service --protocol http2` |
| `service disable mb` / `profiles --rm mb` | `cloudtunnel delete <target>` |
| `service status` / `profiles` | `cloudtunnel ls` (SERVICE column) |
| `zones` | `cloudtunnel login --status` (also a ZONE in each `ls` URL) |
| `down <t>` / `rm <t>` | `cloudtunnel delete <t>` |

Profiles that were registered as boot services are **migrated automatically** to
the new per-subdomain units the first time you run cloudtunnel in a terminal.

---

## 🩺 Troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| **HTTP 1016** / subdomain won't load | The connector isn't running (`STATE = down` in `ls`). Bring it back up: `cloudtunnel <spec>`. |
| **`delete` says "active connections"** | Handled automatically — cloudtunnel cleans up the connections and retries the delete. |
| **"grey-clouded" error** | The zone couldn't proxy the record; cfargotunnel routing needs an orange-cloud (proxied) CNAME. |
| **A DNS record already occupies the name** | Pick another subdomain/domain, or pass `-f/--force` to replace a non-tunnel record. |

---

## 📄 License

[MIT](LICENSE) © thanhken
