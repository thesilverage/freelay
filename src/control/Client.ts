import { SessionManager } from "./Session";

export type Access = "read" | "write";
export interface Profile { id: string; name: string | null; publicKey: string; ownerEligible: boolean; registered: boolean }
export interface RelayRecord { id: string; name: string; state: "active" | "suspended"; owner: boolean; access: Access | null; revision?: number }
export interface FolderRecord { id: string; relay: string; name: string; private: boolean; revision: number; access: Access; creator: string }
export type FolderCreated = Pick<FolderRecord, "id" | "relay" | "name" | "private">;
export interface Membership { relay: string; principal: string; access: Access | "owner" }
export interface FolderMembership { relay: string; folder: string; principal: string; access: Access }
export interface InvitationRecord { id: string; relay: string; folder: string | null; access: Access; expiresAt: number; maxUses: number; uses: number; enabled: boolean }
export interface Snapshot {
	relays: RelayRecord[];
	folders: FolderRecord[];
	memberships: Membership[];
	folderMemberships: FolderMembership[];
	invitations: InvitationRecord[];
	profiles: {id: string; name: string; ownerEligible: boolean}[];
}

/** REST transport only. Existing observable/domain adapters own UI state. */
export class ControlPlaneClient {
	onPolicyDenied?: () => void;
	private cached?: {etag: string | null; value: Snapshot};
	private pending?: Promise<Snapshot>;
	private generation = 0;
	constructor(readonly sessions: SessionManager) {}

	me(): Promise<Profile> { return this.sessions.api("api/v1/me"); }
	async profile(name: string): Promise<Profile> { await this.mutate("api/v1/me", "PATCH", {name}); return this.me(); }
	async state(): Promise<Snapshot> {
		if (!this.pending) {
			const generation = this.generation;
			this.pending = (async () => {
				const response = await this.sessions.apiResponse("api/v1/state", {headers: this.cached?.etag ? {"If-None-Match": this.cached.etag} : {}});
				if (response.status === 304) {
					if (!this.cached) throw new Error("State cache unavailable");
					return this.cached.value;
				}
				const value = await response.json() as Snapshot;
				if (generation === this.generation) this.cached = {etag: response.headers.get("etag"), value};
				return value;
			})().finally(() => { this.pending = undefined; });
		}
		return this.pending;
	}
	async mutate<T>(path: string, method: string, body?: unknown): Promise<T> {
		const headers: Record<string, string> = {};
		if (path.startsWith("api/v1/relays/") && (method === "PATCH" || (method === "POST" && path.includes("/members/")))) {
			const relay = (this.cached?.value || await this.state()).relays.find(r => r.id === decodeURIComponent(path.split("/")[3]));
			if (relay?.revision !== undefined) headers["If-Match"] = '"' + relay.revision + '"';
		}
		const response = await this.sessions.api<T>(path, {method, headers, ...(body === undefined ? {} : {body: JSON.stringify(body)})}).catch(async error => {
			if (error?.status === 412) {
				this.generation++; this.cached = undefined;
				// A poll begun before the conflicting edit must not repopulate
				// the cache or stand in for the authoritative conflict refresh.
				await this.pending?.catch(() => undefined);
				await this.state();
			}
			throw error;
		});
		this.generation++; this.cached = undefined;
		// Do not allow a pre-mutation snapshot to win the subsequent refresh.
		await this.pending?.catch(() => undefined);
		return response;
	}
	createRelay(name: string): Promise<{id: string}> { return this.mutate("api/v1/relays", "POST", {name}); }
	renameRelay(id: string, name: string): Promise<void> { return this.mutate(`api/v1/relays/${encodeURIComponent(id)}`, "PATCH", {name}); }
	deleteRelay(id: string): Promise<{gcNotBefore: number}> { return this.mutate(`api/v1/relays/${encodeURIComponent(id)}`, "DELETE"); }
	createFolder(relay: string, id: string, name: string, isPrivate: boolean): Promise<FolderCreated> { return this.mutate(`api/v1/relays/${encodeURIComponent(relay)}/folders`, "POST", {id, name, private: isPrivate}); }
	updateFolder(folder: FolderRecord): Promise<void> { return this.mutate(`api/v1/relays/${encodeURIComponent(folder.relay)}/folders/${encodeURIComponent(folder.id)}`, "PATCH", {name: folder.name, private: folder.private}); }
	deleteFolder(relay: string, id: string): Promise<{gcNotBefore: number}> { return this.mutate(`api/v1/relays/${encodeURIComponent(relay)}/folders/${encodeURIComponent(id)}`, "DELETE"); }
	invite(relay: string, access: Access, folder?: string, maxUses = 1, ttlSeconds = 86400): Promise<{id: string; code: string}> { return this.mutate(`api/v1/relays/${encodeURIComponent(relay)}/invitations`, "POST", {access, folder, maxUses, ttlSeconds}); }
	revokeInvitation(relay: string, id: string): Promise<void> { return this.mutate(`api/v1/relays/${encodeURIComponent(relay)}/invitations/${encodeURIComponent(id)}`, "DELETE"); }
	accept(code: string, name: string): Promise<{relay: string}> { return this.mutate("api/v1/invitations/accept", "POST", {code, name}); }
	async token<T extends {url: string; baseUrl?: string}>(path: "token" | "file-token", body: unknown): Promise<T> {
		const token = await this.sessions.api<T>(path, {method: "POST", body: JSON.stringify(body)}).catch(error => {
			if (error?.status === 403) this.onPolicyDenied?.();
			throw error;
		});
		// Only scoped data-plane URLs are pinned. Presigned S3 URLs returned by
		// the data plane are separate capabilities, with no session attached.
		for (const value of [token.url, token.baseUrl].filter((s): s is string => !!s)) {
			const url = new URL(value);
			if (url.protocol === "wss:") url.protocol = "https:";
			if (url.protocol === "ws:") url.protocol = "http:";
			const base = new URL(this.sessions.identity.audience);
			if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password || url.hash || url.search) throw new Error("Unsafe data-plane URL");
		}
		return token;
	}
}
