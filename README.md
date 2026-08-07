# Mofune

[日本語版はこちら / Japanese version](README.jp.md)

**A serverless, end-to-end encrypted communication PWA for small groups.**

Mofune connects a group's staff and members — announcements, photos, absence reports, and embedded forms — without the operator running a single server. Each group owns its data on its own cloud storage account, fully encrypted. The app itself is just static files.

It targets any small group that keeps a roster and sends periodic announcements: preschools, after-school clubs, building associations, hobby circles, neighborhood groups, sports teams.

> Status: **design phase**. Requirements, design, and visual design are complete (Japanese); implementation has not started yet.

## Why

Communication apps for groups like these usually mean a hosted service: monthly fees, a vendor holding photos and family data, and a business that must stay alive for the app to keep working. Mofune takes the opposite approach:

- **No central server, no database, no resident process.** The app is a static PWA (e.g., GitHub Pages). Data lives in storage the group already controls.
- **Zero accounts for members.** Members log in with just an ID and password handed out on paper. No Google account, no storage account, no sign-up.
- **End-to-end encrypted, publicly readable storage.** Everything is encrypted client-side. The storage can be world-readable and the data stays private — access control is key possession, not server-side ACLs.
- **Scales without the operator.** Every group is an independent tenant with its own storage and keys. A thousand groups cost the operator exactly as much as one: nothing.

## Features

- Announcements, photos, and PDFs scoped to the whole group or to subgroups; a single post can target several subgroups at once
- Subgroups nest. A post addressed to a child subgroup stays inside that child.
- File attachments visible only to members of the target scope — even with the storage URL, outsiders see ciphertext
- Forms embedded in messages; **only the form's author can decrypt the responses** (not even the group admin can)
- Absence reports from members (absent / arriving late / leaving early)
- Multi-tier notifications that reach members even when the app is closed
- Offline-first: browse cached content and queue posts without a connection
- One person can run multiple groups, each on a different storage provider

Read receipts are deliberately absent. Unread badges are computed locally on each device, and browsing behavior is never transmitted anywhere.

## Architecture at a glance

```
[required] Static PWA        one deployment serves all groups (GitHub Pages etc.)
[required] Storage           per-group choice: S3-compatible / Drive / Dropbox / WebDAV
[required] Inbox             member-to-staff uplink via storage-native means (presigned PUT)
[optional] Serverless fn     Web Push delivery only; GAS or Cloudflare Workers, removable anytime
[fallback] Email (mailto:)   manual bulk send from the staff member's own mailer, zero API dependency
```

Two facts shaped the design, verified against protocol and vendor docs:

1. **A browser cannot send Web Push.** Push service endpoints reject cross-origin requests, so a pure static app can never deliver push. Push therefore lives in an *optional* function layer that each group can self-deploy for free — and everything still works without it.
2. **Authentication without a server = decryption.** Login derives a key from the password (Argon2id + a pepper distributed only on paper), unwraps the user's keystore fetched from public storage, and unlocks the scope keys. A wrong password simply fails to decrypt.

Notifications cascade per recipient: Web Push (if the function layer is deployed) → a `mailto:` link that opens the staff member's mail app with all recipients pre-filled in BCC → guaranteed catch-up sync on next app open. Every notification is content-free ("you have news") so nothing sensitive ever crosses a third-party channel.

## Documentation

Currently in Japanese, under [`docs/`](docs/):

- [Requirements](docs/Mofune%20-%20要件書.md) — features, non-functional requirements, accepted trade-offs
- [Design](docs/Mofune%20-%20設計書.md) — scope hierarchy, key hierarchy, envelope format, storage layout, sync, notification channels, threat model, phased plan
- [Visual design](docs/design/) — character, marketing site, 12 app screens
- [Phase 1 implementation plan](docs/superpowers/plans/2026-08-07-phase1-crypto-foundation.md)

## Tech stack (planned)

Vue 3 · TypeScript · Vite · PWA / Service Worker · Dexie.js (IndexedDB) · Web Crypto API · Argon2id (hash-wasm)

Nothing is fetched from an external CDN at runtime; fonts and WASM ship with the app.

## Roadmap

1. **Phase 1** — crypto foundation: key hierarchy, multi-recipient envelopes, keystores, password login, signed roster, login screen
2. **Phase 2** — sync and uplink: storage abstraction (S3-compatible reference), event sourcing, inbox, posting and browsing, absence reports, mailto notifications, provisioning wizard
3. **Phase 3** — forms, optional function layer (GAS / Workers), Web Push, subgroup management, member assignment, public site
4. **Phase 4** — multi-group dashboard, key rotation, bulk roster turnover, additional storage providers
