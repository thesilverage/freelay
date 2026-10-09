import { IdentityKeyStore, type Challenge } from "./Identity";
import { HttpError } from "../HttpError";

export interface Session { token: string; principal: string; expiresAt: number }
export type Transport = (url: string, options: RequestInit) => Promise<Response>;

export class ControlPlaneError extends HttpError {
	constructor(readonly status: number, readonly code: string) { super(status, code); }
}

/** One in-flight authentication per installation. Session bearers stay in memory. */
export class SessionManager {
	private session?: Session;
	private pending?: Promise<Session>;
	private generation = 0;
	constructor(readonly identity: IdentityKeyStore, private readonly transport: Transport = fetch) {}

	private async send(url: string, options: RequestInit): Promise<Response> {
		const controller = new AbortController();
		const abort = () => controller.abort();
		options.signal?.addEventListener("abort", abort, {once: true});
		if (options.signal?.aborted) controller.abort();
		const timeout = globalThis.setTimeout(abort, 15000);
		try { return await this.transport(url, {...options, signal: controller.signal}); }
		finally { globalThis.clearTimeout(timeout); options.signal?.removeEventListener("abort", abort); }
	}

	private async request<T>(path: string, body: unknown, bearer?: string): Promise<T> {
		const response = await this.send(this.identity.audience + path, {
			method: "POST", redirect: "error", credentials: "omit",
			headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
			body: JSON.stringify(body),
		});
		if (!response.ok) throw new ControlPlaneError(response.status, "authentication_failed");
		return await response.json() as T;
	}

	async getSession(): Promise<Session> {
		if (this.session && this.session.expiresAt - Date.now() / 1000 > 300) return this.session;
		if (!this.pending) {
			const generation = this.generation;
			this.pending = (async () => {
				const publicKey = await this.identity.publicKey();
				const c = await this.request<Challenge>("api/v1/auth/challenges", {version: 1, publicKey});
				const signature = await this.identity.sign(c);
				const result = await this.request<Session>("api/v1/auth/sessions", {id: c.id, publicKey, signature}, this.session?.token);
				if (result.principal !== await this.identity.principal() || result.expiresAt <= Date.now() / 1000) throw new Error("Invalid session response");
				if (generation !== this.generation) throw new Error("Authentication cancelled");
				this.session = result;
				return result;
			})().finally(() => { this.pending = undefined; });
		}
		return this.pending;
	}

	invalidate(token?: string): void {
		if (!token || this.session?.token === token) this.session = undefined;
	}

	async logout(): Promise<void> {
		const old = this.session; this.generation++; this.session = undefined;
		this.identity.clearMemory();
		if (old) await this.send(this.identity.audience + "api/v1/auth/session", {method: "DELETE", redirect: "error", credentials: "omit", headers: {Authorization: `Bearer ${old.token}`}});
	}

	async api<T>(path: string, options: RequestInit = {}): Promise<T> {
		const response = await this.apiResponse(path, options);
		return response.status === 204 ? undefined as T : await response.json() as T;
	}

	async apiResponse(path: string, options: RequestInit = {}): Promise<Response> {
		if (path.startsWith("/") || path.includes("..") || path.includes(":") || path.includes("\\")) throw new Error("Invalid API path");
		for (let attempt = 0; attempt < 2; attempt++) {
			const session = await this.getSession();
			const headers = new Headers(options.headers);
			headers.set("Content-Type", "application/json");
			headers.set("Authorization", `Bearer ${session.token}`);
			const response = await this.send(this.identity.audience + path, {
				...options, redirect: "error", credentials: "omit",
				headers,
			});
			if (response.status === 401 && attempt === 0) { this.invalidate(session.token); continue; }
			if (!response.ok && response.status !== 304) {
				const error = await response.json().catch(() => null) as {code?: unknown} | null;
				throw new ControlPlaneError(response.status, typeof error?.code === "string" ? error.code : "request_failed");
			}
			return response;
		}
		throw new Error("Authentication failed");
	}
}
