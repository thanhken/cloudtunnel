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

> 💨 Prefer less typing? **`ctun`** is a built-in short alias — `ctun 3000`, `ctun ls`, `ctun down 1`.

---

## ✨ Why cloudtunnel

- 🔗 **Your domains, real subdomains** — routes through native Cloudflare Tunnel to `*.your-domain.com`, not a shared third-party host.
- ⚡ **One command** — `cloudtunnel 3000` creates the tunnel, DNS, and connector, then prints a live HTTPS URL. It even asks you which domain + subdomain to use.
- 🧭 **Just two states** — `up` brings a subdomain online; `down` (or Ctrl-C) releases it (deletes the tunnel + DNS). Re-running `up` always starts clean — no leftovers, no conflicts.
- 🗂️ **Profiles** — save a whole project's services and bring them all up with `cloudtunnel run mb`.
- 🌙 **Background mode** — `--detach` keeps connectors running after you close the terminal.
- 🔒 **Secure by default** — token passed via env (never argv), stored `0600`, destructive ops are ownership-gated and re-verified.

---

## 🚀 Quickstart

```bash
cloudtunnel login                 # authenticate once
cloudtunnel 3000                  # asks for domain + subdomain, then goes live
cloudtunnel 3000 -s api           # skip the prompts: api.<your-domain>
cloudtunnel 3000 -s api -d foo.io # subdomain + domain
cloudtunnel 3000 -s @             # the root domain itself (example.com)
cloudtunnel 3000 --source 192.168.1.5 # forward to another host/IP (IPv4/IPv6), not localhost
cloudtunnel 3000 --detach         # run in the background
```

> Replacing an existing DNS record asks for confirmation first — pass `-y` to skip, or `-f` to also replace a non-tunnel record.

Run `cloudtunnel 3000` with no flags and it guides you:

```
┌  cloudtunnel
◇  Choose a domain
│  ● example.com   ○ foo.io
◇  Subdomain
│  api            (leave blank for a random name)
◇  Connected
│
◇  Live ─────────────────────────────────────────╮
│  https://api.example.com  →  http://localhost:3000
│  Ctrl-C stops and releases this subdomain
╰─────────────────────────────────────────────────╯
```

---

## 📦 Commands

| Command | What it does |
| --- | --- |
| `cloudtunnel login` | Authenticate; resolve account + list your domains. `--status` to inspect. |
| `cloudtunnel <port>` · `up` | Bring a subdomain online. `-s/--subdomain`, `-d/--domain`, `--source`, `--detach`, `-f/--force`, `--proto`, `--protocol`. |
| `cloudtunnel ls` · `ps` | List subdomains — `# · SUBDOMAIN · TARGET · STATE · PID`. `--all` scans the whole account. |
| `cloudtunnel down <target>` · `rm` · `stop` | Release a subdomain — stop connector + delete tunnel + DNS. `--all`, `--dry-run`, `-f`. |
| `cloudtunnel logs <target>` | Show a connector's log. `-f` to follow, `-n` for line count. |
| `cloudtunnel zones` | List the domains in your account. |
| `cloudtunnel save <profile> <svc…>` | Save a group of services. `svc` = `name:port[:proto][@host]`, `-d/--domain`, `--protocol`, or `--from-running`. |
| `cloudtunnel run <profile> [--detach]` | Bring up every service in a profile at once. `--protocol` overrides the saved transport. |
| `cloudtunnel profiles [--rm <name>]` | List saved profiles — `PROFILE · SERVICES · DOMAIN · PROTOCOL · SERVICE`. |
| `cloudtunnel service enable\|disable\|status <profile>` | Register a profile as a systemd boot service (Linux, needs sudo). |

> A **`<target>`** is a `#` number, a subdomain name, a full hostname, or a tunnel-id prefix — all shown in `ls`. `down` also accepts `rm` / `remove` / `delete` / `stop`.

```
$ cloudtunnel ls
┌───┬─────────────────────┬────────────────────────┬───────┬───────┐
│ # │ SUBDOMAIN           │ TARGET                 │ STATE │ PID   │
├───┼─────────────────────┼────────────────────────┼───────┼───────┤
│ 1 │ api.example.com     │ http://localhost:3000  │ up    │ 48213 │
│ 2 │ web.example.com     │ https://localhost:5173 │ down  │ -     │
└───┴─────────────────────┴────────────────────────┴───────┴───────┘

$ cloudtunnel down 1        # release by number
$ cloudtunnel down --all    # release everything
```

---

## 🗂️ Profiles

Expose a whole project's services with one command:

```bash
cloudtunnel save mb api:3000 web:5173:https   # define the group (or: save mb --from-running)
cloudtunnel save mb api:3000@192.168.1.5      # forward a service to another host/IP
cloudtunnel run mb --detach                    # backend + frontend live in the background
cloudtunnel logs api -f                         # follow one service's log
cloudtunnel down --all                          # release them all
```

---

## 🚄 Edge transport (`--protocol`)

cloudflared connects to Cloudflare over **QUIC** (UDP) by default — fastest, but
some networks drop idle UDP sessions, which surfaces as intermittent **530/502**
errors. Force **`http2`** (TCP) there:

```bash
cloudtunnel up 8080 --protocol http2
cloudtunnel save mb api:3000 web:5173 --protocol http2   # persist per profile
cloudtunnel run mb --protocol http2                       # or override per run
```

Values: `auto` (default) · `http2` · `quic`.

---

## 🔁 Run on boot (systemd service)

Register a profile as a **system service** so it comes up automatically after a
reboot (Linux + systemd; installs to `/etc/systemd/system`, so it needs sudo):

```bash
cloudtunnel service enable mb --protocol http2   # install + enable + start now
cloudtunnel service status mb                     # active | enabled | disabled | none
cloudtunnel service disable mb                     # stop + disable + remove
```

The `SERVICE` column in `cloudtunnel profiles` shows each profile's current state.

---

## 🧭 Two states: up & down

There are only two states. **`up`** brings a subdomain online (creating the tunnel + DNS). **`down`** — or pressing <kbd>Ctrl-C</kbd> in a foreground `up` — **releases** it: it stops the connector and deletes the tunnel + DNS on Cloudflare. Running `up` again recreates it cleanly (any leftover tunnel record for that name is cleaned up first, so you never hit conflicts).

Add **`--detach`** to keep a connector running in the **background** after the CLI exits (and after you close the terminal). Release it later with `cloudtunnel down <target>` (or `--all`) and tail its output with `cloudtunnel logs <target> -f`.

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
| **HTTP 1016** / subdomain won't load | The connector isn't running (`STATE = down` in `ls`). Bring it back up: `cloudtunnel <port> -s <name>`. |
| **`down` says "active connections"** | Handled automatically — cloudtunnel cleans up the connections and retries the delete. |
| **"grey-clouded" error** | The zone couldn't proxy the record; cfargotunnel routing needs an orange-cloud (proxied) CNAME. |
| **A DNS record already occupies the name** | Pick another `-s`/`-d`, or pass `-f/--force` to replace a non-tunnel record. |

---

## 📄 License

[MIT](LICENSE) © thanhken
