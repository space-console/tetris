# tetris

Tetris for **Space Console** — a game that runs on the launcher (the TV/screen),
driven by the same shared **intent vocabulary** (`up/down/left/right/enter/back`)
the launcher and controller already speak, so a phone controller can drive it
later with no changes.

Zero-build, zero-backend static site — plain ES modules, no bundler, no
framework. Open `index.html` and it runs.

```sh
npm install      # dev server only
npm run dev      # http://localhost:5175 (auto-reload)
```

## Controls

Everything routes through the shared intent layer (keyboard / TV remote / gamepad):

| Intent | Keyboard | Action |
| --- | --- | --- |
| left / right | ← → (or A / D) | Move piece |
| up | ↑ (or W) | Rotate |
| down | ↓ (or S) | Soft drop |
| enter | Enter / Space | Hard drop · start · resume |
| back | Esc / Back | Pause · return |

## Documentation

All docs live in the **wiki** repo (the org-wide hub), not here:

- Service docs: `wiki/docs/services/tetris/`
- How we build, deploy, and review across repos: `wiki/docs/way-of-working.md`

Published site: `main` deploys to the Pages root; feature branches get a preview
at `/preview/<branch-slug>-<hash>/`. Scripts are cache-busted at deploy time
(`npm run build` → `_dist/`); local `npm run dev` stays build-free.
