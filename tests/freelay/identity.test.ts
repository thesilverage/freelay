import { webcrypto } from "node:crypto";
import { IdentityKeyStore, canonicalUrl, decode, encode, transcript, profileStorageKey } from "../../src/control/Identity";
import type { Challenge } from "../../src/control/Identity";

const cryptoApi = webcrypto as unknown as Crypto;
import * as vector from "./auth-v1.json";

test("frozen auth v1 vector matches Rust and independent Node signer", async () => {
	const identity = new IdentityKeyStore({getSecret: () => "freelay-ed25519-v1:" + vector.seed, setSecret: () => {throw new Error("must not replace test identity");}},vector.challenge.audience,cryptoApi);
	expect(Buffer.from(transcript(vector.challenge)).toString("hex")).toBe(vector.transcript);
	expect(await identity.publicKey()).toBe(vector.challenge.publicKey);
	expect(await identity.principal()).toBe(vector.principal);
	expect(await identity.sign(vector.challenge)).toBe(vector.signature);
});
function secrets() {
	const values = new Map<string, string>();
	return {getSecret: (key: string) => values.get(key) ?? null, setSecret: (key: string, value: string) => {values.set(key, value);}, values};
}

test("local profile namespaces canonicalize URLs but isolate hosts and base paths", async () => {
	const key = (url: string) => profileStorageKey(url, cryptoApi);
	expect(await key("https://EXAMPLE.test:443/base")).toBe(await key("https://example.test/base/"));
	expect(await key("https://example.test/base/")).not.toBe(await key("https://example.test/other/"));
	expect(await key("https://example.test/")).not.toBe(await key("https://other.test/"));
	expect(await key("")).not.toBe(await key("https://example.test/"));
});

test("secret storage persists per-server identity and exports no private data", async () => {
	const store = secrets();
	const first = new IdentityKeyStore(store, "https://example.test", cryptoApi);
	const second = new IdentityKeyStore(store, "https://example.test/", cryptoApi);
	expect(await first.publicKey()).toBe(await second.publicKey());
	expect(await first.principal()).toBe(await second.principal());
	expect(await first.publicKey()).not.toBe(await new IdentityKeyStore(store, "https://other.test", cryptoApi).publicKey());
	expect(store.values.size).toBe(2);
});

test("replacement staging preserves the active key, supports rollback, and erases only this profile", async () => {
	const store = secrets();
	const active = new IdentityKeyStore(store, "https://example.test/", cryptoApi);
	const original = await active.publicKey();
	const other = new IdentityKeyStore(store, "https://other.test/", cryptoApi);
	const otherPublic = await other.publicKey();
	const staged = await active.replacement().publicKey();
	expect(staged).not.toBe(original);
	expect(await active.publicKey()).toBe(original);
	expect(await active.replacement().publicKey()).toBe(staged);
	await expect(active.activateReplacement(otherPublic)).rejects.toThrow("Replacement identity changed");
	expect(await active.publicKey()).toBe(original);
	await active.activateReplacement(staged);
	expect(await active.publicKey()).toBe(staged);
	await active.restorePrevious();
	expect(await active.publicKey()).toBe(original);
	await active.eraseLocalKeys();
	expect(await active.publicKey()).not.toBe(original);
	other.clearMemory();
	expect(await other.publicKey()).toBe(otherPublic);
});

test("signed transcript is audience-bound and contains exact binary fields", async () => {
	const identity = new IdentityKeyStore(secrets(), "https://example.test", cryptoApi);
	const challenge: Challenge = {version: 1, id: encode(new Uint8Array(16)), nonce: encode(new Uint8Array(32)), audience: identity.audience, publicKey: await identity.publicKey(), issuedAt: 100, expiresAt: 160};
	const signature = decode(await identity.sign(challenge), 64);
	const publicKey = await cryptoApi.subtle.importKey("raw", decode(challenge.publicKey, 32), "Ed25519", false, ["verify"]);
	expect(await cryptoApi.subtle.verify("Ed25519", publicKey, signature, transcript(challenge))).toBe(true);
	await expect(identity.sign({...challenge, audience: "https://evil.test/"})).rejects.toThrow();
	await expect(identity.sign({...challenge, expiresAt: 161})).rejects.toThrow();
});

test("reject noncanonical keys and unsafe server URLs", () => {
	expect(() => decode(encode(new Uint8Array(32)) + "=", 32)).toThrow();
	expect(() => canonicalUrl("http://localhost:8080")).toThrow();
	expect(() => canonicalUrl("https://user@example.test")).toThrow();
	expect(() => canonicalUrl("https://example.test/?")).toThrow();
	expect(canonicalUrl("https://EXAMPLE.test:443/base")).toBe("https://example.test/base/");
	expect(canonicalUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
});
