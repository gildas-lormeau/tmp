import { CHROMIUM_ARGS } from "../cli/lib/constants.js";

const [executablePath, strategy] = Deno.args;
const STEP_TIMEOUT = 5000;

const port = 9300 + Math.floor(Math.random() * 500);
const profile = await Deno.makeTempDir();
const args = [...CHROMIUM_ARGS, "--headless", "--remote-debugging-port=" + port, "--user-data-dir=" + profile];
console.log(`== ${strategy}`);
const child = new Deno.Command(executablePath, { args, stdout: "null", stderr: "null" }).spawn();
let exited = false;
child.status.then(status => { exited = true; console.log(`  [browser exited code=${status.code}]`); });

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
	Deno.exit(0);
}

function connect(url: string) {
	const socket = new WebSocket(url);
	let nextId = 1;
	const pending = new Map<number, (value: unknown) => void>();
	socket.onmessage = ({ data }) => {
		const message = JSON.parse(data);
		if (message.id && pending.has(message.id)) {
			pending.get(message.id)!(message);
		}
	};
	const opened = new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
	const send = async (method: string, params = {}, label = "") => {
		await opened;
		const id = nextId++;
		const stepStart = Date.now();
		const response = await Promise.race([
			new Promise(resolve => { pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); }),
			new Promise(resolve => setTimeout(() => resolve(null), STEP_TIMEOUT))
		]) as { result?: unknown; error?: unknown } | null;
		const summary = response === null ? "NO ANSWER" : JSON.stringify(response.error || response.result).substring(0, 140);
		console.log(`  ${label}${method} ${Date.now() - stepStart} ms :: ${summary}`);
		return response;
	};
	return { send, opened };
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
	const api = `http://127.0.0.1:${port}`;
	const newTarget = async (url?: string) => (await fetch(`${api}/json/new${url ? "?" + encodeURIComponent(url) : ""}`, { method: "PUT" })).json();
	const byId = async (id: string) => ((await (await fetch(`${api}/json/list`)).json()) as { id: string; webSocketDebuggerUrl: string; url: string }[]).find(target => target.id == id)!;
	let target;
	let pre: ((page: ReturnType<typeof connect>) => Promise<void>) | undefined;
	if (strategy == "json-new-blank") {
		target = await newTarget("about:blank");
	} else if (strategy == "json-new-nourl") {
		target = await newTarget();
	} else if (strategy == "json-new-data") {
		target = await newTarget("data:text/html,");
	} else if (strategy == "json-new-blank-wait") {
		target = await newTarget("about:blank");
		await new Promise(resolve => setTimeout(resolve, 5000));
	} else if (strategy == "json-new-blank-navigate-blank") {
		target = await newTarget("about:blank");
		pre = async page => { await page.send("Page.navigate", { url: "about:blank" }, "pre "); };
	} else if (strategy == "json-new-blank-activate") {
		target = await newTarget("about:blank");
		await fetch(`${api}/json/activate/${target.id}`);
	} else if (strategy.startsWith("target-create")) {
		const browser = connect(version.webSocketDebuggerUrl);
		const params: Record<string, unknown> = { url: "about:blank" };
		if (strategy == "target-create-window") {
			params.newWindow = true;
		} else if (strategy == "target-create-foreground") {
			params.background = false;
		}
		const response = await browser.send("Target.createTarget", params, "browser ") as { result: { targetId: string } };
		target = await byId(response.result.targetId);
	} else {
		throw new Error("unknown strategy");
	}
	console.log(`  target ${target.type} ${target.url}`);
	const page = connect(target.webSocketDebuggerUrl);
	await page.opened;
	if (pre) {
		await pre(page);
	}
	await page.send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
	await page.send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 probe" });
	await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__probe = 1" });
	await page.send("Page.navigate", { url: "https://example.com" });
	await new Promise(resolve => setTimeout(resolve, 3000));
	await page.send("Runtime.evaluate", { expression: "location.href + ' | ' + navigator.userAgent + ' | injected=' + window.__probe", returnByValue: true });
}
