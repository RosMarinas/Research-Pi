import assert from "node:assert/strict";
import test from "node:test";
import { attachWebDialogs } from "../.pi/lib/web-dialogs.mjs";

test("mobile approval resolves once and dismisses the terminal dialog", async () => {
	let cancelled = false;
	const events = [];
	const original = (_title, _message, { signal }) => new Promise((resolve) => {
		signal.addEventListener("abort", () => { cancelled = true; resolve(false); }, { once: true });
	});
	const ui = { confirm: original };
	const bridge = attachWebDialogs(ui, (event) => events.push(event));
	const result = ui.confirm("Host permission", "Approve once?");
	await Promise.resolve();
	const [{ id }] = bridge.list();
	assert.throws(() => bridge.answer(id, "yes"), /yes or no/);
	assert.deepEqual(bridge.answer(id, true), { answered: true });
	assert.equal(await result, true);
	assert.equal(cancelled, true);
	assert.throws(() => bridge.answer(id, false), /already been answered/);
	assert.equal(events.filter((event) => event.type === "dialog_closed").length, 1);
	bridge.dispose(); assert.equal(ui.confirm, original);
});

test("terminal response, cancellation and offered choices retain their semantics", async () => {
	let answer;
	const ui = { select: (_title, _choices, { signal }) => new Promise((resolve) => { answer = resolve; if (signal.aborted) resolve(undefined); else signal.addEventListener("abort", () => resolve(undefined), { once: true }); }) };
	const bridge = attachWebDialogs(ui, () => {});
	const result = ui.select("Permission scope", ["Once", "Deny"]);
	await Promise.resolve();
	const [{ id }] = bridge.list();
	assert.throws(() => bridge.answer(id, "Project"), /offered options/);
	answer("Deny"); assert.equal(await result, "Deny");
	assert.equal(bridge.list().length, 0);
	const cancelled = ui.select("Next request", ["Once"]);
	bridge.dispose(); assert.equal(await cancelled, undefined);
});


test("web answer waits for native dismissal before the next dialog starts", async () => {
	let clean = false;
	const ui = { confirm: (_title, _message, { signal }) => new Promise((resolve) => {
		signal.addEventListener("abort", () => setTimeout(() => { clean = true; resolve(false); }, 10), { once: true });
	}) };
	const bridge = attachWebDialogs(ui, () => {});
	const result = ui.confirm("First", "Confirm");
	await Promise.resolve();
	bridge.answer(bridge.list()[0].id, true);
	assert.equal(clean, false);
	assert.equal(await result, true);
	assert.equal(clean, true);
	bridge.dispose();
});
