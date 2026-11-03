/** DOF type → connector. A new type is its module plus one line here. */
import type { ConnectorFactory } from "../types.ts";
import { create as discord } from "./discord.ts";
import { create as bitbucket } from "./bitbucket.ts";
import { create as github } from "./github.ts";
import { create as gitlab } from "./gitlab.ts";
import { create as slack } from "./slack.ts";
import { create as telegram } from "./telegram.ts";

export const connectors: Record<string, ConnectorFactory> = { slack, discord, telegram, github, gitlab, bitbucket };
