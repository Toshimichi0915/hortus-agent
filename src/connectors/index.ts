/** DOF type → connector. A new type is its module plus one line here. */
import type { ConnectorFactory } from "../types.ts";
import { create as slack } from "./slack.ts";

export const connectors: Record<string, ConnectorFactory> = { slack };
