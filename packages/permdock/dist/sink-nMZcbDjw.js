//#region src/core/sink.ts
function memorySink(options = {}) {
	const capacity = options.capacity ?? 1e4;
	const buffer = [];
	return {
		write(events) {
			buffer.push(...events);
			if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
		},
		events() {
			return [...buffer];
		}
	};
}
//#endregion
export { memorySink as t };
