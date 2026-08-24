# Gems — native iOS app (whole‑library analysis)

The web app can't read your camera roll — iOS Safari has no "select all," and no
web API can enumerate the photo library. This native shell fixes that: it loads
the **same web app** inside a native iOS container (Capacitor) and adds a custom
**PhotoKit plugin** that scans your *entire* library on device and streams it to
the app for analysis. Photos never leave the phone.

Everything in this repo is ready to build. What's left can only be done on a Mac
with full Xcode (this machine had only the Command Line Tools, so the steps below
could not be run here). Follow them in order.

---

## What's already in the repo

| File | Purpose |
|---|---|
| `package.json` | Capacitor dependencies + scripts |
| `capacitor.config.json` | app id `app.sporve.gems`, bundles `www/` |
| `scripts/sync-web.mjs` | copies the web app into `www/` (run by the scripts below) |
| `gems-native.js` | the JS seam — calls the native plugin when present, else the web picker |
| `ios-plugin/GemsPhotosPlugin.swift` | the PhotoKit plugin (whole‑library scan) |
| `ios-plugin/GemsPhotosPlugin.m` | Capacitor registration for the plugin |

`node_modules/`, `www/`, and `ios/` are git‑ignored (all generated).

---

## Prerequisites (one time)

1. **Install Xcode** from the Mac App Store (~7 GB), then point the tools at it:
   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -license accept
   ```
2. **Install CocoaPods** (Capacitor uses it to link native pods):
   ```bash
   brew install cocoapods
   # or, without Homebrew:  sudo gem install cocoapods
   ```

---

## Build the app

From the repo root (`gems-app/`):

```bash
# 1. Install the Capacitor JS packages
npm install

# 2. Copy the web app into www/
npm run sync:web

# 3. Generate the native iOS project (runs pod install at the end)
npx cap add ios
```

### 4. Add the PhotoKit plugin to the iOS project

Copy the two staged plugin files into the generated app target:

```bash
cp ios-plugin/GemsPhotosPlugin.swift ios/App/App/
cp ios-plugin/GemsPhotosPlugin.m     ios/App/App/
```

When you next open Xcode it will offer to create a **bridging header** because of
the `.m` file — click **Create Bridging Header** (Capacitor's umbrella import is
already handled by the generated project; the empty bridging header is fine).

### 5. Add the photo‑library permission string

Open `ios/App/App/Info.plist` and add:

```xml
<key>NSPhotoLibraryUsageDescription</key>
<string>Gems reads your photo library on your device to find and edit your best photos. Your photos never leave your phone.</string>
```

(iOS refuses PhotoKit access without this key, and App Review rejects apps whose
purpose string is vague — keep it specific like the above.)

### 6. Sync, open, and run

```bash
npx cap sync ios      # copies www/ + plugins into the native project
npx cap open ios      # opens the project in Xcode
```

In Xcode:

1. Select the **App** target → **Signing & Capabilities**.
2. Set **Team**. A **free Apple ID works** for running on your own iPhone
   (the build is valid ~7 days, then re‑run). Publishing to the App Store needs
   the paid **Apple Developer Program** ($99/yr).
3. Plug in your iPhone, pick it as the run destination, press **Run** (⌘R).
4. On first launch the app asks for photo access → **Allow Full Access** →
   the whole camera roll streams in and gets analyzed.

To rebuild after any web change: `npm run cap:sync` (that's `sync:web` +
`cap sync ios`), then Run again in Xcode.

---

## How the whole‑library scan works

`gems-native.js` is the only place the app touches the device library. At runtime
it checks for `window.Capacitor.Plugins.GemsPhotos`:

- **Native shell present** → it calls the plugin and streams the library in
  batches of 40, each photo downscaled to ~1600 px JPEG on the Swift side, so a
  10,000‑photo roll imports without loading full‑res originals into the WebView.
- **Plain web** → it falls back to the multi‑file `<input>` picker.

The Swift ↔ JS contract (implemented in `GemsPhotosPlugin.swift`):

| JS call | Returns |
|---|---|
| `requestAccess()` | `{ status: "granted" \| "limited" \| "denied" }` |
| `count()` | `{ count }` — number of images PhotoKit will hand over |
| `getBatch({ offset, limit, maxEdge })` | `{ photos: [{ id, mimeType, base64 }] }`, newest‑first |

Because the app already routes all imports through `importFromDevice()` in
`gems-native.js`, no screen code changes between web and native — the same UI
just suddenly has the whole camera roll.

---

## Shipping to the App Store (later)

Running on your own device needs nothing but a free Apple ID. To distribute:

1. Enroll in the **Apple Developer Program** ($99/yr).
2. In Xcode: **Product → Archive → Distribute App → App Store Connect**.
3. Create the app in **App Store Connect**, fill in privacy details (declare that
   photo access is used on‑device and photos are not collected), attach a build,
   submit for **review** (typically ~1–3 days).

### Required URLs for the App Store listing

App Store Connect asks for a public Privacy Policy URL (required) and accepts a
Terms/EULA URL. These are already live and served from the same Vercel deploy:

- **Privacy Policy:** https://photos-chi-azure.vercel.app/privacy.html
- **Terms of Service:** https://photos-chi-azure.vercel.app/terms.html

Paste the Privacy Policy URL into **App Store Connect → App Privacy → Privacy
Policy URL**, and the Terms URL into the app's **App Information → License
Agreement** (or link both from your marketing page). If you move the app to a
custom domain, update these URLs to match.

> Before submitting: have counsel review both documents (especially the
> COPPA/minors handling), and point `privacy@gems.app` / `support@gems.app` at a
> real monitored inbox — App Review does check that the contact and policy are
> genuine.

> Note: the plugin Swift here targets Capacitor 6 / iOS 15+. It could not be
> compiled on this machine (no Xcode), so give it a build in Xcode before your
> first device run and fix any signing/target details Xcode surfaces.
