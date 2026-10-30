# Home-network Live: start, pair, switch, stop (#137)

This is the runbook for the **opt-in, unencrypted HTTP** home-network mode. It lets a second device (phone, tablet, another computer) on the same home Wi-Fi open the Live app on the researcher's computer.

**Fictional data only until #139 (HTTPS).** Plain HTTP can be read by anyone on the network, so the host refuses to start this mode on your default data folder or on any folder not marked as a fictional test profile. Do not put real client records into a profile used this way.

Never put LAN IP addresses, pairing codes, session cookies or screenshots showing them into public issues, pull requests or chat. Use made-up addresses (for example 192.168.1.20) in anything you share.

## Commands

All commands run on the researcher's computer, in the project folder, after `npm run web:build`.

1. **Find this computer's home-network address.** Windows: `ipconfig` (the IPv4 address of your Wi-Fi or Ethernet adapter). macOS: `ipconfig getifaddr en0`. Linux: `hostname -I`. It must be a private address: `10.x.x.x`, `172.16` to `172.31.x.x` or `192.168.x.x`. The address is never guessed for you.
2. **Create the test profile, once** (the folder must not exist yet or must be empty):

   ```
   npm run live -- --lan-host 192.168.1.20 --data-dir C:\tg-lan-test --init-lan-test-profile
   ```

3. **Start** (later runs leave out `--init-lan-test-profile`):

   ```
   npm run live -- --lan-host 192.168.1.20 --data-dir C:\tg-lan-test
   ```

   The window prints the private launch link (open it on this computer only) and the home-network address. The LAN mode is a command-line flag only: it never turns itself on at app start or after a reinstall.
4. **Optional: the fictional demo on the home network.** Add `--lan-demo-name tg-demo.home.arpa`. The name must be a DNS name (letters, digits, hyphens, at least one dot; not an IP address, not `localhost`) that **already resolves to this computer's LAN address** on the host and on every device that will use it (a router DNS entry, or each device's hosts file). It is looked up when the host starts; if it does not resolve to the LAN address, Live still starts, the LAN demo is not served and the window says why. The demo then listens on the LAN address at the Live port + 1 and accepts only that name.

   Why a name: cookies ignore ports, so a demo at `http://<ip>:<other port>` would share Live's site and could be reached with Live's cookie. A different host name is a different site, and the demo listener refuses the IP as a Host (421).

   Devices where the name does not resolve see the demo as unavailable. Pages that cannot offer it say "Demo not available from this device".
5. **Pair a device.** On the researcher's computer open Settings, find "Home-network devices", choose "Show pairing code". On the other device open the address shown there (use "Copy address"; it copies the address only, never a code), type the code and an optional device name. The code works once and expires after 5 minutes. Pairing controls who may sign in; it does **not** encrypt anything.
6. **Stop or turn off.**
   - *Turn off while running:* Settings, "Turn off home-network access", confirm. This closes the LAN listener and the LAN demo, signs out every device and clears the code. The window prints a line. Restoring a backup works again. It can only be turned on again by restarting with `--lan-host`.
   - *Stop everything:* press Ctrl+C in the window. Your data is saved.
7. **Roll back to localhost-only.** Start without `--lan-host`: `npm run live`. Nothing is listening on the network, and the host forgets every paired device (they live in memory only). Use your normal data folder again.
8. **Clean up.** After testing, stop the host and delete the test profile folder (for example `C:\tg-lan-test`). It contains only fictional data.

The standalone `npm run demo:lan` is unchanged: fictional-only, no API, and **no link to Live** (it has no `tg-live-url` marker; a link to a phone's own `127.0.0.1` would be wrong). Use `--lan-demo-name` when you want a Live link from the LAN demo.

**Don't run `npm run demo:lan` while Live is on the home network.** `demo:lan` is opened by the same IP address as LAN Live, only on another port, and browsers treat that as the same site: the device's Live cookie would be sent to the demo server too (it ignores it, but the Demo/Live site boundary is gone). Stop one before starting the other, or use `--lan-demo-name`, which serves the demo under a different host name.

## Firewall and network

- **Windows:** the network must be set to **Private** (Settings, Network and internet, your Wi-Fi or Ethernet, Network profile type). When Windows asks whether to allow Node.js through the firewall, tick **Private networks only** and never Public. If the prompt never appeared, allow `node.exe` for the Private profile only in Windows Security, Firewall, Allow an app. Tracing Guatemala makes **no automatic firewall edits**.
- **macOS:** allow incoming connections for `node` when prompted, only while on your home network.
- **Linux:** if a firewall is active, allow the Live port and port + 1 from your home subnet only (for example `ufw allow from 192.168.1.0/24 to any port 4180:4181 proto tcp`).

## Do not

- Do not forward the port on your router, and do not enable UPnP or port mapping for it.
- Do not use it on guest, public, hotel, cafe or shared Wi-Fi.
- Do not expose it through a VPN, tunnel or reverse proxy, or to the internet in any other way.
- Do not use real client data. HTTP is unencrypted.

## Recovery

| What happened | What you see | What to do |
| --- | --- | --- |
| The computer's address changed (new router lease, different Wi-Fi) | The host reports the address as unusable, or devices stop connecting | Stop, find the new address, restart with the new `--lan-host`. Paired devices pair again. |
| The computer went to sleep or the host was stopped | On the device: "Can't reach the researcher's computer. It may be asleep, stopped, or on a different network. Nothing you saved is lost." with Retry | Wake the computer or start the host, then press Retry. Saved records are in the profile folder. |
| The host was restarted, you revoked the device, or the session expired (60 minutes idle, 12 hours total) | The device returns to the pairing page: "Your session ended. Ask for a new pairing code on the researcher's computer." | Show a new code in Settings and pair again. |
| Wrong, expired or used code | The pairing page explains it | Show a new code. Five wrong guesses cancel a code; too many attempts in a minute are paused. |
| The device is on a different network | Same as asleep or stopped | Join the home Wi-Fi. |

The recovery pages never mention the private launch link; it only works on the researcher's own computer.

## Automated test hook

`tests/web/live-lan.spec.ts` starts the built host with `--lan-demo-name tg-demo.test`, which does not exist in DNS. The host honours `TG_TEST_RESOLVE=<name>=<address>` **only** when `TG_TEST_HOOKS=1` is also set, and prints a "TEST HOOK ACTIVE" warning when it does. Without `TG_TEST_HOOKS=1` the system resolver is always used. Never set either variable outside automated tests. The browser side uses Chromium's `--host-resolver-rules`. The spec is skipped when the machine has no private IPv4 address.

## Validation record

What was tested automatically for this mode, what was not (network isolation, guest networks, real Wi-Fi), and the manual owner checklist: [Phase 2.5 validation record](../pilot/phase-2.5-lan-validation.md). Run `npm run lan:rehearsal` after `npm run web:build` for a step-by-step rehearsal of the commands above against the built host on a throwaway fictional profile.
