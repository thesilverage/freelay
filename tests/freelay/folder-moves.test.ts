import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import * as Y from "yjs";

class File { constructor(public path: string) {} }
class Folder extends File { constructor(path: string, public children: File[] = []) { super(path); } }
class Loaded {
	cleanup = jest.fn(); destroy = jest.fn(); move = jest.fn();
	constructor(public guid: string, public path: string) {}
}
class SyncFolder extends Loaded {}

// The upstream SharedFolder constructor needs the Obsidian runtime and its
// encrypted harness. Compile these exact production methods, not copies, with
// explicit platform doubles. This characterizes the boundary handler only;
// full vault event/HSM behavior still needs an Obsidian acceptance test.
const source = ts.createSourceFile("SharedFolder.ts", readFileSync(join(__dirname,"../../src/SharedFolder.ts"),"utf8"), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === "SharedFolder") as ts.ClassDeclaration;
const names = ["renameFile", "placeHold", "expandDeletePaths"];
const selected = declaration.members.filter(m => ts.isMethodDeclaration(m) && names.includes(m.name.getText(source)));
if (selected.length !== names.length) throw new Error("SharedFolder test boundary changed");
const script = ts.transpileModule(`class Boundary {${selected.map(m=>m.getText(source)).join("\n")}}; Boundary.prototype`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const methods = runInNewContext(script, {TFolder:Folder, SyncFolder, sep:"/"}) as {
	renameFile(file: File, oldPath: string): void;
	placeHold(files: File[]): string[];
	expandDeletePaths(paths: Iterable<string>, roots: Iterable<string>): string[];
};

function fixture(root: string, paths: string[]) {
	const meta = new Map(paths.map(path=>[path,{id:randomUUID()}]));
	const originalIds = Array.from(meta.values(),m=>m.id);
	const files = new Map(Array.from(meta,([path,m])=>[m.id,path.includes(".") ? new Loaded(m.id,path) : new SyncFolder(m.id,path)]));
	const pendingUpload = new Map<string,string>();
	const uploads: string[] = [];
	const folderDoc = new Y.Doc();
	const state = {
		...methods, // Prototype methods are nonenumerable; assign below explicitly.
		meta, originalIds, files, pendingUpload, uploads, folderDoc,
		fset: new Set(files.values()), folderMachine:{mayMint:true}, canManageFiles:true,
		log:()=>{}, retryHeldMaterializations:()=>{},
		isReaderFolderRestoreChild:()=>false, consumeReaderRestoreRenameEcho:()=>false,
		rejectReaderFolderChange:()=>false, serverOps:{moveFrom:()=>undefined},
		isPendingDelete:()=>false, isNovelPath:(path:string)=>!meta.has(path)&&!pendingUpload.has(path),
		isSyncableTFile:()=>true, assertPath:()=>{},
		getVirtualPath(path:string) { if (!path.startsWith(root+"/")) throw new Error("outside"); return path.slice(root.length); },
		uploadFile(file:File) {
			const path = this.getVirtualPath(file.path);
			uploads.push(path);
			const id = pendingUpload.get(path);
			if(id) {meta.set(path,{id}); pendingUpload.delete(path);}
		},
		syncStore:{
			has:(path:string)=>meta.has(path), get:(path:string)=>meta.get(path)?.id,
			delete:(path:string)=>{pendingUpload.delete(path);return meta.delete(path);},
			forEach:(fn:(m:{id:string},path:string)=>void)=>meta.forEach(fn),
			new:(path:string)=>{const id=randomUUID();pendingUpload.set(path,id);return id;},
			move:(from:string,to:string)=>{const value=meta.get(from);if(value){meta.delete(from);meta.set(to,value);}},
		},
	};
	state.renameFile = methods.renameFile;
	state.placeHold = methods.placeHold;
	state.expandDeletePaths = methods.expandDeletePaths;
	return state;
}

test("single-file boundary moves retire the old membership and allocate a fresh destination identity",()=>{
	const from=fixture("source",["/note.md"]), to=fixture("destination",[]);
	const file=new File("destination/note.md");
	from.renameFile(file,"source/note.md"); to.renameFile(file,"source/note.md");
	expect(from.meta.size).toBe(0);
	expect(to.uploads).toEqual(["/note.md"]);
	expect(from.originalIds).not.toContain(to.meta.get("/note.md")!.id);
	from.folderDoc.destroy(); to.folderDoc.destroy();
});

test("moving an implied folder out also retires descendants and pending uploads",()=>{
	const from=fixture("source",["/nested/a.md","/nested/deeper/file.png"]);
	from.pendingUpload.set("/nested/upload.bin",randomUUID());
	from.pendingUpload.set("/unrelated.bin",randomUUID());
	from.renameFile(new Folder("outside/nested"),"source/nested");
	expect(from.meta.size).toBe(0);
	expect(Array.from(from.pendingUpload.keys())).toEqual(["/unrelated.bin"]);
	expect(from.files.size).toBe(0);
	from.folderDoc.destroy();
});

test("nested moves inside the same shared folder keep existing identities",()=>{
	const paths=["/nested","/nested/a.md","/nested/deeper","/nested/deeper/file.png"];
	const folder=fixture("source",paths);
	folder.renameFile(new Folder("source/renamed"),"source/nested");
	expect(Array.from(folder.meta.keys())).toEqual(paths.map(path=>path.replace("/nested","/renamed")));
	expect(Array.from(folder.meta.values(),m=>m.id)).toEqual(folder.originalIds);
	expect(folder.uploads).toEqual([]);
	folder.folderDoc.destroy();
});

test("nested-folder boundary moves retire every source path and allocate destination identities for all descendants",()=>{
	const moved=["/nested","/nested/a.md","/nested/deeper","/nested/deeper/file.png"];
	const from=fixture("source",[...moved,"/unrelated.md"]), to=fixture("destination",[]);
	const handles=Array.from(from.files.values()).filter(f=>f.path!=="/unrelated.md");
	const folder=new Folder("destination/nested",[new File("destination/nested/a.md"),new Folder("destination/nested/deeper",[new File("destination/nested/deeper/file.png")])]);
	from.renameFile(folder,"source/nested"); to.renameFile(folder,"source/nested");
	expect(Array.from(from.meta.keys())).toEqual(["/unrelated.md"]);
	expect(to.uploads).toEqual(moved);
	for(const m of to.meta.values()) expect(from.originalIds).not.toContain(m.id);
	for(const handle of handles) {expect(handle.cleanup).toHaveBeenCalledTimes(1);expect(handle.destroy).toHaveBeenCalledTimes(1);}
	// Duplicate child rename notifications must not mint another identity.
	const ids=Array.from(to.meta.values(),m=>m.id);
	to.renameFile(folder.children[0],"source/nested/a.md");
	expect(Array.from(to.meta.values(),m=>m.id)).toEqual(ids);
	from.folderDoc.destroy(); to.folderDoc.destroy();
});
