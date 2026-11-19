import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// Builds the Worker for `cf dev`, `cf build` and `cf deploy`; settings live in cloudflare.config.ts.
export default defineConfig({
	plugins: [cloudflare()],
	// Matches the local TrueLayer redirect URI documented in the README.
	server: { port: 8787, strictPort: true },
});
