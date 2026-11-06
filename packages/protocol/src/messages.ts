import type { ClientMessage } from "./generated/client-message.js";
import type { ServerMessage } from "./generated/server-message.js";

export type ClientRequestMessage = Extract<ClientMessage, { type: "request" }>;
export type ClientHelloMessage = Extract<ClientMessage, { type: "hello" }>;
export type ClientCancelMessage = Extract<ClientMessage, { type: "cancel" }>;
export type ServerHelloMessage = Extract<ServerMessage, { type: "hello" }>;
export type ServerResponseMessage = Extract<ServerMessage, { type: "response" }>;
export type ServerErrorMessage = Extract<ServerMessage, { type: "error" }>;

export type RequestContext = Required<Pick<ClientRequestMessage, "repoId" | "generation">>;
export type ProtocolErrorCode = ServerErrorMessage["code"];
