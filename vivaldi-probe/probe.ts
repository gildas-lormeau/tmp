import { CHROMIUM_ARGS } from "../cli/lib/constants.js";

const [executablePath, variant] = Deno.args;
const STEP_TIMEOUT = 8000;

const VARIANTS: Record<string, () => string[]> = {
	"cli-headless-single": () => [...CHROMIUM_ARGS, "--headless", "--single-process"],
	"cli-headless": () => [...CHROMIUM_ARGS, "--headless"],
	"cli-headless-no-bwsi": () => CHROMIUM_ARGS.filter(arg => arg != "--bwsi").concat("--headless"),
	"cli-headless-no-startup-window-kept": () => CHROMIUM_ARGS.filter(arg => arg != "--no-startup-window").concat("--headless"),
	"cli-headless-useragent": () => [...CHROMIUM_ARGS, "--headless", "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"],
	"minimal-headless": () => ["--headless", "--no-first-run"],
	"cli-headful": () => [...CHROMIUM_ARGS, "--start-maximized"],
	"cli-headful-single": () => [...CHROMIUM_ARGS, "--start-maximized", "--single-process"]
};

const port = 9300 + Math.floor(Math.random() * 500);
const profile = await Deno.makeTempDir();
const args = VARIANTS[variant]().concat("--remote-debugging-port=" + port, "--user-data-dir=" + profile);
console.log(`== ${variant}`);
const child = new Deno.Command(executablePath, { args, stdout: "null", stderr: "piped" }).spawn();
let exited = false;
child.status.then(status => { exited = true; console.log(`  [browser exited code=${status.code}]`); });
const stderrLines: string[] = [];
(async () => {
	const decoder = new TextDecoderStream();
	for await (const chunk of child.stderr.pipeThrough(decoder)) {
		stderrLines.push(...chunk.split("\n").filter(Boolean));
	}
})().catch(() => { });

try {
	await run();
} catch (error) {
	console.log("  ERROR " + (error as Error).message);
} finally {
	if (!exited) {
		if (Deno.build.os == "windows") {
			await new Deno.Command("taskkill", { args: ["/T", "/F", "/PID", String(child.pid)], stdout: "null", stderr: "null" }).output();
		} else {
			child.kill("SIGKILL");
		}
	}
	await Promise.race([child.status, new Promise(resolve => setTimeout(resolve, 5000))]);
	console.log("  stderr (last 8): " + JSON.stringify(stderrLines.slice(-8)));
	Deno.exit(0);
}

async function run() {
	const start = Date.now();
	let version;
	while (!version && Date.now() - start < 30000 && !exited) {
		try {
			version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
		} catch {
			await new Promise(resolve => setTimeout(resolve, 250));
		}
	}
	if (!version) {
		throw new Error("no /json/version");
	}
	console.log(`  version ${version.Browser} after ${Date.now() - start} ms`);
	console.log("  targets before " + JSON.stringify((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).map((target: { type: string; url: string }) => target.type + ":" + target.url)));
	const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
	console.log(`  new target ${target.type} ${target.url}`);
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
	let nextId = 1;
	const pending = new Map<number, (value: unknown) => void>();
	socket.onmessage = ({ data }) => {
		const message = JSON.parse(data);
		if (message.id && pending.has(message.id)) {
			pending.get(message.id)!(message);
		}
	};
	const send = async (method: string, params = {}) => {
		const id = nextId++;
		const stepStart = Date.now();
		const response = await Promise.race([
			new Promise(resolve => { pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); }),
			new Promise(resolve => setTimeout(() => resolve(null), STEP_TIMEOUT))
		]) as { result?: unknown; error?: unknown } | null;
		const summary = response === null ? "NO ANSWER" : JSON.stringify(response.error || response.result).substring(0, 160);
		console.log(`  ${method} ${Date.now() - stepStart} ms :: ${summary}`);
		return response;
	};
	await send("Browser.getVersion");
	await send("Runtime.evaluate", { expression: "1+1", returnByValue: true });
	await send("Page.enable");
	await send("Runtime.enable");
	await send("Network.enable");
	await send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 probe" });
	await send("Network.setUserAgentOverride", { userAgent: "Mozilla/5.0 probe-network" });
	await send("Runtime.evaluate", { expression: "navigator.userAgent", returnByValue: true });
	await send("Page.navigate", { url: "https://example.com" });
	await new Promise(resolve => setTimeout(resolve, 3000));
	await send("Runtime.evaluate", { expression: "document.title + ' | ' + navigator.userAgent", returnByValue: true });
	console.log("  targets after " + JSON.stringify((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).map((target: { type: string; url: string }) => target.type + ":" + target.url)));
}
