import { isRetryableHttpError } from "./HttpError";
import { generateHash } from "./hashing";
import { flags } from "./flagManager";
import { checkAttachmentAbort, snapshotAttachment, streamAttachmentPut, desktopAttachmentIO, type AttachmentVersion } from "./AttachmentIO";
import { downloadAttachment, probeAttachmentSize } from "./AttachmentDownload";
import type { LiveTokenStore } from "./LiveTokenStore";
import { S3RN } from "./S3RN";
import type { SharedFolder } from "./SharedFolder";
import type { SyncFile } from "./SyncFile";
import { customFetch } from "./customFetch";
import { HasLogging } from "./debug";
import {
	s3ApiErrorFromResponse,
	s3ApiErrorFromUnknown,
	s3NetworkFailureFromUnknown,
} from "./S3Error";

// In-attempt retry schedule for transient transfer failures: one retry per
// entry, each entry the delay cap for that round. Full jitter spreads the
// retries of a bulk transfer hitting one server blip apart instead of
// re-hammering in lockstep.
const TRANSFER_RETRY_DELAYS_MS: readonly number[] = [500, 2000];

export interface ContentAddressedStoreOptions {
	transferRetryDelaysMs?: readonly number[];
}

export class ContentAddressedStore extends HasLogging {
	private tokenStore: LiveTokenStore;
	private transferRetryDelaysMs: readonly number[];

	constructor(
		private sharedFolder: SharedFolder,
		options?: ContentAddressedStoreOptions,
	) {
		super();
		this.tokenStore = sharedFolder.tokenStore;
		this.transferRetryDelaysMs =
			options?.transferRetryDelaysMs ?? TRANSFER_RETRY_DELAYS_MS;
	}

	async verify(syncFile: SyncFile): Promise<boolean> {
		if (!syncFile.meta) {
			throw new Error("cannot head file with missing hash");
		}
		const sha256 = syncFile.meta.hash;
		const response = await this.fileRequest(syncFile, sha256, 0, "", "HEAD");
		return response.status === 200;
	}

	async readFile(syncFile: SyncFile): Promise<ArrayBuffer> {
		if (!syncFile.meta) {
			throw new Error("cannot pull file with missing hash");
		}
		const sha256 = syncFile.meta.hash;
		const meta = syncFile.meta;
		return this.withTransientRetry("download attachment", async () => {
			const response = await this.fileRequest(syncFile, sha256, 0, "/download-url", "GET");
			if (!response.ok) {
				this.debug(
					`[${this.sharedFolder.path}] File download-url failed: ${response.status} for ${syncFile.guid} ${meta.hash} ${meta.type}`,
				);
				throw await this.s3ResponseError(response, "download attachment url");
			}
			const responseJson = (await response.json()) as { downloadUrl: string };
			const presignedUrl = responseJson.downloadUrl;
			const downloadResponse = await this.s3Request(
				() => customFetch(presignedUrl, { relayNetworkDomain: "external" }),
				"download attachment",
			);
			if (!downloadResponse.ok) {
				throw await this.s3ResponseError(
					downloadResponse,
					"download attachment",
				);
			}
			return downloadResponse.arrayBuffer();
		});
	}

	/**
	 * Run a transfer, retrying transient failures (5xx/throttle-class answers
	 * and network-level transport errors) a bounded number of times with
	 * jittered backoff. Permanent classes (auth/permission) are never
	 * retried. Whatever finally escapes is classified, so the background
	 * queue above can decide whether to re-drive the operation later.
	 */
	private async withTransientRetry<T>(
		operation: string,
		request: () => Promise<T>,
	): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await request();
			} catch (error) {
				const classified =
					s3NetworkFailureFromUnknown(error, operation) ?? error;
				const delayCapMs = this.transferRetryDelaysMs[attempt];
				if (!isRetryableHttpError(classified) || delayCapMs === undefined) {
					throw classified;
				}
				// Full jitter within the round's cap.
				const delayMs = Math.floor(Math.random() * (delayCapMs + 1));
				this.debug(
					`transient ${operation} failure (attempt ${attempt + 1}); retrying in ${delayMs}ms`,
					classified,
				);
				await new Promise<void>((resolve) =>
					this.sharedFolder.timeProvider.setTimeout(resolve, delayMs),
				);
			}
		}
	}

	private async downloadUrl(syncFile: SyncFile, hash: string): Promise<string> {
		const response = await this.fileRequest(syncFile, hash, 0, "/download-url", "GET");
		if (!response.ok) throw await this.s3ResponseError(response, "download attachment url");
		return (await response.json() as { downloadUrl: string }).downloadUrl;
	}

	async fileSize(syncFile: SyncFile, hash: string): Promise<number> {
		return this.s3Request(async () => probeAttachmentSize(await this.downloadUrl(syncFile, hash)), "probe attachment size");
	}

	async downloadTo(syncFile: SyncFile, path: string, signal: AbortSignal, progress: (bytes: number, total: number) => void): Promise<void> {
		const meta = syncFile.meta!;
		const getUrl = async () => {
			checkAttachmentAbort(signal);
			return this.downloadUrl(syncFile, meta.hash);
		};
		await this.s3Request(() => downloadAttachment(syncFile.vault, getUrl, path, meta.hash, signal, progress), "download attachment");
	}

	private async writeStreaming(syncFile: SyncFile): Promise<AttachmentVersion> {
		const manager = this.sharedFolder.attachmentTransfers!;
		const task = syncFile.attachmentTask();
		return manager.run(task, async (row, signal) => {
			const snapshot = manager.partialPath(task, "upload");
			try {
				row.phase = "preparing";
				const version = await snapshotAttachment(syncFile.vault, task.path, snapshot, signal, (bytes, total) => {
					row.bytes = bytes; row.total = total; manager.notifyListeners();
				});
				await this.withTransientRetry("upload attachment", async () => {
					checkAttachmentAbort(signal);
					const response = await this.fileRequest(syncFile, version.hash, version.size, "/upload-url", "POST");
					if (!response.ok) throw await this.s3ResponseError(response, "upload attachment url");
					const { uploadUrl } = await response.json() as { uploadUrl: string };
					row.phase = "uploading"; row.bytes = 0; manager.notifyListeners();
					const status = await streamAttachmentPut(syncFile.vault, uploadUrl, snapshot, version.size, syncFile.mimetype, signal, bytes => { row.bytes = bytes; manager.notifyListeners(); });
					if (status < 200 || status >= 300) throw s3ApiErrorFromResponse(status, "", "upload attachment");
				});
				return version;
			} finally {
				if (await manager.vault.adapter.exists(snapshot)) await manager.vault.adapter.remove(snapshot);
			}
		});
	}

	async writeFile(syncFile: SyncFile): Promise<AttachmentVersion | undefined> {
		if (!this.sharedFolder.canWriteContent) {
			throw new Error(
				`Cannot upload ${syncFile.path}: read-only access`,
			);
		}
		if (flags().enableStreamingUploads && this.sharedFolder.attachmentTransfers && await desktopAttachmentIO(syncFile.vault)) return this.writeStreaming(syncFile);
		return this.s3Request(() => this.writeBuffered(syncFile), "upload attachment");
	}

	private async writeBuffered(syncFile: SyncFile, signal?: AbortSignal): Promise<AttachmentVersion> {
		if (signal) checkAttachmentAbort(signal);
		const mtime = syncFile.stat.mtime;
		const content = await syncFile.caf.read();
		if (!content) throw new Error("Attachment is missing");
		const hash = await generateHash(content);
		if (signal) checkAttachmentAbort(signal);
		this.log("writeFile", hash);
		if (!(content && hash)) {
			throw new Error("invalid caf");
		}
		const response = await this.fileRequest(syncFile, hash, content.byteLength, "/upload-url", "POST");
		if (response.status !== 200) {
			throw await this.s3ResponseError(response, "upload attachment url");
		}
		const responseJson = (await response.json()) as { uploadUrl: string };
		const presignedUrl = responseJson.uploadUrl;
		const uploadResponse = await this.s3Request(
			() =>
				customFetch(presignedUrl, {
					method: "PUT",
					headers: { "Content-Type": syncFile.mimetype },
					body: content,
					relayNetworkDomain: "external",
				}),
			"upload attachment",
		);
		if (!uploadResponse.ok) {
			throw await this.s3ResponseError(uploadResponse, "upload attachment");
		}
		if (signal) checkAttachmentAbort(signal);
		return { hash, size: content.byteLength, mtime };
	}

	/** A process restart invalidates an otherwise unexpired scoped capability. */
	private async fileRequest(syncFile: SyncFile, hash: string, length: number, suffix: string, method: string): Promise<Response> {
		for (let attempt = 0; ; attempt++) {
			const token = await this.tokenStore.getFileToken(S3RN.encode(syncFile.s3rn), hash, syncFile.mimetype, length, attempt > 0);
			const response = await customFetch(token.baseUrl + suffix, {method, headers: {Authorization: `Bearer ${token.token}`}, relayNetworkDomain: "relay"});
			// Do not retry policy denials or send this bearer to a presigned URL.
			if (response.status !== 401 || attempt > 0) return response;
		}
	}

	private async s3Request<T>(
		request: () => Promise<T>,
		operation: string,
	): Promise<T> {
		try {
			return await request();
		} catch (error) {
			throw (
				s3ApiErrorFromUnknown(error, operation) ??
				s3NetworkFailureFromUnknown(error, operation) ??
				error
			);
		}
	}

	private async s3ResponseError(
		response: Response,
		operation: string,
	): Promise<Error> {
		let body = "";
		try {
			body = await response.text();
		} catch {
			// Ignore body parsing errors; the status still carries useful context.
		}
		return s3ApiErrorFromResponse(response.status, body, operation);
	}

	public destroy() {
		this.tokenStore = null as unknown as typeof this.tokenStore;
		this.sharedFolder = null as unknown as typeof this.sharedFolder;
	}
}
