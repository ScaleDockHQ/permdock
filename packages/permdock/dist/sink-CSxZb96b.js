import { t as compact } from "./compact-CxSqQNw0.js";
//#region src/core/sink.ts
function cloudEventType(event) {
	switch (event.type) {
		case "directory": return "dev.permdock.directory";
		case "decision":
			if (event.phase === "requested" || event.phase === "resolved") return "dev.permdock.approval";
			return "dev.permdock.decision";
		default: return event;
	}
}
function cloudEventSubject(event) {
	if (event.type === "directory") return event.resource.id;
	return event.permission;
}
function toCloudEvent(event, source = "permdock") {
	return compact({
		specversion: "1.0",
		type: cloudEventType(event),
		source,
		subject: cloudEventSubject(event),
		id: globalThis.crypto.randomUUID(),
		time: event.at,
		datacontenttype: "application/json",
		data: event
	});
}
function signDecisionBatch(events, signer, options = {}) {
	const source = options.source ?? "permdock";
	return signer.sign({ events: events.map((event) => toCloudEvent(event, source)) }, compact({
		typ: "permdock-decisions+jwt",
		audience: options.audience
	}));
}
function memorySink(options = {}) {
	const capacity = options.capacity ?? 1e4;
	const buffer = [];
	const signed = [];
	return {
		write(events) {
			buffer.push(...events);
			if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
			if (options.signer === void 0) return;
			return signDecisionBatch(events, options.signer, compact({
				audience: options.audience,
				source: options.source
			})).then((batch) => {
				signed.push(batch);
			}).catch(() => void 0);
		},
		events() {
			return [...buffer];
		},
		batches() {
			return [...signed];
		}
	};
}
//#endregion
export { signDecisionBatch as n, toCloudEvent as r, memorySink as t };
