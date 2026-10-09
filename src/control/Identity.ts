/** Freelay auth v1. Times on this interface are Unix seconds, not milliseconds. */
export interface Challenge {
	version: number;
	id: string;
	nonce: string;
	audience: string;
	publicKey: string;
	issuedAt: number;
	expiresAt: number;
}

export interface SecretStorage {
	getSecret(id: string): string | null;
	setSecret(id: string, value: string): void;
}

export function encode(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decode(value: string, length: number): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length !== Math.ceil(length * 8 / 6)) throw new Error("Invalid encoding");
	const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
	if (bytes.length !== length || encode(bytes) !== value) throw new Error("Noncanonical encoding");
	return bytes;
}

export function canonicalUrl(input: string): string {
	const url = new URL(input);
	const ipv4 = url.hostname.split(".");
	const loopback = url.hostname === "[::1]" || (ipv4.length === 4 && ipv4[0] === "127" && ipv4.every(p => /^\d+$/.test(p) && Number(p) <= 255));
	if (url.username || url.password || url.search || url.hash || input.includes("?") || input.includes("#")) throw new Error("Invalid server URL");
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("HTTPS required");
	url.pathname = url.pathname.replace(/\/+$/, "") + "/";
	return url.toString();
}

/** Stable non-secret namespace for local state; no server can select another's cache. */
export async function profileStorageKey(url: string, cryptoApi: Crypto = globalThis.crypto): Promise<string> {
	return encode(new Uint8Array(await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(url ? canonicalUrl(url) : "unconfigured"))));
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const p of parts) { result.set(p, offset); offset += p.length; }
	return result;
}

const text = new TextEncoder();
function lp(value: string): Uint8Array {
	const bytes = text.encode(value), length = new Uint8Array(4);
	new DataView(length.buffer).setUint32(0, bytes.length);
	return concat(length, bytes);
}
function u64(value: number): Uint8Array {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid timestamp");
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
	return bytes;
}

export function transcript(c: Challenge): Uint8Array {
	if (c.version !== 1) throw new Error("Unsupported auth protocol");
	return concat(text.encode("freelay-auth-v1\0"), lp(c.audience), lp("session"), decode(c.id, 16), decode(c.nonce, 32), decode(c.publicKey, 32), u64(c.issuedAt), u64(c.expiresAt));
}

/** Private seed stays in SecretStorage; this service never serializes it as settings. */
export class IdentityKeyStore {
	private loading?: Promise<{ key: CryptoKey; publicKey: string }>;
	readonly audience: string;
	constructor(private readonly secrets: SecretStorage, audience: string, private readonly cryptoApi: Crypto = globalThis.crypto, private readonly slot: "active" | "replacement" = "active") {
		this.audience = canonicalUrl(audience);
	}

	private async secretId(slot: "active" | "replacement" | "previous" = this.slot): Promise<string> {
		return "freelay-identity-" + await profileStorageKey(this.audience, this.cryptoApi) + (slot === "active" ? "" : "-" + slot);
	}

	replacement(): IdentityKeyStore { return new IdentityKeyStore(this.secrets, this.audience, this.cryptoApi, "replacement"); }

	/** The caller verifies membership and obtains explicit confirmation first. */
	async activateReplacement(expectedPublicKey: string): Promise<void> {
		if (this.slot !== "active") throw new Error("Only the active identity can be replaced");
		const replacement = this.replacement();
		if (await replacement.publicKey() !== expectedPublicKey) throw new Error("Replacement identity changed");
		const id = await this.secretId(), pendingId = await this.secretId("replacement");
		const value = this.secrets.getSecret(pendingId);
		if (!value) throw new Error("Replacement identity unavailable");
		const old = this.secrets.getSecret(id);
		// Preserve a rollback key before changing the active slot. Neither key is
		// exposed to settings, URLs, the UI, or the server.
		if (old) this.secrets.setSecret(await this.secretId("previous"), old);
		this.secrets.setSecret(id, value);
		this.clearMemory();
		this.secrets.setSecret(pendingId, "");
	}

	async restorePrevious(): Promise<void> {
		const id = await this.secretId("active"), previousId = await this.secretId("previous");
		const previous = this.secrets.getSecret(previousId);
		if (!previous?.startsWith("freelay-ed25519-v1:")) throw new Error("No previous identity is stored");
		const current = this.secrets.getSecret(id);
		this.secrets.setSecret(id, previous);
		this.clearMemory();
		this.secrets.setSecret(previousId, current || "");
	}

	async eraseLocalKeys(): Promise<void> {
		for (const slot of ["replacement", "previous", "active"] as const) this.secrets.setSecret(await this.secretId(slot), "");
		this.clearMemory();
	}

	private async load(): Promise<{ key: CryptoKey; publicKey: string }> {
		const id = await this.secretId();
		let stored = this.secrets.getSecret(id);
		if (!stored) {
			// Generating/importing must succeed before persisting anything. An
			// unsupported runtime reports an actionable error, never a fallback key.
			const generated = await this.cryptoApi.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
			const jwk = await this.cryptoApi.subtle.exportKey("jwk", generated.privateKey);
			if (!jwk.d) throw new Error("Ed25519 seed unavailable");
			stored = "freelay-ed25519-v1:" + jwk.d;
			this.secrets.setSecret(id, stored);
		}
		if (!stored.startsWith("freelay-ed25519-v1:")) throw new Error("Unsupported stored identity format");
		const seed = decode(stored.slice("freelay-ed25519-v1:".length), 32);
		// RFC 8410 PKCS#8 seed wrapper. No node/Electron API is required on mobile.
		const pkcs8 = concat(new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]), seed);
		try {
			const extractable = await this.cryptoApi.subtle.importKey("pkcs8", pkcs8, "Ed25519", true, ["sign"]);
			const jwk = await this.cryptoApi.subtle.exportKey("jwk", extractable);
			if (!jwk.x) throw new Error("Ed25519 public key unavailable");
			decode(jwk.x, 32);
			const key = await this.cryptoApi.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
			return { key, publicKey: jwk.x };
		} finally { seed.fill(0); pkcs8.fill(0); }
	}

	private identity(): Promise<{ key: CryptoKey; publicKey: string }> {
		if (!this.loading) this.loading = this.load().catch(error => { this.loading = undefined; throw error; });
		return this.loading;
	}

	async publicKey(): Promise<string> { return (await this.identity()).publicKey; }
	async principal(): Promise<string> {
		return encode(new Uint8Array(await this.cryptoApi.subtle.digest("SHA-256", concat(text.encode("freelay-principal-v1\0"), decode(await this.publicKey(), 32)))));
	}
	async fingerprint(): Promise<string> {
		const hex = Array.from(decode(await this.principal(), 32).slice(0, 16), b => b.toString(16).padStart(2, "0")).join("");
		return hex.match(/.{8}/g)!.join(" ");
	}
	async sign(c: Challenge): Promise<string> {
		const identity = await this.identity();
		if (c.audience !== this.audience || c.publicKey !== identity.publicKey || c.expiresAt <= c.issuedAt || c.expiresAt - c.issuedAt > 60) throw new Error("Challenge binding mismatch");
		return encode(new Uint8Array(await this.cryptoApi.subtle.sign("Ed25519", identity.key, transcript(c))));
	}
	clearMemory(): void { this.loading = undefined; }
}
