/** Opt-in real Rust/TypeScript integration. All state is temporary, local only. */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { IdentityKeyStore } from "../../src/control/Identity";
import { SessionManager } from "../../src/control/Session";
import { ControlPlaneClient } from "../../src/control/Client";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as sync from "y-protocols/sync";

import * as vector from "./auth-v1.json";
const integration = process.env.FREELAY_SERVER_BIN ? describe : describe.skip;
integration("real Rust server", () => {
	let child: ChildProcess;
	let directory: string;
	let base: string;
	let client: ControlPlaneClient;
	let startup = "";
	let config: string;
	async function administer(...args: string[]) {
		const result = await promisify(execFile)(resolve(process.env.FREELAY_SERVER_BIN!), ["control", "--config", config, ...args]);
		return JSON.parse(result.stdout);
	}
	async function startServer() {
		startup = "";
		child = spawn(resolve(process.env.FREELAY_SERVER_BIN!),["serve","--config",config],{stdio:["ignore","pipe","pipe"]});
		child.stdout!.on("data",data=>{startup+=String(data);});
		child.stderr!.on("data",data=>{startup+=String(data);});
		for (let attempt=0; attempt<100; attempt++) {
			if (child.exitCode!==null) throw new Error("Server startup failed: "+startup);
			if (await fetch(base+"ready").then(r=>r.ok).catch(()=>false)) return;
			await new Promise(resolve=>globalThis.setTimeout(resolve,100));
		}
		throw new Error("Server did not start: "+startup);
	}
	async function stopServer() {
		if (child && child.exitCode===null) {
			const exited=new Promise<void>(resolve=>child.once("exit",()=>resolve()));
			child.kill("SIGTERM"); await exited;
		}
	}
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(),"freelay-integration-"));
		const port = await new Promise<number>(resolvePort => {
			const reservation = createServer();
			reservation.listen(0,"127.0.0.1",()=>{const address=reservation.address() as {port:number};reservation.close(()=>resolvePort(address.port));});
		});
		base = `http://127.0.0.1:${port}/base/`;
		config = join(directory,"server.toml");
		await writeFile(config,`[server]\nurl = "${base}"\nhost = "127.0.0.1"\nport = ${port}\ncheckpoint_freq_seconds = 1\n[store]\ntype = "filesystem"\npath = ${JSON.stringify(join(directory,"objects"))}\n[control]\ndatabase = ${JSON.stringify(join(directory,"control.db"))}\nowners = ["${vector.challenge.publicKey}"]\n`);
		await startServer();
		const identity=new IdentityKeyStore({getSecret:()=>"freelay-ed25519-v1:"+vector.seed,setSecret:()=>{throw new Error("test key exists");}},base,webcrypto as unknown as Crypto);
		client=new ControlPlaneClient(new SessionManager(identity));
	},15000);
	afterAll(async()=>{
		await stopServer();
		if(directory) await rm(directory,{recursive:true,force:true});
	});
	test("challenge proof, metadata, document grant, attachment round-trip, and tombstones", async()=>{
		expect((await client.me()).ownerEligible).toBe(true);
		const relay=await client.createRelay("integration");
		const folder=randomUUID();
		await client.createFolder(relay.id,folder,"shared",false);
		expect((await client.state()).folders[0].id).toBe(folder);
		const token=await client.token<{url:string;baseUrl:string;token:string;docId:string}>("token",{relay:relay.id,folder,docId:folder});
		expect(token.url).toContain("/base/d/");
		const doc=await fetch(token.baseUrl+"/as-update",{headers:{Authorization:`Bearer ${token.token}`}});
		expect(doc.status).toBe(200);
		const local=new Y.Doc();
		local.getText("content").insert(0,"offline edit");
		const socket=new WebSocket(token.url+"/"+token.docId+"?token="+encodeURIComponent(token.token));
		try {
			await new Promise<void>((resolve,reject)=>{socket.onopen=()=>resolve();socket.onerror=()=>reject(new Error("WebSocket connection failed"));});
			const message=encoding.createEncoder();
			encoding.writeVarUint(message,0); sync.writeUpdate(message,Y.encodeStateAsUpdate(local));
			socket.send(encoding.toUint8Array(message));
			let merged=false;
			for(let attempt=0;attempt<30;attempt++) {
				const response=await fetch(token.baseUrl+"/as-update",{headers:{Authorization:`Bearer ${token.token}`}});
				const received=new Y.Doc();
				Y.applyUpdate(received,new Uint8Array(await response.arrayBuffer()));
				merged=received.getText("content").toString()==="offline edit";
				received.destroy(); if(merged) break;
				await new Promise(resolve=>globalThis.setTimeout(resolve,100));
			}
			expect(merged).toBe(true);
		} finally {socket.close();local.destroy();}
		expect((await fetch(base+"doc/new",{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status).toBe(404);
		for (const [method,path] of [
			["POST",`doc/${token.docId}/auth`],
			["GET",`doc/${token.docId}/as-update`],
			["GET",`doc/ws/${token.docId}`],
			["POST",`d/${token.docId}/update`],
			["POST","webhook/reload"],
			["GET","check_store"],
		]) {
			expect((await fetch(base+path,{method,headers:{Authorization:`Bearer ${token.token}`}})).status).toBe(404);
		}
		const data=Buffer.from("Freelay attachment integration");
		const hash=createHash("sha256").update(data).digest("hex");
		const file=await client.token<{url:string;baseUrl:string;token:string}>("file-token",{relay:relay.id,folder,docId:randomUUID(),hash,contentType:"text/plain",contentLength:data.length});
		const headers={Authorization:`Bearer ${file.token}`};
		const upload=await fetch(file.baseUrl+"/upload-url",{method:"POST",headers});
		expect(upload.status).toBe(200);
		const uploadInfo=await upload.json() as {uploadUrl:string};
		expect((await fetch(uploadInfo.uploadUrl,{method:"PUT",headers:{"content-type":"text/plain"},body:data})).status).toBe(200);
		const download=await fetch(file.baseUrl+"/download-url",{headers});
		expect(download.status).toBe(200);
		const downloadInfo=await download.json() as {downloadUrl:string};
		expect(await fetch(downloadInfo.downloadUrl).then(r=>r.text())).toBe(data.toString());
		expect((await fetch(file.baseUrl,{method:"DELETE",headers})).status).toBe(405);
		const wrongKind=file.baseUrl.replace("/f/","/d/")+"/as-update";
		expect((await fetch(wrongKind,{headers})).status).toBe(401);
		await client.deleteFolder(relay.id,folder);
		expect((await client.state()).folders).toEqual([]);
		await expect(client.token("token",{relay:relay.id,folder,docId:folder})).rejects.toMatchObject({status:403});
		// Administrative revocation is bounded by existing grant/URL lifetimes,
		// not an online policy check on every data request. GC must wait for it.
		expect((await fetch(token.baseUrl+"/as-update",{headers:{Authorization:`Bearer ${token.token}`}})).status).toBe(200);
		expect(await fetch(downloadInfo.downloadUrl).then(r=>r.text())).toBe(data.toString());
	},15000);
	test("restart invalidates grants but preserves policy; sessions transparently renew", async () => {
		const relay = await client.createRelay("restart");
		const folder = randomUUID();
		await client.createFolder(relay.id, folder, "persistent", false);
		const token = await client.token<{url:string;baseUrl:string;token:string}>("token", {relay:relay.id,folder,docId:folder});
		const session = await client.sessions.getSession();
		await stopServer();
		await startServer();
		expect((await fetch(token.baseUrl+"/as-update", {headers:{Authorization:`Bearer ${token.token}`}})).status).toBe(401);
		expect((await client.me()).registered).toBe(true);
		expect((await client.sessions.getSession()).token).not.toBe(session.token);
		expect((await client.state()).folders.some(f=>f.id===folder)).toBe(true);
		const fresh = await client.token<{url:string;baseUrl:string;token:string}>("token", {relay:relay.id,folder,docId:folder});
		expect((await fetch(fresh.baseUrl+"/as-update", {headers:{Authorization:`Bearer ${fresh.token}`}})).status).toBe(200);
	}, 15000);
	test("local suspension is reversible and never schedules collection", async () => {
		const relay = await client.createRelay("suspension");
		const folder = randomUUID();
		await client.createFolder(relay.id, folder, "kept", false);
		await administer("suspend",relay.id);
		expect((await client.state()).relays.find(r=>r.id===relay.id)?.state).toBe("suspended");
		await expect(client.token("token",{relay:relay.id,folder,docId:folder})).rejects.toMatchObject({status:403});
		const records = await administer("list") as {id:string;gcNotBefore:number|null;folders:{gcNotBefore:number|null}[]}[];
		const record = records.find(r=>r.id===relay.id)!;
		expect(record.gcNotBefore).toBeNull();
		expect(record.folders.every(f=>f.gcNotBefore===null)).toBe(true);
		await administer("resume",relay.id);
		expect((await client.state()).relays.find(r=>r.id===relay.id)?.state).toBe("active");
		await expect(client.token("token",{relay:relay.id,folder,docId:folder})).resolves.toHaveProperty("token");
	},15000);
	test("removing a configured Owner takes effect on restart without deleting its relay", async () => {
		const relay = await client.createRelay("owner removal");
		const folder = randomUUID();
		await client.createFolder(relay.id,folder,"kept",false);
		const original = await readFile(config,"utf8");
		await stopServer();
		await writeFile(config,original.replace(`owners = ["${vector.challenge.publicKey}"]`,"owners = []"));
		try {
			await startServer();
			expect((await client.me()).ownerEligible).toBe(false);
			expect((await client.state()).relays.some(r=>r.id===relay.id)).toBe(false);
			await expect(client.token("token",{relay:relay.id,folder,docId:folder})).rejects.toMatchObject({status:403});
			const records = await administer("list") as {id:string;ownerless:boolean;state:string;gcNotBefore:number|null}[];
			expect(records.find(r=>r.id===relay.id)).toMatchObject({ownerless:true,state:"active",gcNotBefore:null});
		} finally {
			await stopServer();
			await writeFile(config,original);
			await startServer();
		}
		expect((await client.me()).ownerEligible).toBe(true);
		expect((await client.state()).relays.find(r=>r.id===relay.id)?.owner).toBe(true);
	},15000);
});
