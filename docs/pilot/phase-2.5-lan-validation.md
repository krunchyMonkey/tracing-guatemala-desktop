# Phase 2.5 validation record: HTTP home-network Live (#138)

This is the engineering acceptance record for the **transitional, opt-in, unencrypted HTTP** home-network mode of Live (#135 listener, #136 device pairing, #137 operations and LAN demo). It says what was tested automatically, what was **not**, and what the owner still has to do on real devices.

It is **not** researcher approval. The real researcher pilot (#21) is independent and stays open until it is performed.

## Risk gate

Read this before using the mode at all.

- **Fictional data only.** The host refuses to start the mode on your default data folder or on any folder not created with `--init-lan-test-profile`.
- **Plain HTTP is unencrypted.** Anyone on the network can read or change the traffic, including pairing codes, sessions and every record. Pairing decides who may sign in; it encrypts nothing.
- **Real client records wait for HTTPS (#139).** Nothing in this record certifies plaintext transport as safe for sensitive client data.
- **Owner risk acceptance is required** before anyone uses the mode, even for a fictional pilot: the owner has read this section and accepts that the network may be observed. This record does not give that acceptance.
- Never put LAN addresses, pairing codes, session cookies or screenshots showing them into public issues, pull requests or chat. Use made-up addresses such as `192.168.1.20`.

## Exact startup, enrollment and rollback

The same steps, with the explanations, are in [the runbook](../operations/lan-live.md). Addresses below are placeholders.

1. Build once: `npm run web:build`.
2. Find this computer's private IPv4 address (Windows `ipconfig`, macOS `ipconfig getifaddr en0`, Linux `hostname -I`). It must be `10.x.x.x`, `172.16` to `172.31.x.x` or `192.168.x.x`. It is never guessed.
3. Create the fictional test profile once (the folder must not exist or must be empty):

   ```
   npm run live -- --lan-host 192.168.1.20 --data-dir C:\tg-lan-test --init-lan-test-profile
   ```

4. Later starts: `npm run live -- --lan-host 192.168.1.20 --data-dir C:\tg-lan-test`.
5. **Enroll a device.** On the host open Settings, "Home-network devices", "Show pairing code". On the device open `http://192.168.1.20:4180/` (the address Settings shows), type the one-time code (valid 5 minutes, five wrong guesses cancel it) and an optional device name.
6. **Revoke** one device or all of them in the same Settings section. **Turn off** while running: "Turn off home-network access". It closes the LAN listener, signs every device out and cannot be undone without a restart.
7. **Roll back to localhost-only.** Stop the host (Ctrl+C) and start without `--lan-host`: `npm run live`. Nothing listens on the network and the host forgets every paired device. Delete the test profile folder when finished.

## Automated results

Run on one Windows machine using its own private address, discovered at run time. Date of the run: 2026-10-30.

| What | Where | Result |
| --- | --- | --- |
| Full release gate `npm run check` (lint, typecheck, Vitest, Playwright: Electron, browser demo, web-live) | whole repository | exit 0. Vitest: 59 files, 1263 passed, 1 skipped (1264). Playwright: 131 passed, 4 skipped |
| Device journey over LAN: client, case, update, state, reopen, journal, task, timer, hours, export, logout, re-pair, revoke, browser restart, host restart | `tests/web/live-lan-journey.spec.ts` (9 tests) | passed |
| LAN pairing UX, layouts, Live to Demo to Live, turn-off, host stop, default host unreachable (unchanged behaviour, now sharing `tests/web/lan-helpers.ts`) | `tests/web/live-lan.spec.ts` (15 tests) | passed |
| Security sweep (Host spoofing on Live and the LAN demo, Origin/CSRF on every write route, unauthorized reads of every callable, cross-client isolation over a LAN session, backup permissions, bind restrictions, no CORS, restart, session expiry, address change, backup and restore around turning LAN off, no exposure when off) | `tests/unit/live-lan-security.test.ts` (18 tests) | passed |
| Listener, enrollment and session behaviour | `tests/unit/live-lan.test.ts` | passed |
| Operational controls and the LAN demo | `tests/unit/live-lan-ux.test.ts` | passed |
| Default loopback security suite | `tests/unit/live-host.test.ts`, `tests/unit/security-policy.test.ts`, `tests/unit/csp.test.ts`, `tests/web/live-web.spec.ts` | passed (part of `npm run check`) |
| Fictional demo CSP and data isolation | `tests/unit/demo-server.test.ts`, `tests/unit/demo-mirror.test.ts`, `tests/demo/*` | passed (part of `npm run check`) |
| Electron regression | `tests/e2e/*` | passed (part of `npm run check`) |
| Both browser suites | `browser-demo` and `web-live` Playwright projects | passed (part of `npm run check`) |
| Live smoke | `npm run smoke:live` | exit 0, all steps passed |
| Phase 2 pilot rehearsal (unchanged) | `npm run pilot:rehearsal` | exit 0, 23 passed, 0 failed, 3 manual |
| LAN rehearsal against the built host | `npm run lan:rehearsal` | exit 0, 25 passed, 0 failed, 0 skipped, 8 manual (the manual steps are the checklist below) |
| Demo build | `npm run demo:build` | exit 0 |

### Which earlier tests already cover the security criteria

The new security file only adds what was missing. These were already covered and are not repeated:

- Host header exact match, loopback socket refusing the LAN Host, LAN demo refusing the IP, localhost, other ports and other names: `live-lan.test.ts`, `live-lan-ux.test.ts`.
- Wrong Origin, cross-site fetch, CSRF missing or wrong, loopback cookie not valid on LAN and the reverse: `live-lan.test.ts`.
- Pairing brute force, replay, 10-device cap, revoke one and all, logout, idle (60 minutes) and absolute (12 hours) session expiry and 5-minute code expiry through the injected clock: `live-lan.test.ts`.
- Host-only calls and backup routes refused for a paired device; restore and upload refused while LAN is on; `disableLan` closing both listeners: `live-lan.test.ts`, `live-lan-ux.test.ts`.
- Invalid or foreign `--lan-host` values, default profile and unmarked folder refusals: `live-lan.test.ts`.
- Case summary isolation, note isolation and case, journal, task and hours isolation by owner (loopback): `live-case-export.test.ts`, `live-host.test.ts`, `live-case-*.test.ts`.

### Findings

- No product bug was found by the new tests.
- Behaviours worth knowing, now pinned by tests: the LAN listener answers 403 `host-only` to the backup upload and download routes before it looks at any session; a mixed-case spelling of the allowed demo name is served (host names are case-insensitive) while a trailing dot is refused; a refused start with `--init-lan-test-profile` can still leave an empty, marked folder behind (harmless, it holds no data).

## Manual owner checklist

Every item below is **NOT RUN**. Record date, result and who ran it. Do not paste addresses, codes or screenshots showing them into public places.

- [ ] **NOT RUN - Second physical device on the trusted home Wi-Fi (phone).**
  1. Host: start with `--lan-host` on the fictional test profile; confirm the window shows the LAN address.
  2. Phone on the same Wi-Fi: open the address, check the "Unencrypted HTTP" banner is visible.
  3. Host Settings: show a pairing code; type it on the phone; confirm the phone shows the app and the host lists the device.
  4. On the phone: add a client and a case, add a journal entry and a task, export the case summary.
  5. On the host: confirm the same data is there; revoke the device; the phone's next action shows "Your session ended".
- [ ] **NOT RUN - Second physical device on the trusted home Wi-Fi (tablet).** Same steps as the phone, in both orientations.
- [ ] **NOT RUN - A device on a guest or IoT network must fail to connect.** Join a guest network or an IoT network (a different subnet or an isolated one). Open the host's address. Expected: the page does not load. Record the router and what failed. If it loads, stop and turn the mode off.
- [ ] **NOT RUN - Host sleep and wake.** With a device paired, put the host to sleep, wake it, and press Retry on the device. Expected: either the session still works or the device returns to the pairing page; saved records are intact. Note which.
- [ ] **NOT RUN - Wi-Fi or DHCP address change.** Change the host's address (renew the lease or change network). Expected: devices stop connecting; restarting with the new `--lan-host` works; a stale address is refused with "not an address of this computer"; devices pair again.
- [ ] **NOT RUN - Windows firewall prompt answered for Private only.** On first start Windows asks about Node.js: tick Private networks only. Confirm the network profile is Private. Confirm a device on a Public-profile network cannot connect.
- [ ] **NOT RUN - `--lan-demo-name` resolving on each device.** Add a router DNS entry or a hosts-file line on each device for a made-up name such as `tg-demo.home.arpa`. Start with `--lan-demo-name`. Open the demo from each device; check "Open the fictional demo" and "Back to Live" work and the device is still signed in to Live afterwards. A device where the name does not resolve must see "Demo not available from this device".
- [ ] **NOT RUN - Mobile browser layouts on real devices.** On the phone and the tablet check the pairing page, Clients, Cases, a case with journal, steps and hours, and Settings: no sideways scrolling, buttons reachable, the HTTP banner always visible.

## Limitations

Read these before relying on this record.

- The automated tests run **on one machine**, talking to its own private address. They prove the application's behaviour on that address (binding, Host, Origin, sessions, persistence), **not network behaviour**.
- **Network isolation between devices is not tested automatically.** Neither is guest-network or IoT-network refusal, router client isolation, VLANs, or what other devices can observe on the wire.
- **Real Wi-Fi behaviour is not tested**: roaming, DHCP renewals, sleep and wake of the host, captive portals, mDNS and router DNS.
- The Windows firewall prompt and its Private/Public profiles are not exercised. The tests connect from the same machine, so the firewall does not apply to them.
- Real phones and tablets, their browsers and their layouts are not tested. Chromium (Microsoft Edge on Windows) at three widths is.
- The DNS name for the LAN demo is mapped with a test-only hook; real name resolution on devices is manual.
- Plain HTTP stays unencrypted. Passing every test above does not make it safe for real client records.
- The 30-second minimum of the research timer is waited out in the journey test (it adds about half a minute to the browser run).

## Relationship to the researcher pilot

The researcher pilot **#21 is independent and stays open** until it is actually performed with the researcher. This record is the engineering readiness gate for the LAN capability only. The owner's approval of engineering readiness (the last acceptance item of #138) is the owner's decision after the manual checklist above; nothing here records it.
