// This file is the Obsidian Live variant of the token store.
import { TokenStore } from "./TokenStore";
import type { RefreshContext, TokenInfo } from "./TokenStore";
import type { TimeProvider } from "./TimeProvider";
import { LoginManager } from "./LoginManager";
import { curryLog } from "./debug";
import type { ClientToken, FileToken } from "./client/types";
import {
	S3RN,
	S3RemoteDocument,
	type S3RNType,
	S3RemoteFolder,
	S3RemoteFile,
	S3RemoteCanvas,
} from "./S3RN";

function getJwtExpiryFromClientToken(clientToken: ClientToken): number {
	// lol this is so fake
	return clientToken.expiryTime || 0;
}

function fileTokenKey(
	documentId: string,
	fileHash: string,
	contentType: string,
	contentLength: number,
): string {
	// Read and upload grants can differ even for identical file content.
	return JSON.stringify([documentId, fileHash, contentType, contentLength]);
}

function withLoginManager<Args extends unknown[]>(
	loginManager: LoginManager,
	deviceId: string,
	fn: (
		loginManager: LoginManager,
		deviceId: string,
		...args: Args
	) => void | Promise<void>,
) {
	return (...args: Args) => {
		void fn(loginManager, deviceId, ...args);
	};
}

export async function refresh(
	loginManager: LoginManager,
	deviceId: string,
	documentId: string,
	onSuccess: (clientToken: ClientToken) => void,
	onError: (err: Error) => void,
	context?: RefreshContext<ClientToken>,
) {
	const debug = curryLog("[TokenStore][Refresh]", "debug");
	debug(`${documentId}`);
	const entity: S3RNType = S3RN.decode(documentId);
	let payloadObj: Record<string, string | boolean>;
	if (entity instanceof S3RemoteDocument) {
		payloadObj = {
			docId: entity.documentId,
			relay: entity.relayId,
			folder: entity.folderId,
		};
	} else if (entity instanceof S3RemoteCanvas) {
		payloadObj = {
			docId: entity.canvasId,
			relay: entity.relayId,
			folder: entity.folderId,
		};
	} else if (entity instanceof S3RemoteFolder) {
		payloadObj = {
			docId: entity.folderId,
			relay: entity.relayId,
			folder: entity.folderId,
		};
	} else if (entity instanceof S3RemoteFile) {
		payloadObj = {
			docId: entity.fileId,
			relay: entity.relayId,
			folder: entity.folderId,
		};
	} else {
		onError(new Error("No remote to connect to"));
		return;
	}
	if (!loginManager.loggedIn) {
		onError(Error("Not logged in"));
		return;
	}
	if (deviceId) {
		payloadObj.device = deviceId;
	}
	if (context?.reconcile && context.heldToken?.token) {
		// Submitting the held token asks the server to bypass its auth cache.
		payloadObj.supersede = context.heldToken.token;
	}
	try {
		const client = loginManager.control;
		if (!client) throw new Error("Not connected");
		const token = await client.token<ClientToken>("token", payloadObj);
		if (!loginManager.loggedIn || loginManager.control !== client) throw new Error("Connection changed during token request");
		onSuccess(token);
	} catch (reason) {
		onError(reason as Error);
	}
}

export class LiveTokenStore extends TokenStore<ClientToken> {
	private deviceId: string;

	/** WebSocket handshakes hide HTTP status. Reconnect obtains a fresh grant. */
	invalidateDocument(documentId: string): void {
		const cached = this.tokenMap.get(documentId);
		if (cached) this.tokenMap.set(documentId, {...cached, expiryTime: 0});
	}

	constructor(
		private loginManager: LoginManager,
		timeProvider: TimeProvider,
		vaultName: string,
		deviceId: string,
		maxConnections = 5,
		refreshJitterSeed?: string,
	) {
		super(
			{
				log: curryLog("[LiveTokenStore]", "debug"),
				refresh: withLoginManager(loginManager, deviceId, refresh),
				getJwtExpiry: getJwtExpiryFromClientToken,
				getStorage: function () {
					// Grants are cheap to reacquire and must not survive profile changes.
					return new Map<string, TokenInfo<ClientToken>>();
				},
				getTimeProvider: () => {
					return timeProvider;
				},
				refreshJitterSeed: refreshJitterSeed
					? `${refreshJitterSeed}:${deviceId}`
					: undefined,
			},
			maxConnections,
		);
		this.deviceId = deviceId;
	}

	private async getFileTokenFromNetwork(
		documentId: string,
		fileHash: string,
		contentType: string,
		contentLength: number,
	): Promise<FileToken> {
		if (this.isDestroyed()) {
			return Promise.reject(this.getDestroyedError());
		}
		const key = fileTokenKey(documentId, fileHash, contentType, contentLength);
		const activePromise = this._activePromises.get(key);
		if (activePromise) {
			return activePromise as Promise<FileToken>;
		}
		this.tokenMap.set(key, {
			token: null,
			expiryTime: 0,
			attempts: 0,
		} as TokenInfo<ClientToken>);
		const sharedPromise = this.fetchFileToken(
			documentId,
			fileHash,
			contentType,
			contentLength,
		)
			.then((newToken: FileToken) => {
				if (this.isDestroyed()) {
					throw this.getDestroyedError();
				}
				const expiryTime = this.getJwtExpiry(newToken);
				const existing = this.tokenMap.get(key)!;
				this.tokenMap.set(key, {
					...existing,
					token: newToken,
					expiryTime,
				});
				return newToken;
			})
			.catch((err: Error) => {
				if (this.isDestroyed()) {
					throw this.getDestroyedError();
				}
				throw err;
			})
			.finally(() => {
				this._activePromises?.delete(key);
			});
		this._activePromises.set(key, sharedPromise);
		return sharedPromise;
	}

	async fetchFileToken(
		documentId: string,
		fileHash: string,
		contentType: string,
		contentLength: number,
	): Promise<FileToken> {
		if (this.isDestroyed()) {
			throw this.getDestroyedError();
		}
		const debug = curryLog("[TokenStore][Fetch]", "debug");
		debug(`${documentId}`);
		const entity: S3RNType = S3RN.decode(documentId);
		let payload: string;
		if (entity instanceof S3RemoteFile) {
			const payloadObj: Record<string, string | number> = {
				docId: entity.fileId,
				relay: entity.relayId,
				folder: entity.folderId,
				hash: fileHash,
				contentType,
				contentLength,
			};
			if (this.deviceId) {
				payloadObj.device = this.deviceId;
			}
			payload = JSON.stringify(payloadObj);
		} else {
			throw new Error(`No remote to connect to for ${documentId}`);
		}
		if (!this.loginManager.loggedIn) {
			throw new Error("Not logged in");
		}
		const client = this.loginManager.control;
		if (!client) throw new Error("Not connected");
		const token = await client.token<FileToken>("file-token", JSON.parse(payload));
		if (!this.loginManager.loggedIn || this.loginManager.control !== client) throw new Error("Connection changed during token request");
		return token;
	}

	async getFileToken(
		documentId: string,
		fileHash: string,
		contentType: string,
		contentLength: number,
		force = false,
	): Promise<FileToken> {
		if (this.isDestroyed()) {
			return Promise.reject(this.getDestroyedError());
		}
		const key = fileTokenKey(documentId, fileHash, contentType, contentLength);
		const tokenInfo = this.tokenMap.get(key);
		// Leave time to exchange the cached token for a transfer URL.
		if (
			!force && tokenInfo?.token &&
			this.isTokenValid(tokenInfo) &&
			!this.shouldRefresh(tokenInfo)
		) {
			this.log("token was valid, cache hit!");
			this._activePromises.delete(key);
			return Promise.resolve(tokenInfo.token as FileToken);
		}
		return this.getFileTokenFromNetwork(
			documentId,
			fileHash,
			contentType,
			contentLength,
		);
	}

	override destroy(): void {
		super.destroy();
		this.loginManager = null as unknown as typeof this.loginManager;
		this.deviceId = null as unknown as typeof this.deviceId;
	}
}
