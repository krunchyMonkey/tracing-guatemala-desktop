# HTTPS home network (#167)

## #167 HTTPS through the local reverse proxy

An opt-in way to reach Live from a phone or tablet over **HTTPS**, using a reverse proxy that runs on the same computer (the owner uses Caddy with a Let's Encrypt certificate for `https://tg.krunchymonkey.dev`). The proxy runs on the host, outside the app: its config, launcher and pinned build are in [`deploy/caddy/`](../../deploy/caddy/) and [https-lan-tls.md](https-lan-tls.md) (#166); the private DNS name is [https-lan-dns.md](https-lan-dns.md) (#165).

**Fictional test data only.** The same gate as `--lan-host` applies: the host refuses to start this mode on the default data folder or any folder not marked as a fictional test profile. Real client records stay refused until the HTTPS security review (#168) and the owner's explicit approval. There is no way around the gate.

Never put real LAN addresses, pairing codes, cookies or screenshots showing them into public issues, pull requests or chat. The examples below use made-up values.

### Start

1. Create the test profile once (the folder must not exist yet or be empty):

   ```
   npm run live -- --https-host tg.example.com --data-dir C:\tg-https-test --init-lan-test-profile
   ```

2. Start (later runs leave out `--init-lan-test-profile`):

   ```
   npm run live -- --https-host tg.example.com --data-dir C:\tg-https-test
   ```

   Use your own DNS name instead of `tg.example.com`. The window prints the private launch link (open it on this computer only) and the HTTPS address.
3. Point the reverse proxy at **`127.0.0.1:<port + 2>`**. With the default Live port 4180 that is `127.0.0.1:4182` (4181 is the demo). In Caddy this is `reverse_proxy 127.0.0.1:4182`. Nothing else should be proxied to the Live port 4180 itself: that listener answers 421 to the proxy's Host.
4. Open Settings on this computer, create a pairing code, and enter it on the device at `https://tg.example.com/`.

It is a command-line flag only. No environment variable switches it on, and it never starts by itself. `--https-host` and `--lan-host` cannot be used together (nothing is started), and `--lan-demo-name` needs `--lan-host`, so there is no LAN demo in this mode.

### What the host checks

- The extra listener binds **`127.0.0.1` only**, never a LAN or wildcard address, on the Live port + 2. If that port is busy, everything is closed and the window says so.
- `Host` must equal the bare name (`tg.example.com`; browsers omit `:443`). Any other Host, including `127.0.0.1:<port + 2>`, gets `421`.
- Writes need `Origin: https://tg.example.com`. Cookies are `HttpOnly; SameSite=Strict; Secure` with no `Domain`.
- Paired devices behave exactly as on the home network (#136): per-device session, CSRF token, host-only calls and backups refused, `/launch` is 404, restore is disabled while the mode is on.
- **The host never reads or trusts `Forwarded`, `X-Forwarded-*` or `X-Real-IP`.** The scheme, name and origin come from the configured name. The proxy is trusted only because it is the thing that can reach a loopback port. Any other process of the same OS user can reach that port too and could send the right Host header; loopback is not user isolation (see the note in `src/server/access.ts`).
- "Turn off home-network access" in Settings closes this listener and signs every device out.

### Rollback

Stop the window and start again without `--https-host`. Nothing else is changed; the proxy then gets connection errors, which is fine. Remove or disable the proxy site if you no longer want the name to answer.

### Not done yet

- Real-data enablement and further session hardening for the HTTPS name (the name is publicly registered but resolves only on the home network): **#168**, after the owner's approval.
- Validation on real devices: **#169**.
- Making the proxy reachable from the home network (binding it to a LAN address, firewall rules, router and DNS) is a host step outside this repository. Never forward router ports to this computer.
