import { t as compact } from "../compact-CxSqQNw0.js";
import { n as PermDockDeniedError, t as PermDockApprovalRequiredError } from "../errors-DDT8tC4N.js";
import { t as createPermDock$1 } from "../permdock-DR74dJsu.js";
//#region src/convex/create.ts
var ConvexError = class extends Error {
	name = "ConvexError";
	data;
	constructor(data) {
		super(data.detail);
		this.data = data;
	}
};
function toConvexError(error) {
	if (error instanceof PermDockDeniedError || error instanceof PermDockApprovalRequiredError) return new ConvexError(error.toProblemDetails());
	return error;
}
function createPermDock(policy, options) {
	const withPermDock = (handler) => {
		return async (ctx, args) => {
			let user = null;
			try {
				user = await options.subject(ctx);
			} catch {
				user = null;
			}
			const dock = await createPermDock$1(policy, user);
			const next = {
				...ctx,
				permdock: dock
			};
			try {
				return await handler(next, args);
			} catch (error) {
				throw toConvexError(error);
			}
		};
	};
	const snapshotQuery = (snapshotOptions) => {
		const handler = withPermDock((ctx, args) => {
			return Promise.resolve(ctx.permdock.snapshot(compact({ include: snapshotOptions?.include })));
		});
		const definition = {
			args: {},
			handler: (ctx, args) => handler(ctx, args)
		};
		if (options.query !== void 0) return options.query(definition);
		return definition;
	};
	return {
		withPermDock,
		snapshotQuery
	};
}
//#endregion
export { ConvexError, createPermDock };
