/* Generated from Rust protocol schemas. Do not edit by hand. */
import type { ValidateFunction } from "ajv";
import type { CoreReady } from "../../../../../packages/protocol/src/core-ready.js";
import type { ClientMessage } from "../../../../../packages/protocol/src/generated/client-message.js";
import type { ServerMessage } from "../../../../../packages/protocol/src/generated/server-message.js";

declare const validators: {
  validateCoreReady: ValidateFunction<CoreReady>;
  validateClient: ValidateFunction<ClientMessage>;
  validateServer: ValidateFunction<ServerMessage>;
};
export = validators;
