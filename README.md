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

cloudtunnel login     # once — paste a Cloudflare token; account + domain auto-resolved
cloudtunnel 3000      # → https://brave-otter-1a2b.example.com is live ✨
```

---

## ✨ Why cloudtunnel

- 🔗 **Your domains, real subdomains** — routes through native Cloudflare Tunnel to `*.your-domain.com`, not a shared third-party host.
- ⚡ **One command** — `cloudtunnel 3000` creates the tunnel, DNS, and connector, then prints a live HTTPS URL. Zero required flags.
- 🗂️ **Profiles** — save a whole project's services and bring them all up with `cloudtunnel run mb`.
- 🌙 **Background mode** — `--detach` keeps connectors running after you close the terminal.
- 🎯 **Zero-downtime** — `update` hot-reloads the port with no restart.
- 🔒 **Secure by default** — token passed via env (never argv), stored `0600`, destructive ops are ownership-gated and re-verified.

---

## 🚀 Quickstart

```bash
cloudtunnel login                 # authenticate once
cloudtunnel 3000                  # random subdomain → live URL (Ctrl-C stops, URL kept)
cloudtunnel 3000 -s api           # pick the subdomain: api.<your-domain>
cloudtunnel 3000 -s api -d foo.io # pick subdomain + domain
cloudtunnel 3000 --detach         # run in the background
```

A live tunnel looks like this:

```
◇  Connected
│
◇  Live ─────────────────────────────────────────╮
│  https://api.example.com  →  http://localhost:3000
│  Ctrl-C stops the connector — the subdomain is kept
╰─────────────────────────────────────────────────╯
```

---

## 📦 Commands

| Command | What it does |
| --- | --- |
| `cloudtunnel login` | Authenticate; auto-resolve account + default domain. `--status` to inspect. |
| `cloudtunnel <port>` · `up` | Create + serve a subdomain. `-s/--subdomain`, `-d/--domain`, `--detach`, `--ephemeral`, `-f/--force`, `--proto`. |
| `cloudtunnel ls` · `ps` | List subdomains — `ID · SUBDOMAIN · TARGET · STATE · PID`. `--all` scans the whole account. |
| `cloudtunnel logs <id\|name>` | Show a connector's log. `-f` to follow, `-n` for line count. |
| `cloudtunnel update <id\|name> --port <p>` | Repoint to a new port — **zero downtime** (hot-reload). |
| `cloudtunnel rm <id\|name>` · `remove` · `delete` | Delete a subdomain (stops connector, removes tunnel + DNS). `--dry-run`, `-f/--force`. |
| `cloudtunnel down [id\|name] [--all]` | Stop connector(s); keep the tunnel + DNS. |
| `cloudtunnel status <id\|name>` | Tunnel health + connector state. |
| `cloudtunnel gc [--yes]` | Prune crash orphans. |
| `cloudtunnel zones` | List the domains in your account. |
| `cloudtunnel save <profile> <svc…>` | Save a group of services. `svc` = `name:port[:proto]`, or `--from-running`. |
| `cloudtunnel run <profile> [--detach]` | Bring up every service in a profile at once. |
| `cloudtunnel profiles [--rm <name>]` | List saved profiles (or delete one). |

> Targets accept a **full hostname**, a **subdomain name**, or a **tunnel id prefix** (as shown in `ls`).

```
$ cloudtunnel ls
┌──────────────┬─────────────────────┬────────────────────────┬─────────┬───────┐
│ ID           │ SUBDOMAIN           │ TARGET                 │ STATE   │ PID   │
├──────────────┼─────────────────────┼────────────────────────┼─────────┼───────┤
│ 8f3a1c2b4d5e │ api.example.com     │ http://localhost:3000  │ running │ 48213 │
│ 1a2b3c4d5e6f │ web.example.com     │ https://localhost:5173 │ stopped │ -     │
└──────────────┴─────────────────────┴────────────────────────┴─────────┴───────┘
```

---

## 🗂️ Profiles

Expose a whole project's services with one command:

```bash
cloudtunnel save mb api:3000 web:5173:https   # define the group (or: save mb --from-running)
cloudtunnel run mb --detach                    # backend + frontend live in the background
cloudtunnel logs api -f                         # follow one service's log
cloudtunnel down --all                          # stop them all
```

---

## 🌙 Foreground vs background

By default `up` and `run` stay in the **foreground** — the connector lives as long as the terminal is open, and <kbd>Ctrl-C</kbd> stops it (the subdomain is kept; delete it with `rm`).

Add **`--detach`** to run in the **background** — the CLI prints the URL(s) and exits, and the connector keeps running after you close the terminal. Stop them with `cloudtunnel down <id|name>` (or `--all`) and tail output with `cloudtunnel logs <id|name> -f`.

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
  <br/>_(Auto-download is built in and fetches a pinned, SHA256-verified binary, but stays disabled until release checksums are pinned — treat `cloudflared` as a prerequisite for now.)_

---

## 🩺 Troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| **HTTP 1016** / subdomain won't load | The connector isn't running. Start it — `cloudtunnel <port> -s <name>` re-attaches — or check `cloudtunnel status <name>`. |
| **"grey-clouded" error** | The zone couldn't proxy the record; cfargotunnel routing needs an orange-cloud (proxied) CNAME. |
| **Multiple domains, no default** | Pass `-d <domain>`, or set one with `cloudtunnel login --zone <domain>`. |

---

## 📄 License

[MIT](LICENSE) © thanhken
