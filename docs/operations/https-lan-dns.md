# HTTPS home-network Live: domain and DNS (#165)

Part of Phase 2.6 ([#139](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/139)). This page covers the registered domain and how household devices find the Live host. Certificates are [#166](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/166) and the reverse proxy is [#167](https://github.com/krunchyMonkey/tracing-guatemala-desktop/issues/167).

A registered domain does **not** make Tracing Guatemala public. The domain is used for two things only:

1. a **trusted certificate** for one hostname, proven through a temporary DNS TXT record (ACME DNS-01), and
2. a **DNS answer** that points that hostname at the host computer's **private** (RFC 1918) address.

A private address cannot be routed on the internet and nothing is forwarded to the host, so nobody outside the home network can connect, even though they can look the name up.

Never put router screenshots, registrar or Cloudflare account details, or API tokens into public issues, pull requests or chat. Avoid repeating the host's LAN address in GitHub; use made-up values such as `192.168.1.20` in examples.

## Owner-selected names

| What | Value |
| --- | --- |
| Registered domain | `krunchymonkey.dev` (Cloudflare Registrar, Cloudflare DNS) |
| Live hostname | `tg.krunchymonkey.dev` |
| Fictional demo | stays on a **different site**, for example `tg-demo.home.arpa`, never `demo.krunchymonkey.dev` (sibling subdomains are the same site for cookies) |

`.dev` is on the browser HSTS preload list: browsers only ever open `https://` for any `.dev` name. The hostname works only once HTTPS is set up.

## Current design (owner decision 2026-10-31): public "DNS only" A record to the private address

The original design (below, kept as an alternative) answered the name only inside the home network. In the fictional pilot that proved brittle: neither the TP-Link Deco nor the Linksys router in front of it supports a custom local DNS record, per-device DNS settings were ignored by a company-managed laptop, and iCloud Private Relay or browser secure DNS bypass local resolvers. The owner therefore chose to publish **one** record:

| Cloudflare record | Value |
| --- | --- |
| Type / name | `A` / `tg` |
| Content | the host computer's private IPv4 (RFC 1918) |
| Proxy status | **DNS only (grey cloud)**. Never proxied (orange), never a Tunnel. |
| AAAA | **none** |

Effects:

- Every device on the home Wi-Fi resolves the name with no per-device setup; Private Relay and secure DNS no longer interfere. No resolver needs to run on the host.
- **Public:** anyone can see that the name points to one private address on a common home subnet. The hostname was already public through Certificate Transparency logs.
- **Not reachable from outside:** the address is private, there is no router port forwarding, UPnP mapping, proxy or tunnel. Off the home network a device tries that private address on whatever network it is on; nothing there can present a valid certificate for the name, and HSTS stops the browser before it sends anything.
- **Address changes break it:** keep a DHCP reservation for the host and update the record if the address ever changes.
- **Rebinding protection:** some routers drop public answers that contain private addresses. The household's Linksys and Deco pass it through (verified).
- **Same site as the apex:** `krunchymonkey.dev` and `www` serve a GitHub Pages site. Browsers treat it as the same *site* as `tg.krunchymonkey.dev`. The Live host's exact Origin checks, CSRF tokens and host-only cookies still hold; the residual risk (for example cookie tossing from the apex) depends on only the owner controlling that Pages repository. Tracked for #168.

Rollback: delete the `tg` A record. The certificate keeps renewing through DNS-01 TXT records, which are unaffected.

## Verified facts

| Check (date) | Result |
| --- | --- |
| Authoritative nameservers (2026-10-30) | Cloudflare (`*.ns.cloudflare.com`); a zone-scoped token sees one zone, Active |
| DNS-01 TXT create and clean-up (2026-10-30) | works: staging and production orders validated; `_acme-challenge.tg.krunchymonkey.dev` is gone afterwards |
| `tg` A (2026-10-31) via 1.1.1.1, 8.8.8.8, 9.9.9.9, the Linksys and the Deco | the host's private IPv4, identical everywhere |
| `tg` AAAA (2026-10-31), same resolvers | none |
| Proxy status (2026-10-31) | DNS only (the answer is the private address, not a Cloudflare edge address) |
| Two household devices on the Deco Wi-Fi (2026-10-31) | both opened `https://tg.krunchymonkey.dev/` with automatic DNS and a trusted certificate |
| Certificate Transparency | the name `tg.krunchymonkey.dev` is in public CT logs (name only) |

Still to verify: a device on **mobile data** resolves the name but **cannot load** the page; see the owner checklist.

## Alternative: split-horizon DNS (original design, not in use)

Answer the name only inside the home network and keep public DNS at NXDOMAIN. It publishes nothing, but needs one of:

1. **A router override,** if the router supports a custom local DNS record (the household's Deco and Linksys do not appear to).
2. **A small local resolver** (CoreDNS, AdGuard Home, Pi-hole) that answers only this name and forwards the rest, handed to devices by DHCP or set per device. On the host it becomes a single point of failure; on an always-on device it is robust. A pilot-only CoreDNS on the host (subnet ACL, no open resolver, firewall rule limited to the Deco subnet) was used on 2026-10-31 and is being retired after the switch.
3. **Per-device hosts file**, for testing only (not possible on iPhone/iPad).

Devices that use Private Relay, a VPN or browser secure DNS bypass local resolvers and fail closed with this design.

## Owner checklist

Dashboard (do not paste screenshots, payment or login details anywhere public):

- [ ] Cloudflare → Domain Registration → Manage Domains: `krunchymonkey.dev` **Active**, registrant email verified, **auto-renew on**, registrar lock on.
- [ ] Cloudflare account: MFA on, recovery codes stored offline.
- [x] Cloudflare DNS for the zone: `tg` is a single **DNS only** A record to the private address; no AAAA; no proxied record or Tunnel for `tg` (2026-10-31).
- [ ] API token used for certificates: scoped to **this zone only**, permissions **Zone → DNS → Edit** and **Zone → Zone → Read**, nothing else. Stored only on the host (see #166).

Home network:

- [ ] DHCP reservation for the host computer in the Deco app.
- [ ] Deco and Linksys: no port forwarding, UPnP off.
- [x] Two household devices on home Wi-Fi reach `https://tg.krunchymonkey.dev/` (2026-10-31).
- [ ] One device on **mobile data** (Wi-Fi off): the page does not load.

## When things change

| Change | What to do |
| --- | --- |
| Host gets a new private address | Update the reservation and the `tg` A record. Certificates are unaffected (they name the hostname, not the address). |
| Moving Live to another computer | Same domain and hostname: install the reverse proxy and token on the new computer (#166), point the `tg` record at the new computer, stop the old one. No registrar change. |
| New router | Check that it passes private answers (no rebinding filter for this name) and has no port forwarding. |
| A device cannot resolve the name at home | Flush its DNS cache (Windows `ipconfig /flushdns`; reconnect Wi-Fi on phones). A cached "does not exist" from before the record was added can last a few minutes. |
| Roll back | Delete the `tg` A record. Live is then reachable only on the host itself (`npm run live`, `127.0.0.1`). |

## Status

#165 stays **open** until the remaining owner checklist items are done, including the mobile-data check. Registration of the domain is a separate fact from the security approval of real-data use (#168, #169).
