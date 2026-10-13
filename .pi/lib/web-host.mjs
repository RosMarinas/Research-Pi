import { launchResearchWeb } from "./web-launcher.mjs";

process.umask(0o077);
try {
	let input = "";
	for await (const chunk of process.stdin) input += chunk.toString();
	process.exitCode = await launchResearchWeb({ ...JSON.parse(input), env: process.env, localTerminal: false });
} catch (error) {
	process.stderr.write("Research Pi Web host: " + error.message + "\n");
	process.exitCode = 1;
}
