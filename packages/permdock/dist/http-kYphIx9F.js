//#region src/node/http.ts
function toRequest(req) {
	const host = headerValue(req.headers.host) ?? "localhost";
	const url = `${req.protocol ?? "http"}://${host}${req.originalUrl ?? req.url ?? "/"}`;
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (typeof value === "string") {
			headers.set(key, value);
			continue;
		}
		if (Array.isArray(value)) for (const item of value) headers.append(key, item);
	}
	const method = req.method ?? "GET";
	if (method === "GET" || method === "HEAD") return new Request(url, {
		method,
		headers
	});
	const parsed = bodyOf(req, headers);
	if (parsed !== void 0) return new Request(url, {
		method,
		headers,
		body: parsed
	});
	const init = {
		method,
		headers,
		body: incomingBody(req),
		duplex: "half"
	};
	return new Request(url, init);
}
function incomingBody(req) {
	return new ReadableStream({ start(controller) {
		req.on("data", (chunk) => {
			controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk));
		});
		req.on("end", () => {
			controller.close();
		});
		req.on("error", (err) => {
			controller.error(err);
		});
	} });
}
function headerValue(value) {
	if (typeof value === "string" && value.length > 0) return value;
	if (Array.isArray(value) && typeof value[0] === "string") return value[0];
}
function bodyOf(req, headers) {
	if (req.body === void 0) return;
	if (typeof req.body === "string") return req.body;
	if (!headers.has("content-type")) headers.set("content-type", "application/json");
	return JSON.stringify(req.body);
}
async function sendResponse(res, response) {
	res.statusCode = response.status;
	for (const [key, value] of response.headers.entries()) res.setHeader(key, value);
	const body = Buffer.from(await response.arrayBuffer());
	res.end(body);
}
const fromResponse = sendResponse;
function isServerResponse(value) {
	return typeof value === "object" && value !== null && "setHeader" in value && typeof value.setHeader === "function" && "end" in value;
}
//#endregion
export { toRequest as i, isServerResponse as n, sendResponse as r, fromResponse as t };
