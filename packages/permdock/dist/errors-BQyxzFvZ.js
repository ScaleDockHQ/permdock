//#region src/approvals/errors.ts
var ApprovalError = class extends Error {
	name = "ApprovalError";
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
	}
};
function isApprovalError(value) {
	return value instanceof ApprovalError;
}
//#endregion
export { isApprovalError as n, ApprovalError as t };
