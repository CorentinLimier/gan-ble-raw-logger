# gan-ble-raw-logger

A dependency-free (beyond two vendored, offline-bundled libraries) Web
Bluetooth page built to answer two questions: **do BLE notifications from a
GAN smart cube actually reach this browser, on this device, when it
connects and when faces are turned — and once decoded, does the resulting
move/state/orientation match what's physically happening to the cube?**

It intentionally does **not** use [`gan-web-bluetooth`](https://github.com/afedotov/gan-web-bluetooth) —
it's a from-scratch, independent client (`protocol.js` is a vanilla-JS port
of the same public GAN BLE protocol), so it can act as a cross-check
against a GAN12 UI connectivity issue that reproduces on phone (Chrome +
official aCube/CubeStation app) but not on desktop.

It connects, logs every raw BLE notification byte-for-byte with a
timestamp, decodes moves/facelet-state/gyro/hardware/battery from the
decrypted payload, renders the decoded cube live as a small 3D sticker
cube, and prints all of this straight on the page — because on a phone you
usually can't get to `chrome://inspect` or a console to see what's
happening.

## What it does

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
  byte length, and the full raw hex payload, plus the decrypted hex payload
  when a MAC/key is available.
- Decoded `MOVE` / `FACELETS` / `GYRO` / `HARDWARE` / `BATTERY` events
  (including Gen3/Gen4 missed-move history recovery), replayed locally with
  the standard Kociemba cubie move tables and rendered live as a 3D sticker
  cube (Three.js), with the cube's own orientation applied from the
  gyroscope where supported.
- **Reset gyro** button: recalibrates the on-screen orientation reference
  to the cube's current physical orientation (client-side only, no command
  sent to the cube — press it after picking the cube up in a comfortable
  resting orientation).
- **Reset cube (set solved)** button: sends the GAN "treat current position
  as solved" command to the cube's firmware and resets the local display to
  solved — only press it when the physical cube is actually solved.
- `gattserverdisconnected` events, and any error with its message/stack.

It only ever writes the read/calibration commands above (hardware info,
facelets state, battery, reset-to-solved) — never move or algorithm data —
to keep the surface for bugs small while isolating whether the
*notification and decoding path* works.

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

The service/characteristic UUIDs, manufacturer-data MAC extraction,
AES-128-CBC salting scheme, and the bit-level Gen2/Gen3/Gen4 event decoders
in `public/protocol.js` are public knowledge of the GAN BLE protocol,
reproduced from the upstream MIT-licensed
[`afedotov/gan-web-bluetooth`](https://github.com/afedotov/gan-web-bluetooth)
project purely for interoperability with GAN-branded hardware you own.
Move replay uses the standard cubie-level move tables from the public
Kociemba two-phase solver (same cubie numbering convention); the
conversion to Kociemba facelets notation is cross-checked against
gan-web-bluetooth's own documented example.

AES primitives come from the vendored, unmodified
[`aes-js`](https://github.com/ricmoo/aes-js) (MIT, see
`public/vendor/aes-js.LICENSE.txt`); the 3D cube view is rendered with a
vendored, bundled-and-minified build of [`three.js`](https://github.com/mrdoob/three.js)
(MIT, see `public/vendor/three.LICENSE.txt`) — both vendored locally so the
page works fully offline with no CDN dependency, one less variable when
debugging a mobile-only issue.
