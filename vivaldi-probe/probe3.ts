import { CDP, createTarget, options } from "./simple-cdp.js";

const [executablePath, strategy] = Deno.args;
const port = 9300 + Math.floor(Math.random() * 500);
const profile = await Deno.makeTempDir();
const child = new Deno.Command(executablePath, { args: ["--headless", "--no-first-run", "--remote-debugging-port=" + port, "--user-data-dir=" + profile], stdout: "null", stderr: "null" }).spawn();
console.log(`== ${strategy}`);
options.apiUrl = `http://127.0.0.1:${port}`;
const commandMaxTime = 5000;
const step = async (label: string, call: () => Promise<unknown>) => {
	const start = Date.now();
	try {
		console.log(`  ${label} ${Date.now() - start} ms :: ${JSON.stringify(await call()).substring(0, 120)}`);
	} catch (error) {
		console.log(`  ${label} ${Date.now() - start} ms :: ${(error as { code?: string }).code || ""} ${(error as Error).message.substring(0, 100)}`);
	}
};
try {
	const evaluate = { expression: "location.href", returnByValue: true };
	if (strategy.startsWith("json-new")) {
		const url = strategy == "json-new-url" ? "https://example.com" : strategy == "json-new-blank" ? "about:blank" : undefined;
		const targetInfo = await createTarget(url);
		const cdp = new CDP(Object.assign({}, targetInfo, { commandMaxTime }));
		await step("Runtime.evaluate", () => cdp.Runtime.evaluate(evaluate));
		await step("Runtime.evaluate again", () => cdp.Runtime.evaluate(evaluate));
		cdp.reset();
	} else {
		const url = strategy == "target-url" ? "https://example.com" : "about:blank";
		const { webSocketDebuggerUrl } = await (await fetch(`${options.apiUrl}/json/version`)).json().catch(() => ({}));
		const cdp = new CDP({ webSocketDebuggerUrl, commandMaxTime });
		const { targetId } = await cdp.Target.createTarget({ url });
		const { sessionId } = await cdp.Target.attachToTarget({ targetId, flatten: true });
		await step("Runtime.evaluate (session)", () => cdp.Runtime.evaluate(evaluate, sessionId));
		await step("Runtime.evaluate (session) again", () => cdp.Runtime.evaluate(evaluate, sessionId));
		cdp.reset();
	}
} catch (error) {
	console.log("  ERROR " + (error as Error).message);
} finally {
	if (Deno.build.os == "windows") {
		await new Deno.Command("taskkill", { args: ["/T", "/F", "/PID", String(child.pid)], stdout: "null", stderr: "null" }).output();
	} else {
		child.kill("SIGKILL");
	}
	Deno.exit(0);
}
