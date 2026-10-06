import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export class RuntimeClient extends EventEmitter {
	constructor(path, { forwardAllViews = false } = {}) { super(); this.path = path; this.pending = new Map(); this.buffer = ""; this.uiClientId = randomUUID(); this.forwardAllViews = forwardAllViews; }
	async connect() {
		this.buffer = ""; this.socket = createConnection(this.path);
		this.socket.on("data", (data) => {
			this.buffer += data.toString();
			let end;
			while ((end = this.buffer.indexOf("\n")) >= 0) {
				const message = JSON.parse(this.buffer.slice(0, end)); this.buffer = this.buffer.slice(end + 1);
				if (message.type === "response") {
					const waiter = this.pending.get(message.id); if (!waiter) continue;
					this.pending.delete(message.id); message.error ? waiter.reject(new Error(message.error)) : waiter.resolve(message.result);
				} else {
					if (message.targetClientId && message.targetClientId !== this.uiClientId && !this.forwardAllViews) continue;
					if (message.type === "state") this.state = message.state;
					this.emit("event", message);
				}
			}
		});
		this.socket.on("error", (error) => this.emit("connectionError", error));
		this.socket.on("close", () => { for (const waiter of this.pending.values()) waiter.reject(new Error("Runtime connection closed")); this.pending.clear(); this.emit("disconnect"); });
		await new Promise((resolve, reject) => { this.socket.once("connect", resolve); this.socket.once("error", reject); });
		this.state = await this.call("state"); return this;
	}
	call(method, params = {}, { id = randomUUID(), sessionId = this.state?.sessionId, sessionEpoch = this.state?.sessionEpoch, uiClientId = this.uiClientId } = {}) {
		if (!this.socket || this.socket.destroyed) return Promise.reject(new Error("Runtime is disconnected"));
		return new Promise((resolve, reject) => {
			if (this.pending.has(id)) { reject(new Error("Request already pending on this connection")); return; }
			this.pending.set(id, { resolve, reject });
			this.socket.write(JSON.stringify({ id, method, params, sessionId, sessionEpoch, uiClientId }) + "\n");
		});
	}
	close() { this.socket?.end(); }
}
