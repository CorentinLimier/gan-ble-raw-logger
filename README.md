# Android BLE connectivity investigation

**Repo:** [`gan-ble-raw-logger`](https://github.com/CorentinLimier/gan-ble-raw-logger) — a standalone Web Bluetooth diagnostic tool ([live](https://corentinlimier.github.io/gan-ble-raw-logger/), [usage docs](./TOOL.md)) built specifically to investigate this bug, independent of `gan-web-bluetooth`.
**Audience:** acubemy / GAN cube app developers.
**Status:** Mitigated in this diagnostic tool; not fixable from a web page. See "Long-term fixes" for what would actually eliminate it.

## TL;DR

On at least one real Android device, a GAN12 ui Maglev cube's BLE notification
path intermittently fails to come up on the **first** GATT connection attempt
after discovery — not due to our code, `gan-web-bluetooth`, pairing, caching,
or anything controllable from a web page. A bounded retry loop that fully
tears down and re-establishes the GATT connection (not just re-issuing the
stuck call) works around it probabilistically, but is not a 100% guarantee.
The real fix lives outside the web page: a cube firmware update, or a native
app that can use Android BLE APIs Web Bluetooth doesn't expose.

## The symptom

- The official **acubemy** app (web, via `gan-web-bluetooth`) connects to a
  GAN12 ui cube fine on desktop Chrome, but fails to work on at least one
  specific Android phone.
- "Fails" meant: the cube connects (or appears to), but no cube events
  (moves, state) ever arrive — with nothing actionable in the UI, and no
  way to see a console on that phone to find out why.

## Why a separate tool was built

To isolate "is this a bug in our fork/frontend" from "is this a lower-level
platform issue", we built
[`gan-ble-raw-logger`](https://github.com/CorentinLimier/gan-ble-raw-logger)
— a Web Bluetooth client that:
- Does **not** depend on `gan-web-bluetooth` at all (independent, from-scratch
  implementation of the same public GAN BLE protocol in `public/protocol.js`,
  cross-checked against gan-web-bluetooth's own documented facelets example).
- Logs everything **directly on the page** (raw notification bytes, decoded
  events, every BLE/GATT step with timestamps), since the affected phone
  offers no accessible devtools console.
- Decodes moves/state and renders a small live 3D cube, so behavior can be
  sanity-checked visually, not just from byte dumps.

Live tool: https://corentinlimier.github.io/gan-ble-raw-logger/
Deploys automatically from `main` via GitHub Actions → GitHub Pages.

## Known-affected environment

| | |
|---|---|
| Phone | Android 10, generic/budget device (`User-Agent` reports platform `Linux armv81`, device string `K`) |
| Browsers tried | Chrome 157 (Mobile), Microsoft Edge (Chromium-based) — **both affected identically** |
| Cube | GAN12 ui Maglev, `GAN12uiM_A320` — GAN Gen4 protocol |
| Service UUID | `00000010-0000-fff7-fff6-fff5fff4fff0` |
| State characteristic | `0000fff6-0000-1000-8000-00805f9b34fb` — properties: `read, notify` |
| Command characteristic | `0000fff5-0000-1000-8000-00805f9b34fb` — properties: `read, writeWithoutResponse, write` |
| Reference app that works | Official **CubeStation** native app, same phone, same cube |

## The exact symptom, precisely

Every connection attempt gets through identically far:

1. `navigator.bluetooth.requestDevice()` — picks the cube. ✅ instant.
2. `device.gatt.connect()` — ✅ succeeds, ~300ms.
3. `gatt.getPrimaryServices()` — ✅ finds the one Gen4 service, ~1s.
4. `service.getCharacteristic(...)` ×2 — ✅ both characteristics found, ~300-500ms each.
5. `characteristic.getDescriptors()` — ✅ finds the CCCD descriptor, instant.
6. `characteristic.readValue()` — **sometimes hangs forever** (no resolve, no reject, no error — just dead silence).
7. `characteristic.startNotifications()` — **sometimes hangs forever**, same way.

Steps 1-5 (anything that's pure metadata lookup, no actual data exchange with
the peripheral) **never** failed in any test run. Steps 6-7 (anything that
needs a real over-the-air round trip with the cube) either both hang forever,
or both resolve in well under a second — **always together**, never one
without the other, across every attempt observed.

## What we tried, in order, with results

| # | Hypothesis | Test | Result |
|---|---|---|---|
| 1 | Stale cached script, not a real re-occurrence | Verified deployed file content directly, had the user hard-reload | New code confirmed running; hang was real, not a caching artifact |
| 2 | Android BLE stack needs breathing room between GATT calls | Added `withTimeout()` wrappers + ~300-500ms delays between every GATT step | Made the failure **visible** (explicit timeout instead of silent hang) and pinpointed the exact failing call, but did not fix it |
| 3 | Single retried call on the same connection recovers it | Retried `startNotifications()` once on the same GATT object | No different — hung identically |
| 4 | A full reconnect (not just a retried call) recovers it | Disconnect, wait, reconnect, rediscover, retry — up to 3 attempts | **Sometimes** worked (succeeded on attempt 2 once); **not reliable** — a later run failed all 3 attempts outright |
| 5 | Cube requires BLE pairing/bonding before notify will work | Manually tried "Pair new device" in Android Bluetooth settings | **Cube actively refused pairing** ("Association refusée"). Ruled out — by design, GAN cubes don't use link-layer bonding at all; the protocol's AES encryption happens entirely at the application layer. Also flagged (and worked around) the risk that the failed pairing attempt leaves stale OS state |
| 6 | Chrome-specific bug | Reproduced the exact same page/flow in Microsoft Edge (Chromium-based, same phone) | **Identical hang, identical point.** Rules out a Chrome-only regression |
| 7 | Stale Android Bluetooth/GATT cache | Settings → System → "Reset Wi-Fi, mobile & Bluetooth" + phone reboot | **No change.** Rules out cache corruption as a sufficient explanation |
| 8 | The MAC-retrieval advertisement scan (`watchAdvertisements()`) interferes with the GATT session that follows it | Pre-filled the MAC manually so the tool skips scanning entirely and connects immediately, like a native app would | **No change** — still hung at the same point. Ruled out |
| 9 | Notify needs the CCCD descriptor explicitly discovered first, or the characteristic "warmed up" with a read | Added explicit `getDescriptors()` and a one-time `readValue()` probe before `startNotifications()` | Didn't prevent the hang, but revealed the key signal: **`readValue()` and `startNotifications()` fail or succeed together, every time** — pointing to one shared "is this link ready for real data" state rather than anything notify-specific |
| 10 | More/faster retry attempts improve the odds enough to be practical | Shortened per-operation timeouts from 8s/15s to 3s/6s (real failures always hit the full timeout; real successes resolve almost instantly, so short timeouts lose nothing), raised the attempt ceiling 3 → 8 → 25 | Succeeds **more often**, but still **not guaranteed** — confirmed probabilistic: one run succeeded on attempt 2, another failed all 8 attempts outright |
| 11 | Cube advertises under multiple different MAC addresses and the wrong one gets used (a real issue reported for a GAN cube in [cstimer#480](https://github.com/cs0x7f/cstimer/issues/480)) | Rewrote the MAC-detection step to collect every distinct MAC seen over a scan window and prompt the user to confirm/pick one; separately inspected `chrome://bluetooth-internals/#devices` on both desktop and the affected Android phone | On desktop, two entries appeared for the same advertised name with different addresses — but **on the actual affected Android phone, only one address ever appears** (`FB:DD:7A:63:A3:20`), toggling Connected/Not Connected in sync with our own retry loop. Ruled out as the cause on Android; the desktop observation is a separate, unrelated quirk (likely BlueZ exposing the identity vs. connection address as distinct entries where Android's stack doesn't) |

Each of these is a real commit in the repo, in order, if you want the exact
diffs:
[`08c59a5`](https://github.com/CorentinLimier/gan-ble-raw-logger/commit/08c59a5) (delays+timeouts) ·
[`8b11406`](https://github.com/CorentinLimier/gan-ble-raw-logger/commit/8b11406) (full reconnect retry) ·
[`b50f87d`](https://github.com/CorentinLimier/gan-ble-raw-logger/commit/b50f87d) (real characteristic properties logging) ·
[`a8f91e5`](https://github.com/CorentinLimier/gan-ble-raw-logger/commit/a8f91e5) (skip-scan test) ·
[`54b14d4`](https://github.com/CorentinLimier/gan-ble-raw-logger/commit/54b14d4) (descriptor/read probes) ·
[`1db74fe`](https://github.com/CorentinLimier/gan-ble-raw-logger/commit/1db74fe) (faster timeouts) ·
[`b4f9f07`](https://github.com/CorentinLimier/gan-ble-raw-logger/commit/b4f9f07) (25 attempts + progress + cancel).

## Root cause (best understanding, not 100% provable from a web page)

On this device, a freshly established GATT connection to this cube
intermittently comes up in a state where:
- Pure metadata operations (service/characteristic/descriptor discovery)
  always work immediately.
- Operations that require a real over-the-air data exchange with the
  peripheral (a characteristic read, or the notification-enable descriptor
  write) either work immediately too, or hang forever with **no error ever
  surfaced to the browser** — and which of those two outcomes happens seems
  to vary per connection attempt, not per operation.

We cannot get a Bluetooth HCI snoop log from a web page, so we can't see
exactly what's happening on the air or inside Android's Bluetooth stack —
only that it's reproducible, environment-specific, and unrelated to pairing,
caching, or which Chromium-based browser is used.

## Why this can't be "properly" fixed from a web page

Native Android apps have access to several Bluetooth LE controls that the
**Web Bluetooth specification intentionally does not expose to any browser**,
on any platform:

- **`requestConnectionPriority()`** — lets a native app ask for a
  tighter/faster connection interval, which can be exactly what lets a
  marginal link "settle" fast enough to avoid this class of stall.
- **Explicit MTU / transport control** — native apps can tune these;
  Web Bluetooth picks defaults with zero control exposed to JS.
- **`BluetoothGatt.refresh()`** — a hidden/reflection-only Android API that
  forces a clean GATT attribute cache; no Web Bluetooth equivalent exists.
- **`autoConnect` mode** — a background-connect mode with its own internal
  OS-level retry/backoff, distinct from (and more capable than) any retry
  loop we can write in JS.

This means **any** Web Bluetooth-based client — this tool, `gan-web-bluetooth`,
and therefore acubemy's web app — hits the same ceiling on an affected
device. It is not a bug specific to any of these codebases. CubeStation
(native) most likely avoids the symptom by using one or more of the APIs
above, which a web page simply cannot call.

## Mitigation (what we shipped in this tool, recommended for porting into `gan-web-bluetooth`)

A connect sequence that, on a stall, retries from a **clean, fully torn-down
and rebuilt GATT session** — not just re-issuing the stuck call on the same
connection:

1. Wrap every GATT call in a timeout (`withTimeout()`), so a stall becomes a
   labeled error instead of hanging the UI forever.
2. On failure: `device.gatt.disconnect()`, wait ~1s, reconnect, rediscover
   services/characteristics, retry — don't just retry the same call.
3. Use **short** per-operation timeouts (we settled on 3-6s). Evidence
   showed real failures always consume the *entire* timeout and real
   successes resolve in well under a second — there's no "slow but working"
   middle ground on this device, so a short timeout loses nothing and lets
   many more attempts fit into the same total wait.
4. Raise the attempt ceiling generously (we use 25) since each attempt is
   now cheap.
5. Surface attempt progress to the user (`"Connecting… (attempt N/25)"`) and
   provide a way to cancel — a multi-attempt retry can take up to ~1-2
   minutes in the worst case, and that must not look like a frozen page.

This is a genuine, defensible fix *for the constraints Web Bluetooth
imposes* — not a hack. It will not hit 100% success on a device where the
underlying link is sufficiently unreliable, but it meaningfully improves the
odds over a single attempt, which is all that's achievable from JS.

See [`public/app.js`](https://github.com/CorentinLimier/gan-ble-raw-logger/blob/main/public/app.js)
(`establishGattSession()` and the retry loop in `connect()`) for the
reference implementation.

## Long-term fixes (the two paths that would actually eliminate the retries)

1. **Cube firmware update.** If this is a timing issue in the cube's own BLE
   stack/firmware around connection establishment, GAN may be able to fix it
   at the source — worth reporting this investigation to them directly,
   since it's now a well-reproduced, well-documented bug report rather than
   an anecdote. Worth checking the official app for a pending firmware
   update in the meantime.
2. **A native or hybrid app instead of a pure web page**, if 100% reliable
   first-connection behavior is a hard product requirement. A native BLE
   library (or a hybrid wrapper like Capacitor/React Native with a native
   BLE plugin) can call `requestConnectionPriority()`, `gatt.refresh()`, and
   use `autoConnect` mode — the exact tools CubeStation most likely relies
   on. This is a substantial rewrite compared to the current web app, and is
   only likely worth it if this affects a meaningful share of your Android
   user base.

## Suggested next steps for acubemy

- [ ] Port the retry-with-full-reconnect logic (see Mitigation above) into
      `connectGanCube()` in your `gan-web-bluetooth` fork, or wrap calls to
      it with the same pattern in the frontend.
- [ ] Try to reproduce on other Android devices/chipsets to scope how common
      this is — this was only confirmed on one specific budget Android 10
      device so far.
- [ ] Report the findings in this document to GAN, asking specifically about
      known BLE connection-establishment timing issues on the Gen4/Maglev
      protocol and whether a firmware fix exists or is planned.
- [ ] If/when you add the retry mitigation, keep the attempt count and
      timeouts configurable — different devices in the wild may need a
      different balance between "give up fast" and "try harder".
