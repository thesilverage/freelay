import { webcrypto } from "node:crypto";
import { IdentityKeyStore, encode } from "../../src/control/Identity";
import { SessionManager, type Transport } from "../../src/control/Session";
import { ControlPlaneClient } from "../../src/control/Client";

function harness() {
	const values = new Map<string, string>();
	const identity = new IdentityKeyStore({getSecret: k => values.get(k) ?? null, setSecret: (k,v) => {values.set(k,v);}},"https://example.test/base/",webcrypto as unknown as Crypto);
	let authentications = 0;
	const calls: {url: string; options: RequestInit}[] = [];
	let handler: Transport = async () => new Response(JSON.stringify({ok:true}));
	const transport: Transport = async (url,options) => {
		calls.push({url,options});
		expect(options.redirect).toBe("error");
		expect(options.credentials).toBe("omit");
		if (url.endsWith("/challenges")) return new Response(JSON.stringify({version:1,id:encode(new Uint8Array(16)),nonce:encode(new Uint8Array(32)),audience:identity.audience,publicKey:await identity.publicKey(),issuedAt:100,expiresAt:160}));
		if (url.endsWith("/sessions")) { authentications++; return new Response(JSON.stringify({principal:await identity.principal(),token:encode(new Uint8Array(32).fill(authentications)),expiresAt:Math.floor(Date.now()/1000)+900})); }
		return handler(url,options);
	};
	const sessions = new SessionManager(identity,transport);
	return {sessions, calls, authentications: () => authentications, setHandler: (next: Transport) => {handler=next;}};
}

test("concurrent callers share one authentication and headers cannot replace bearer", async () => {
	const h = harness();
	await Promise.all(Array.from({length:10},() => h.sessions.api("api/v1/me",{headers:new Headers({Authorization:"wrong"})})));
	expect(h.authentications()).toBe(1);
	const calls=h.calls.filter(c=>c.url.endsWith("/me"));
	expect(calls).toHaveLength(10);
	for(const c of calls) expect(new Headers(c.options.headers).get("authorization")).not.toBe("wrong");
});

test("a stale session retries once; policy denials do not reauthenticate", async () => {
	const h=harness(); let count=0;
	h.setHandler(async()=>++count===1 ? new Response("{}",{status:401}) : new Response("{}"));
	await h.sessions.api("token");
	expect(h.authentications()).toBe(2);
	h.setHandler(async()=>new Response(JSON.stringify({code:"operation_denied"}),{status:403}));
	await expect(h.sessions.api("token")).rejects.toMatchObject({status:403,code:"operation_denied",retryable:false});
	expect(h.authentications()).toBe(2);
});

test("metadata ETag reuse, logout, and unsafe returned data URLs", async () => {
	const h=harness(); const client=new ControlPlaneClient(h.sessions);
	const state={relays:[],folders:[],memberships:[],folderMemberships:[],profiles:[],invitations:[]};
	let calls=0;
	h.setHandler(async(url,options)=>{
		if(url.endsWith("/state")) {
			calls++;
			if(calls===2) {expect(new Headers(options.headers).get("if-none-match")).toBe('"state1"');return new Response(null,{status:304});}
			return new Response(JSON.stringify(state),{headers:{etag:'"state1"'}});
		}
		return new Response(JSON.stringify({url:"wss://evil.test/d/a/ws",token:"untrusted"}));
	});
	expect(await client.state()).toEqual(state);
	expect(await client.state()).toEqual(state);
	await expect(client.token("token",{})).rejects.toThrow("Unsafe data-plane URL");
	await expect(h.sessions.api("https://evil.test/")).rejects.toThrow("Invalid API path");
	await h.sessions.logout();
	await h.sessions.getSession();
	expect(h.authentications()).toBe(2);
});

test("a conflicting mutation waits out stale polling and refreshes the revision before retry", async () => {
	const h=harness(), client=new ControlPlaneClient(h.sessions);
	const state=(revision:number)=>({relays:[{id:"relay",name:"name",state:"active",owner:true,access:null,revision}],folders:[],memberships:[],folderMemberships:[],profiles:[],invitations:[]});
	let stateCalls=0, mutationCalls=0;
	let releasePoll!: (value:Response)=>void;
	let notifyConflict!: ()=>void;
	const conflicting=new Promise<void>(resolve=>{notifyConflict=resolve;});
	h.setHandler(async(url,options)=>{
		if(url.endsWith("/state")) {
			stateCalls++;
			if(stateCalls===2) return new Promise<Response>(resolve=>{releasePoll=resolve;});
			return new Response(JSON.stringify(state(stateCalls===1 ? 1 : 2)));
		}
		mutationCalls++;
		expect(new Headers(options.headers).get("if-match")).toBe(mutationCalls===1 ? '"1"' : '"2"');
		if(mutationCalls===1) {notifyConflict();return new Response('{"code":"revision_conflict"}',{status:412});}
		return new Response(null,{status:204});
	});
	await client.state();
	const oldPoll=client.state();
	const mutation=client.renameRelay("relay","new");
	const rejected=expect(mutation).rejects.toMatchObject({status:412});
	await conflicting;
	releasePoll(new Response(JSON.stringify(state(1))));
	await oldPoll;
	await rejected;
	expect(stateCalls).toBe(3);
	await client.renameRelay("relay","retry");
	expect(mutationCalls).toBe(2);
});
