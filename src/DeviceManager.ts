import { Platform } from "obsidian";
import type { LoginManager } from "./LoginManager";
import { Observable } from "./observable/Observable";

/** Local sync jitter/device label only; the control plane authenticates keys. */
export class DeviceManager extends Observable<DeviceManager> {
	constructor(private appId: string, private loginManager: LoginManager) { super("DeviceManager"); }
	getDeviceId(): string { return this.appId; }
	getPlatform(): string { return Platform.isMobile ? "Mobile" : "Desktop"; }
	async register(): Promise<void> { /* No device registry in Freelay. */ }
}
