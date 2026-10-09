import { User } from "./User";
import { Observable } from "./observable/Observable";
import type { TimeProvider } from "./TimeProvider";
import type { NamespacedSettings } from "./SettingsStorage";
import type { EndpointManager } from "./EndpointManager";
import { IdentityKeyStore, type SecretStorage } from "./control/Identity";
import { SessionManager } from "./control/Session";
import { ControlPlaneClient, type Profile } from "./control/Client";
import { controlTransport } from "./control/Transport";

export interface LoginSettings { provider?: string; name?: string; connected?: boolean }

/** Installation identity; no OAuth, persisted bearer, or vendor connection. */
export class LoginManager extends Observable<LoginManager> {
	user?: User;
	profile?: Profile;
	control?: ControlPlaneClient;
	private generation = 0;
	private readonly startupUrl: string;
	private replacementControl?: ControlPlaneClient;
	constructor(
		vaultName: string,
		private openSettings: () => Promise<void>,
		timeProvider: TimeProvider,
		beforeLogin: () => void,
		public loginSettings: NamespacedSettings<LoginSettings>,
		private endpointManager: EndpointManager,
		private secrets: SecretStorage,
	) { super(); this.startupUrl = endpointManager.getApiUrl(); }

	get loggedIn(): boolean { return this.user !== undefined; }
	get hasUser(): boolean { return this.loggedIn; }
	getEndpointManager(): EndpointManager { return this.endpointManager; }
	getAccountEmailForRequest(): string { return ""; }
	getWebviewIntercepts(): RegExp[] { return []; }
	getFlags(): void { /* Freelay has no remotely supplied feature flags. */ }
	whoami(): Profile | undefined { return this.profile; }

	identity(): IdentityKeyStore {
		const url = this.endpointManager.getApiUrl();
		if (url !== this.startupUrl) throw new Error("Reload Freelay to apply the server change safely.");
		if (!url) throw new Error("Configure your Freelay server URL first.");
		if (!this.secrets) throw new Error("Freelay requires Obsidian 1.11.5 or newer with Secret Storage.");
		if (!this.control || this.control.sessions.identity.audience !== url + "/") {
			this.control = new ControlPlaneClient(new SessionManager(new IdentityKeyStore(this.secrets, url),controlTransport));
		}
		return this.control.sessions.identity;
	}

	async login(): Promise<boolean> {
		const generation = this.generation;
		this.identity();
		const control = this.control!;
		const profile = await control.me();
		if (generation !== this.generation || control !== this.control) return false;
		this.profile = profile;
		this.user = new User(profile.id, profile.name || this.loginSettings.get().name || "Freelay user", "", "", "");
		await this.loginSettings.update(s => ({...s, connected: true}));
		this.notifyListeners();
		return true;
	}

	replacement(): ControlPlaneClient {
		const active = this.identity();
		if (!this.replacementControl || this.replacementControl.sessions.identity.audience !== active.audience) {
			this.replacementControl = new ControlPlaneClient(new SessionManager(active.replacement(), controlTransport));
		}
		return this.replacementControl;
	}

	async activateReplacement(): Promise<void> {
		const next = this.replacement();
		const profile = await next.me();
		if (!profile.registered) throw new Error("First add the replacement key to the server or accept an invitation with it.");
		const nextState = await next.state();
		if (this.profile?.registered && this.control) {
			const current = await this.control.state();
			if (current.relays.some(r => r.owner && !nextState.relays.some(n => n.id === r.id && n.owner))) {
				throw new Error("The administrator must assign the replacement key to every relay you own before activation.");
			}
		}
		const active = this.identity();
		const publicKey = await next.sessions.identity.publicKey();
		this.logout();
		await active.activateReplacement(publicKey);
		await this.login();
	}

	async restorePreviousIdentity(): Promise<void> {
		const active = this.identity(); this.logout();
		await active.restorePrevious(); await this.login();
	}

	async eraseLocalIdentity(): Promise<void> {
		const active = this.identity(); this.logout();
		await active.eraseLocalKeys();
	}

	setup(): boolean {
		if (this.loginSettings.get().connected && this.endpointManager.getApiUrl()) {
			void this.login().catch(() => { /* Offline startup retains local content. Settings offers retry. */ });
		}
		return this.loggedIn;
	}
	async setName(name: string): Promise<void> {
		await this.loginSettings.update(s => ({...s, name}));
		if (this.profile?.registered) await this.control!.profile(name);
		await this.login();
	}
	logout(): void {
		this.generation++;
		void this.replacementControl?.sessions.logout().catch(() => undefined);
		this.replacementControl = undefined;
		const control = this.control;
		this.control = undefined; this.profile = undefined; this.user = undefined;
		void this.loginSettings.update(s => ({...s, connected: false}));
		void control?.sessions.logout().catch(() => undefined);
		this.notifyListeners();
	}
	async validateAndApplyEndpoints(): Promise<{success: boolean; error?: string; licenseInfo?: unknown}> {
		this.logout();
		return this.endpointManager.validateAndSetEndpoints();
	}
	async openLoginPage(): Promise<boolean> { await this.openSettings(); return this.loggedIn; }
	override destroy(): void {
		this.generation++;
		void this.replacementControl?.sessions.logout().catch(() => undefined);
		this.replacementControl = undefined;
		void this.control?.sessions.logout().catch(() => undefined);
		this.control = undefined; this.user = undefined; this.profile = undefined;
		super.destroy();
	}
}
