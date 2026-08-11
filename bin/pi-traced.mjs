#!/usr/bin/env node
process.env.RESEARCH_PI_TRACE = "1";
await import("./pi.mjs");
