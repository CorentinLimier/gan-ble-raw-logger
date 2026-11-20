# gan-ble-raw-logger

A minimal, dependency-free Web Bluetooth page whose only job is to answer
one question: **do BLE notifications from a GAN smart cube actually reach
this browser, on this device, when it connects and when faces are turned?**

It intentionally does **not** use [`gan-web-bluetooth`](https://github.com/afedotov/gan-web-bluetooth) —
it's a from-scratch, independent client, so it can act as a cross-check
against a GAN12 UI connectivity issue that reproduces on phone (Chrome +
official aCube/CubeStation app) but not on desktop.

It connects, logs every raw BLE notification byte-for-byte with a
timestamp, and (if it can determine the cube's MAC address) also attempts
AES decryption, straight on the page — because on a phone you usually can't
get to `chrome://inspect` or a console to see what's happening.

## What it logs

- Environment info on load: user agent, whether `navigator.bluetooth`
  exists, whether `watchAdvertisements()` is supported, Bluetooth adapter
  availability.
- The device picker result (name/id) once you pick your cube.
- Every BLE advertisement packet received (if `watchAdvertisements()` is
  supported), including raw manufacturer data bytes, RSSI, and the
  extracted MAC address.
- GATT connect success/failure, all discovered primary service UUIDs,
  which GAN protocol generation (Gen2/Gen3/Gen4) matched, and the
  characteristic properties.
- Every single `characteristicvaluechanged` notification: sequence number,
  byte length, and the full raw hex payload — plus a decrypted hex payload
  if a MAC/key was available and the decrypt checkbox is on.
- `gattserverdisconnected` events, and any error with its message/stack.

It never writes anything to the cube (no commands sent) — it is read-only,
to keep the surface for bugs as small as possible while isolating whether
the *notification path* works.

## Using it

1. Open the deployed page on the phone that's having trouble (Chrome on
   Android; **Web Bluetooth does not exist in iOS Safari or iOS Chrome at
   all** — if that's the platform, this will never work there, which is
   itself useful information).
2. Tap **Connect to cube**, pick it from the device chooser.
3. Watch the log. Turn a few faces and confirm notification lines keep
   appearing with new raw bytes.
4. Use **Copy** or **Download .txt** to get the full log off the phone
   (clipboard copy or a downloaded file — both work without a devtools
   console).

### MAC / decryption

GAN cubes salt their AES key/iv with the device's BLE MAC address. Some
browsers expose this automatically via `watchAdvertisements()` (the page
tries this for up to 10s after you pick the device); on Android Chrome this
API has historically required enabling **Experimental Web Platform
features** in `chrome://flags`. If auto-detection fails, you can paste a
MAC manually (e.g. read from a generic BLE scanner app like nRF Connect)
into the "Manual MAC fallback" field before connecting. If no MAC is
available at all, raw bytes are still logged — decryption is purely a
bonus for making the payload more legible, it is not required to prove
notifications are arriving.

## Deployment

Pushing to `main` triggers `.github/workflows/deploy-pages.yml`, which
publishes the contents of `public/` to GitHub Pages via
`actions/upload-pages-artifact` + `actions/deploy-pages`. Enable Pages for
this repo once (Settings → Pages → Source: GitHub Actions) and it will
deploy automatically on every push.

## Protocol reference

The service/characteristic UUIDs, manufacturer-data MAC extraction, and
AES-128-CBC salting scheme in `public/app.js` are public knowledge of the
GAN BLE protocol, reproduced from the upstream MIT-licensed
[`afedotov/gan-web-bluetooth`](https://github.com/afedotov/gan-web-bluetooth)
project purely for interoperability with GAN-branded hardware you own.
AES primitives come from the vendored, unmodified
[`aes-js`](https://github.com/ricmoo/aes-js) (MIT, see
`public/vendor/aes-js.LICENSE.txt`) so the page works fully offline with no
CDN dependency — one less variable when debugging a mobile-only issue.
