import { IncomingMessage, ServerResponse } from "node:http";
//#region src/node/http.d.ts
type NodeRequest = IncomingMessage & {
  readonly originalUrl?: string;
  readonly protocol?: string;
  readonly body?: unknown;
};
declare function toRequest(req: NodeRequest): Request;
declare function sendResponse(res: ServerResponse, response: Response): Promise<void>;
declare const fromResponse: typeof sendResponse;
declare function isServerResponse(value: unknown): value is ServerResponse;
//#endregion
export { toRequest as a, sendResponse as i, fromResponse as n, isServerResponse as r, NodeRequest as t };