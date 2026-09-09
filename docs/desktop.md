# Desktop wrapper

The console is a web app served by `sdlc serve`; that is the product (decisions: "Desktop packaging — none in MVP: `sdlc serve` + browser; later optional Tauri/Electron wrapper"). Item 3.8 adds the optional wrapper in its smallest honest form.

## What ships: `@sdlc/desktop`

`packages/desktop` is a zero-dependency Node package with one bin:

```
sdlc-desktop [--port N] [--engine]
```

It starts `sdlc serve` for the current directory (the CLI built beside it, `packages/cli/dist/bin.js`) on a free loopback port — never the `7331` default, so it sits beside a console you already run — waits for the URL the server prints, opens it in the system browser (`open` / `xdg-open` / `cmd /c start`) and keeps the server alive until you press Ctrl+C or the server ends. Its stdout and stderr are the server's, verbatim.

That is all it does. There is no window frame of its own, no bundled runtime, no auto-update, no tray icon. `pnpm install` gains nothing; `pnpm build` builds it with the rest (`tsc -b`).

## What does not ship, and why

A Tauri or Electron shell was not added. Either one pulls a native toolchain (Rust + platform SDKs, or a ~100 MB runtime) into every contributor's install for a window the browser already provides, and would have to be built and signed per platform outside `pnpm build`. Nothing in the spec needs a native shell: the console is local-first over `sdlc serve`, works offline for the file-backed views, and has no OS integration (no file dialogs, no notifications) that a browser tab lacks.

If a shell is wanted later, the recipe is short and stays outside this repository's build:

- **Tauri**: `cargo tauri init` with `build.devUrl` / `build.frontendDist` pointing at `packages/web/dist`, a sidecar for `sdlc serve` (`tauri.conf.json` → `bundle.externalBin`), and the webview opened on the sidecar's URL. The sidecar is the whole integration; the console code does not change.
- **Electron**: a `main.js` that spawns `sdlc serve --port <free>` exactly as `@sdlc/desktop` does, then `new BrowserWindow().loadURL(url)`; package with electron-builder per platform.

Both would reuse `launchDesktop` from `@sdlc/desktop` for the spawn-and-wait-for-URL part.
