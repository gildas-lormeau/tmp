const path = "cli/lib/cdp-client.js";
const text = await Deno.readTextFile(path);
const target = "cdp = new CDP(targetInfo);";
if (!text.includes(target)) {
	console.log("PATCH FAILED");
	Deno.exit(1);
}
await Deno.writeTextFile(path, text.replace(target, target + "\n\t\t\tawait cdp.Page.navigate({ url: EMPTY_PAGE_URL });"));
console.log("patched");
