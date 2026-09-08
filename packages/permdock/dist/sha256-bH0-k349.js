//#region src/core/paths.ts
const FORBIDDEN_KEYS = /* @__PURE__ */ new Set([
	"__proto__",
	"constructor",
	"prototype"
]);
function isForbiddenKey(key) {
	return FORBIDDEN_KEYS.has(key);
}
function assertSafeKey(key, context) {
	if (isForbiddenKey(key) || key.length === 0) throw new Error(`PermDock: forbidden ${context} key '${key}'`);
}
function ownGet(object, key) {
	if (isForbiddenKey(key)) return;
	if (!Object.hasOwn(object, key)) return;
	return object[key];
}
function ownKeys(object) {
	return Object.keys(object).filter((key) => !isForbiddenKey(key));
}
function splitPath(path) {
	return path.split(".").filter((segment) => segment.length > 0);
}
function readPath(root, path) {
	const segments = splitPath(path);
	let current = root;
	for (const segment of segments) {
		if (isForbiddenKey(segment)) return;
		if (current === null || current === void 0 || typeof current !== "object") return;
		current = ownGet(current, segment);
	}
	return current;
}
//#endregion
//#region src/core/sha256.ts
const K = [
	1116352408,
	1899447441,
	3049323471,
	3921009573,
	961987163,
	1508970993,
	2453635748,
	2870763221,
	3624381080,
	310598401,
	607225278,
	1426881987,
	1925078388,
	2162078206,
	2614888103,
	3248222580,
	3835390401,
	4022224774,
	264347078,
	604807628,
	770255983,
	1249150122,
	1555081692,
	1996064986,
	2554220882,
	2821834349,
	2952996808,
	3210313671,
	3336571891,
	3584528711,
	113926993,
	338241895,
	666307205,
	773529912,
	1294757372,
	1396182291,
	1695183700,
	1986661051,
	2177026350,
	2456956037,
	2730485921,
	2820302411,
	3259730800,
	3345764771,
	3516065817,
	3600352804,
	4094571909,
	275423344,
	430227734,
	506948616,
	659060556,
	883997877,
	958139571,
	1322822218,
	1537002063,
	1747873779,
	1955562222,
	2024104815,
	2227730452,
	2361852424,
	2428436474,
	2756734187,
	3204031479,
	3329325298
];
function rotr(value, bits) {
	return value >>> bits | value << 32 - bits;
}
/**
* SHA-256 of UTF-8 text. Pure JS so `decide` stays synchronous and WinterTC-safe.
*/
function sha256(message) {
	const bytes = new TextEncoder().encode(message);
	const bitLength = bytes.length * 8;
	const paddedLength = bytes.length + 9 + 63 >> 6 << 6;
	const padded = new Uint8Array(paddedLength);
	padded.set(bytes);
	padded[bytes.length] = 128;
	const view = new DataView(padded.buffer);
	view.setUint32(paddedLength - 4, bitLength, false);
	let h0 = 1779033703;
	let h1 = 3144134277;
	let h2 = 1013904242;
	let h3 = 2773480762;
	let h4 = 1359893119;
	let h5 = 2600822924;
	let h6 = 528734635;
	let h7 = 1541459225;
	const w = /* @__PURE__ */ new Int32Array(64);
	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let i = 0; i < 16; i += 1) w[i] = view.getInt32(offset + i * 4, false);
		for (let i = 16; i < 64; i += 1) {
			const w15 = w[i - 15];
			const w2 = w[i - 2];
			const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ w15 >>> 3;
			const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ w2 >>> 10;
			w[i] = w[i - 16] + s0 + w[i - 7] + s1 | 0;
		}
		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;
		let f = h5;
		let g = h6;
		let h = h7;
		for (let i = 0; i < 64; i += 1) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = e & f ^ ~e & g;
			const temp1 = h + S1 + ch + K[i] + w[i] | 0;
			const temp2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + (a & b ^ a & c ^ b & c) | 0;
			h = g;
			g = f;
			f = e;
			e = d + temp1 | 0;
			d = c;
			c = b;
			b = a;
			a = temp1 + temp2 | 0;
		}
		h0 = h0 + a | 0;
		h1 = h1 + b | 0;
		h2 = h2 + c | 0;
		h3 = h3 + d | 0;
		h4 = h4 + e | 0;
		h5 = h5 + f | 0;
		h6 = h6 + g | 0;
		h7 = h7 + h | 0;
	}
	const out = /* @__PURE__ */ new Uint8Array(32);
	const outView = new DataView(out.buffer);
	outView.setInt32(0, h0, false);
	outView.setInt32(4, h1, false);
	outView.setInt32(8, h2, false);
	outView.setInt32(12, h3, false);
	outView.setInt32(16, h4, false);
	outView.setInt32(20, h5, false);
	outView.setInt32(24, h6, false);
	outView.setInt32(28, h7, false);
	return out;
}
function bytesToBase64Url(bytes) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCodePoint(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
//#endregion
export { ownGet as a, splitPath as c, isForbiddenKey as i, sha256 as n, ownKeys as o, assertSafeKey as r, readPath as s, bytesToBase64Url as t };
