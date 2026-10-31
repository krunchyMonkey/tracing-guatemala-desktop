# HTTPS home-network Live: domain and private DNS (#165)

Part of Phase 2.6 ([#139](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/139)). This page covers the registered domain and how household devices find the Live host. Certificates are [#166](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/166) and the reverse proxy is [#167](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/167).

A registered domain does **not** make Tracing Guatemala public. The domain is used for two things only:

1. a **trusted certificate** for one hostname, proven through a temporary DNS TXT record (ACME DNS-01), and
2. a **private DNS answer** on the home network that points that hostname at the host computer's private address.

Nobody outside the home network can resolve the hostname to anything, so there is nothing to connect to.

Never put LAN IP addresses, router screenshots, registrar or Cloudflare account details, or API tokens into public issues, pull requests or chat. Use made-up values such as `192.168.1.20` in anything shared.

## Owner-selected names

| What | Value |
| --- | --- |
| Registered domain | `krunchymonkey.dev` (Cloudflare Registrar, Cloudflare DNS) |
| Live hostname | `tg.krunchymonkey.dev` |
| Fictional demo | stays on a **different site**, for example `tg-demo.home.arpa`, never `demo.krunchymonkey.dev` (sibling subdomains are the same site for cookies) |

`.dev` is on the browser HSTS preload list: browsers only ever open `https://` for any `.dev` name. The hostname works only once HTTPS is set up.

## Verified facts (2026-10-30)

Checked from the host with public resolvers. Nothing here needed a secret.

| Check | Result |
| --- | --- |
| Authoritative nameservers for `krunchymonkey.dev` | Cloudflare (`*.ns.cloudflare.com`) |
| Zone reachable with a zone-scoped API token | yes: the token sees exactly one zone, status Active |
| Public A / AAAA / CNAME for `tg.krunchymonkey.dev` (1.1.1.1 and 8.8.8.8) | none (NXDOMAIN) |
| Public A for the apex | none |
| DNS-01 TXT record create and clean-up at Cloudflare | works: Let's Encrypt staging and production orders validated; `_acme-challenge.tg.krunchymonkey.dev` is gone afterwards (NXDOMAIN) |
| Certificate Transparency | the name `tg.krunchymonkey.dev` is now in public CT logs. Expected and harmless: it reveals the name only, never an address or data. Keep client names out of hostnames. |

**Not yet verified** (owner, on the Cloudflare dashboard and on devices): see the checklist below.

## Design: split-horizon DNS

| Resolver | Answer for `tg.krunchymonkey.dev` |
| --- | --- |
| Public internet (Cloudflare authoritative) | **no address** (NXDOMAIN). Only short-lived `_acme-challenge` TXT records appear during certificate issuance. |
| Home network (router override or local resolver) | the host computer's **private IPv4** (RFC 1918), A record only |

Rules:

- **No public A/AAAA/CNAME** for the Live hostname, no Cloudflare orange-cloud proxy, no Cloudflare Tunnel, no dynamic DNS, no router port forwarding, no UPnP.
- **Rejected alternative: a public A record pointing at the private address.** It looks simpler, but it publishes the home network layout, many routers block it as DNS rebinding, and it makes the name resolve off-network.
- **IPv4 only.** Do not add an AAAA override. If a device asks for AAAA it gets nothing, so it uses the IPv4 answer or fails.
- **Fail closed off-network.** On mobile data, guest Wi-Fi, a VPN, or with browser/OS encrypted DNS (DNS-over-HTTPS, iCloud Private Relay) the device asks a public resolver, gets NXDOMAIN and cannot connect. That is the intended behaviour, not a bug.
- **Certificate checks use public resolvers.** The certificate tool (#166) checks DNS-01 propagation with `1.1.1.1`/`1.0.0.1`, so the private override can never hide the challenge record.

## Choosing the home-network resolver

The household uses TP-Link Deco mesh hardware. Check the exact model and firmware in the Deco app before choosing; do not assume a feature exists.

1. **Router override (preferred if supported).** Some routers allow a custom local DNS record ("host override", "local DNS", "static DNS"). If the Deco firmware offers it, add one A record `tg.krunchymonkey.dev` → host private IPv4.
2. **Small local resolver (fallback).** Run AdGuard Home or Pi-hole on an always-on device (not the laptop, which sleeps), add the same single A record as a local rewrite, forward everything else to the usual upstream, and set that resolver as the DNS server the Deco hands out over DHCP. Keep its admin page on the LAN only.
3. **Per-device hosts file (testing only).** Works on Windows/macOS/Linux, not on iPhone/iPad or most Android devices. Fine for a first check on the host itself; not a household solution.

Whichever is used, also give the host computer a **DHCP reservation** so its private address does not change.

## Owner checklist

Dashboard (do not paste screenshots, payment or login details anywhere public):

- [ ] Cloudflare → Domain Registration → Manage Domains: `krunchymonkey.dev` **Active**, registrant email verified, **auto-renew on**, registrar lock on.
- [ ] Cloudflare account: MFA on, recovery codes stored offline.
- [ ] Cloudflare DNS for the zone: **no** A/AAAA/CNAME for `tg`; no proxied (orange-cloud) record; no Tunnel.
- [ ] API token used for certificates: scoped to **this zone only**, permissions **Zone → DNS → Edit** and **Zone → Zone → Read**, nothing else. Stored only on the host (see #166).

Home network:

- [ ] Deco model/firmware checked; resolver option chosen (router override or local resolver).
- [ ] DHCP reservation for the host computer.
- [ ] A record `tg.krunchymonkey.dev` → host private IPv4 added on the home resolver. No AAAA.
- [ ] On **two household devices** on home Wi-Fi: `nslookup tg.krunchymonkey.dev` returns the private address.
- [ ] On one device on **mobile data** (Wi-Fi off): the name does not resolve.
- [ ] `nslookup tg.krunchymonkey.dev 1.1.1.1` from home returns NXDOMAIN.
- [ ] Note which devices use encrypted DNS / Private Relay and therefore cannot reach Live (expected).

## When things change

| Change | What to do |
| --- | --- |
| Host gets a new private address | Update the reservation and the one A record. Certificates are unaffected (they name the hostname, not the address). |
| Moving Live to another computer | Same domain and hostname: install the reverse proxy and token on the new computer (#166), point the A record at the new computer, stop the old one. No registrar change. |
| New router / resolver | Recreate the single A record; re-run the device checks above. |
| A device cannot resolve the name at home | Check that it uses the home resolver (not DoH / Private Relay / a VPN); flush its DNS cache (Windows `ipconfig /flushdns`; reconnect Wi-Fi on phones). |
| Roll back | Remove the private A record. Live is then reachable only on the host itself (`npm run live`, `127.0.0.1`). |

## Status

#165 stays **open** until the owner checklist above is complete, including the two-device check. Registration of the domain is a separate fact from the security approval of real-data use (#168, #169).
