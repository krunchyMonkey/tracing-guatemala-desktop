# HTTPS home-network Live: certificates with DNS-01 (#166)

Part of Phase 2.6 ([#139](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/139)). The domain and private DNS are in [https-lan-dns.md](https-lan-dns.md) (#165). The Live host side of the reverse proxy is #167.

A small reverse proxy, **Caddy**, holds a publicly trusted Let's Encrypt certificate for `tg.krunchymonkey.dev`. It proves control of the name with a temporary DNS TXT record at Cloudflare (**ACME DNS-01**), so no port is ever opened to the internet: no HTTP-01, no TLS-ALPN-01, no router forwarding. The Live host stays on `127.0.0.1`; Caddy forwards to it over loopback.

The files are in [`deploy/caddy/`](../../deploy/caddy/):

| File | Purpose |
| --- | --- |
| `build-caddy.ps1` | Reproducible build: pinned Go (SHA-256 checked), xcaddy, Caddy and `caddy-dns/cloudflare`. No administrator rights. Stock Caddy has no DNS providers. |
| `Caddyfile` | Portable config. Every host-specific value is a parameter; the token is read at run time. |
| `start-tg-caddy.ps1` | Launcher. Loads the token from a host-only folder into Caddy's process only. |

Pinned versions (2026-10-30): Go 1.27.3, xcaddy v0.4.7, Caddy v2.11.7, caddy-dns/cloudflare v0.2.4. Change them only together with a staging run.

## Host layout (outside the repository)

```
<tg-https>\                 e.g. C:\Users\<you>\tg-https
  bin\caddy.exe             build-caddy.ps1 -Root <tg-https>
  config\Caddyfile          copy of deploy/caddy/Caddyfile
  start-tg-caddy.ps1        copy of deploy/caddy/start-tg-caddy.ps1
  data\                     certificates, private keys, ACME account (restricted ACL)
  logs\caddy.log
<secret folder>\<one>.txt   the Cloudflare API token, nothing else (restricted ACL)
```

## The API token

- Created by the owner in Cloudflare (My Profile → API Tokens), **scoped to the single zone** `krunchymonkey.dev`, permissions **Zone → DNS → Edit** and **Zone → Zone → Read**. Never the Global API Key.
- Stored as the **only** `.txt` file in a folder outside every repository. The launcher refuses to start if there are zero or several `.txt` files.
- The folder and file are restricted to the owner's account, SYSTEM and Administrators (inheritance removed). The launcher refuses to start if Everyone, Authenticated Users or Users can read either.
- It reaches Caddy only as the `CLOUDFLARE_API_TOKEN` environment variable of the Caddy process, and is removed when Caddy stops. The Caddyfile uses the run-time placeholder `{env.CLOUDFLARE_API_TOKEN}`, so the token never appears in Caddy's adapted JSON config or its admin API (tested with the real binary).
- Never paste it into chat, issues, PRs, screenshots, logs or browser code. The Live (Node) app never sees it.

Restricting the folder (PowerShell, as the owner):

```
icacls <secret folder> /inheritance:r /grant:r "$env:USERDOMAIN\$env:USERNAME:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
icacls <tg-https>\data   /inheritance:r /grant:r "$env:USERDOMAIN\$env:USERNAME:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
```

Rotating or revoking: roll the token in Cloudflare, replace the file, restart Caddy. The existing certificate keeps working until it expires; only the next renewal needs the new token.

## Running

```
pwsh -File <tg-https>\start-tg-caddy.ps1 -SecretDir <secret folder> -Validate   # parse only
pwsh -File <tg-https>\start-tg-caddy.ps1 -SecretDir <secret folder> -Staging    # Let's Encrypt staging
pwsh -File <tg-https>\start-tg-caddy.ps1 -SecretDir <secret folder>             # production
```

Parameters: `-Hostname` (default `tg.krunchymonkey.dev`), `-BindHost` (default `127.0.0.1`), `-HttpsPort` (443), `-Upstream` (default `127.0.0.1:4182`, the #167 proxy listener). Always try a change with `-Staging` first: staging has generous rate limits and untrusted certificates.

**Binding a home-network address** (`-BindHost <private IPv4>`) exposes Caddy to the LAN. Do that only with the #167 proxy mode, a Windows Firewall rule limited to the home subnet on the Private profile, and the Phase 2.6 approval gates. The default is loopback.

## Verified on the host (2026-10-30)

| Check | Result |
| --- | --- |
| Token wrong permission (DNS Read only) | Cloudflare `403 Authentication error (10000)` on the TXT create; Caddy logs "will retry", serves **no** certificate, opens no HTTP port. Fails closed. |
| Staging issuance | DNS-01 authorization `valid`, certificate obtained. |
| Production issuance | DNS-01 authorization `valid`, certificate obtained in about 2 s. |
| Certificate | `CN=tg.krunchymonkey.dev`, SAN `tg.krunchymonkey.dev` only, issuer Let's Encrypt (YE2) → ISRG Root X1, ECC key, valid 2026-10-30 → 2027-01-28. Windows Schannel (`curl`) and .NET chain build: trusted, `ssl_verify_result=0`. |
| Wrong SNI (`other.krunchymonkey.dev` → 127.0.0.1) | TLS handshake fails; no certificate is offered. |
| Listeners | `127.0.0.1:443` and the admin API `127.0.0.1:2019` only. Nothing on `:80`, nothing on a LAN or wildcard address. |
| TXT clean-up | `_acme-challenge.tg.krunchymonkey.dev` is NXDOMAIN afterwards. |
| Secret hygiene | The token string occurs in no file under `<tg-https>` (logs, config, data) and in no tracked repository file. |
| Upstream | Caddy reached the Live host on loopback, which answered `421 bad-host` because the hostname is not its own until #167. Correct. |

## Renewal

- Caddy renews automatically **while it is running**: it checks every few minutes and renews when about one third of the lifetime remains (for this 90-day certificate, from roughly 2026-12-29), or earlier if Let's Encrypt's renewal information (ARI) asks. Renewal uses the same DNS-01 path and token.
- If renewal fails, Caddy keeps serving the current certificate and retries with backoff. If it is still failing at expiry, browsers refuse the connection (`.dev` is HSTS-preloaded, so there is no click-through). It never falls back to HTTP.
- **Not yet verified end to end:** an actual renewal. Caddy currently runs only while started by hand. Before relying on HTTPS, run it persistently (a Windows service or a Scheduled Task at logon, an owner decision) and record the first renewal date from `logs\caddy.log` ("certificate obtained successfully" with a new `notBefore`).
- Check the current expiry: `curl.exe -vI --resolve tg.krunchymonkey.dev:443:127.0.0.1 https://tg.krunchymonkey.dev/` and read "expire date".

## Rate limits and recovery

- Let's Encrypt production: 5 certificates per week for the same name; 50 per registered domain per week; 5 failed validations per hour per account and name. Experiment with `-Staging`.
- DNS propagation: Caddy waits up to 5 minutes, checking `1.1.1.1`/`1.0.0.1`. Cloudflare usually propagates in seconds.
- Certificates, keys and the ACME account live in `<tg-https>\data`. Back it up only to storage with the same restrictions; losing it simply means a new issuance (mind the rate limits). Never commit or upload it.
- Cloudflare outage or revoked token: no renewal until fixed; the current certificate keeps working until expiry.
- Safe fallback when ACME or Caddy fails: stop Caddy. Live remains on `http://127.0.0.1:4180` on the host computer only. Nothing becomes plaintext on the network.

## Moving to another computer

Build or copy `bin\caddy.exe`, copy `config\Caddyfile` and the launcher, place the token in a new restricted folder, start with `-Staging` once, then production. Optionally copy `data\` (restricted) to reuse the certificate. Point the private DNS record at the new computer (#165). The domain, hostname and token stay the same.

## Tests

`tests/unit/caddy-config.test.ts` checks the Caddyfile (DNS-01 only, run-time token placeholder, public resolvers, loopback defaults, no LAN addresses or token-shaped strings), the pinned build inputs, and that the launcher refuses zero, several or world-readable token files without echoing their contents. With `TG_CADDY_BIN=<path to caddy.exe>` it also adapts the real Caddyfile and asserts the token is absent from the JSON, the only listener is `127.0.0.1:443` and only the Cloudflare DNS challenge is enabled.
