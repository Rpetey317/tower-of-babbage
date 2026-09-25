import path from "node:path";

import "./src/env.js";

/** @type {import("next").NextConfig} */
const config = {
	output: "standalone",
	outputFileTracingRoot: path.join(import.meta.dirname, "../../"),
};

export default config;
