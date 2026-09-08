import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { desktopMain, freePort, launchDesktop, type DesktopIo } from "../src/index.js";

const FAKE_SERVE = fileURLToPath(new URL("./fixtures/fake-serve.mjs", import.meta.url));

function io(env: Record<string, string> = {}): DesktopIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t), env: { PATH: process.env["PATH"] ?? "", ...env }, cwd: process.cwd() };
}

describe("sdlc-desktop (3.8): sdlc serve + the system browser, nothing native", () => {
  it("starts the server on a free port, waits for its URL, opens it once and stops it on request", async () => {
    const opened: string[] = [];
    const i = io();
    const handle = await launchDesktop(i, { sdlcBin: FAKE_SERVE, engine: true, open: (url) => void opened.push(url) });
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(handle.url).not.toContain(":7331");
    expect(opened).toEqual([handle.url]);
    expect(i.out.join("")).toContain("engine: on");
    expect(await handle.stop()).toBe(0);
  });

  it("uses the port it is given and reports a server that dies or stays silent", async () => {
    const port = await freePort();
    const i = io();
    const handle = await launchDesktop(i, { sdlcBin: FAKE_SERVE, port, open: () => undefined });
    expect(handle.url).toBe(`http://127.0.0.1:${port}`);
    await handle.stop();
    await expect(launchDesktop(io({ FAKE_SERVE_DIE: "1" }), { sdlcBin: FAKE_SERVE, open: () => undefined })).rejects.toThrow(/exited with code 3 before printing its URL/);
    await expect(launchDesktop(io({ FAKE_SERVE_SILENT: "1" }), { sdlcBin: FAKE_SERVE, open: () => undefined, startTimeoutMs: 300 })).rejects.toThrow(/no URL within 300 ms/);
  });

  it("desktopMain parses --port/--engine, prints help, refuses junk and returns the server's exit code", async () => {
    const help = io();
    expect(await desktopMain(["--help"], help)).toBe(0);
    expect(help.out.join("")).toContain("usage: sdlc-desktop");
    const bad = io();
    expect(await desktopMain(["--wat"], bad)).toBe(2);
    expect(await desktopMain(["--port", "zero"], io())).toBe(2);
    const dead = io({ FAKE_SERVE_DIE: "1" });
    expect(await desktopMain([], dead, { sdlcBin: FAKE_SERVE, open: () => undefined })).toBe(1);
    expect(dead.err.join("")).toContain("before printing its URL");
    const opened: string[] = [];
    const run = io();
    const code = desktopMain(["--engine", "--port=0"], run, { sdlcBin: FAKE_SERVE, open: (url) => void opened.push(url) }).catch(() => -1);
    // --port=0 is refused (not positive) before anything starts
    expect(await code).toBe(2);
    expect(opened).toEqual([]);
  });
});
