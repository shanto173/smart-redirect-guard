# Smart Redirect Guard (SRG)

An intelligent, privacy-focused Chrome extension (Manifest V3) that combines three independent
protection layers:

1. **New-tab ad blocking** — detects and closes confirmed unwanted advertising tabs, keeping the
   original tab intact.
2. **Same-tab redirect protection** — blocks known unwanted destinations with
   `declarativeNetRequest` and offers one-click recovery to the last safe URL when a redirect has
   already completed.
3. **Element-level ad blocking** — hides in-page banners, sticky bars, overlays and ad iframes with
   a confidence-scored detector plus a `MutationObserver` for dynamically injected ads.

Everything runs locally. No backend, no analytics, no network requests, no remote filter lists.

> **Status: in development, built phase by phase.**
> Phase 1 (architecture) is complete — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and the
> frozen module contract in [`docs/INTERFACES.md`](docs/INTERFACES.md).
> Full installation, testing and permission documentation lands in Phase 7.

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the extension works, Chrome APIs, data flow, permission justification, lifecycle walkthroughs, known limitations |
| [`docs/INTERFACES.md`](docs/INTERFACES.md) | Message protocol, storage schema, module APIs, rule file schemas |

## License

MIT — see [`LICENSE`](LICENSE).
