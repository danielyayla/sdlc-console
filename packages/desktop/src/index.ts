/**
 * @sdlc/desktop — the optional desktop wrapper (build-order 3.8, decisions
 * "Desktop packaging: none in MVP … later optional wrapper").
 *
 * It is deliberately thin: `sdlc-desktop` starts `sdlc serve` for the working
 * directory on a free loopback port, waits for the URL the server prints, opens
 * it in the system browser and keeps the server alive until the wrapper is
 * stopped. There is no native shell, no bundled runtime and no dependency
 * beyond the CLI it spawns; a Tauri/Electron shell would add a toolchain to
 * every install for a window frame the browser already provides (see
 * docs/desktop.md). The console itself is unchanged: files in git stay the
 * source of truth, the server is the same `sdlc serve`.
 */
export const PACKAGE_NAME = "@sdlc/desktop" as const;

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

export interface DesktopIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
}

export interface DesktopOptions {
  /** Port for `sdlc serve`; a free loopback port when omitted (never the 7331 default, which another console may hold). */
  port?: number;
  /** `sdlc serve --engine`. */
  engine?: boolean;
  /** Path to the sdlc bin (default: the CLI package built beside this one). */
  sdlcBin?: string;
  /** Test seams: how the server process is started and how the URL is opened. */
  spawnImpl?: typeof nodeSpawn;
  open?: (url: string, io: DesktopIo) => Promise<void> | void;
  /** How long to wait for the server's URL line before giving up (default 30 s). */
  startTimeoutMs?: number;
}

export interface DesktopHandle {
  url: string;
  child: ChildProcess;
  /** Resolves with the server's exit code once it ends. */
  exited: Promise<number | null>;
  /** Ends the server (SIGTERM) and resolves when it has exited. */
  stop(): Promise<number | null>;
}

/** The CLI bin built beside this package (`packages/cli/dist/bin.js`). */
export function defaultSdlcBin(): string {
  return fileURLToPath(new URL("../../cli/dist/bin.js", import.meta.url));
}

/** A free loopback port from the OS. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/** Open a URL with the platform's opener: `open` (macOS), `xdg-open` (Linux), `cmd /c start` (Windows). */
export function openInBrowser(url: string, io: DesktopIo, spawnImpl: typeof nodeSpawn = nodeSpawn): Promise<void> {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  return new Promise((resolve) => {
    const child = spawnImpl(cmd, args, { stdio: "ignore", env: io.env });
    child.on("error", (e) => {
      io.stderr(`could not open a browser (${(e as Error).message}); open ${url} yourself\n`);
      resolve();
    });
    child.on("exit", () => resolve());
  });
}

const URL_LINE = /^(https?:\/\/[^\s]+)/;

/**
 * Start `sdlc serve` and open the console. Resolves once the server printed
 * its URL and the opener ran; rejects when the server exits or stays silent
 * before that.
 */
export async function launchDesktop(io: DesktopIo, opts: DesktopOptions = {}): Promise<DesktopHandle> {
  const port = opts.port ?? (await freePort());
  const bin = opts.sdlcBin ?? defaultSdlcBin();
  const spawnImpl = opts.spawnImpl ?? nodeSpawn;
  const child = spawnImpl(process.execPath, [bin, "serve", "--port", String(port), ...(opts.engine ? ["--engine"] : [])], { cwd: io.cwd, env: io.env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const url = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    let found = false;
    const timer = setTimeout(() => {
      if (!found) reject(new Error(`sdlc serve printed no URL within ${opts.startTimeoutMs ?? 30_000} ms`));
    }, opts.startTimeoutMs ?? 30_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        io.stdout(`${line}\n`);
        const m = URL_LINE.exec(line);
        if (m?.[1] && !found) {
          found = true;
          clearTimeout(timer);
          resolve(m[1]);
        }
        nl = buffer.indexOf("\n");
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => io.stderr(chunk));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    void exited.then((code) => {
      if (!found) {
        clearTimeout(timer);
        reject(new Error(`sdlc serve exited with code ${code} before printing its URL`));
      }
    });
  });
  await (opts.open ?? ((u, i) => openInBrowser(u, i)))(url, io);
  return {
    url,
    child,
    exited,
    stop() {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      return exited;
    },
  };
}

/** `sdlc-desktop [--port N] [--engine]`: run until the server ends or the wrapper is interrupted. */
export async function desktopMain(argv: readonly string[], io: DesktopIo, opts: DesktopOptions = {}): Promise<number> {
  let port: number | undefined;
  let engine = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") port = Number(argv[++i]);
    else if (a?.startsWith("--port=")) port = Number(a.slice("--port=".length));
    else if (a === "--engine") engine = true;
    else if (a === "--help" || a === "-h") {
      io.stdout("usage: sdlc-desktop [--port N] [--engine]\nStarts sdlc serve for the current directory and opens the console in your browser.\n");
      return 0;
    } else {
      io.stderr(`unknown argument ${a}\n`);
      return 2;
    }
  }
  if (port !== undefined && (!Number.isInteger(port) || port <= 0)) {
    io.stderr("--port expects a positive integer\n");
    return 2;
  }
  try {
    const handle = await launchDesktop(io, { ...opts, ...(port !== undefined ? { port } : {}), engine });
    io.stdout(`console open at ${handle.url} — press Ctrl+C to stop\n`);
    const onSignal = () => void handle.stop();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    const code = await handle.exited;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    return code ?? 0;
  } catch (e) {
    io.stderr(`${(e as Error).message}\n`);
    return 1;
  }
}
