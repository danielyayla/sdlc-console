import { describe, expect, it } from "vitest";
import { identityForClaims, resolveConfig } from "../src/index.js";

const base = { schema: 1 as const, defaultRole: "po" as const, identities: [{ id: "Priya@veri.example", name: "Priya", roles: ["po"] }, { id: "eli", name: "Eli", roles: ["eng"], subject: "sub-42" }] };

describe("hosted identity: claims → config identity (3.1)", () => {
  it("resolves auth defaults and keeps local mode when auth is absent", () => {
    expect(resolveConfig({ ...base }).auth).toBeNull();
    const r = resolveConfig({ ...base, auth: { provider: "oidc", issuer: "https://idp.example/", clientId: "console" } });
    expect(r.auth).toEqual({ provider: "oidc", issuer: "https://idp.example", clientId: "console", audience: "console", claim: "email", scopes: ["openid", "email", "profile"], publicUrl: null, sessionHours: 12 });
  });
  it("a declared subject wins; otherwise the configured claim must equal the id (emails case-insensitively); nobody else gets in", () => {
    const r = resolveConfig({ ...base, auth: { provider: "oidc", issuer: "https://idp.example", clientId: "console" } });
    expect(identityForClaims(r, { sub: "sub-42", email: "someone-else@veri.example" })?.id).toBe("eli");
    expect(identityForClaims(r, { sub: "sub-1", email: "priya@VERI.example" })?.id).toBe("Priya@veri.example");
    expect(identityForClaims(r, { sub: "sub-9", email: "nobody@veri.example" })).toBeNull();
    expect(identityForClaims(r, { sub: "sub-9" })).toBeNull();
    const byName = resolveConfig({ ...base, auth: { provider: "oidc", issuer: "https://idp.example", clientId: "console", claim: "preferred_username" } });
    expect(identityForClaims(byName, { sub: "x", preferred_username: "eli" })?.id).toBe("eli");
    expect(identityForClaims(byName, { sub: "x", preferred_username: "ELI" })).toBeNull();
  });
});
