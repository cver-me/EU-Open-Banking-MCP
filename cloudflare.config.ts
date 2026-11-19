import { bindings, defineConfig } from "cf/config";

// Every provider is optional, so its secrets are never declared for deploys:
// bindings.secret() marks a secret as required, and `cf deploy` would refuse to
// deploy without it. Deploys keep the secrets already set on the Worker.
// `cf dev` only loads declared secrets from .dev.vars, so in development they are
// declared; a missing one there is just a warning.
// Keep in sync with each provider's *_SECRETS in src/providers/*/config.ts. This file must
// not import Worker code: in `cf dev`, Vite cannot also load a module the config imports.
const OPTIONAL_SECRETS = [
	"ENABLE_BANKING_APPLICATION_ID",
	"ENABLE_BANKING_PRIVATE_KEY_PEM",
	"TRUELAYER_CLIENT_ID",
	"TRUELAYER_CLIENT_SECRET",
	"TOKEN_ENCRYPTION_KEY",
];

export default defineConfig(({ mode }) => ({
	worker: {
		name: "finance",
		compatibilityDate: "2026-08-23",
		compatibilityFlags: ["nodejs_compat"],
		entrypoint: "src/index.ts",
		// Worker-level Access protects every route, including workers.dev.
		// The in-code ctx.access check fails closed before that policy is attached.
		workersDev: true,
		previewUrls: false,
		// Code logs metadata only; financial payloads and upstream bodies are never logged.
		observability: {
			enabled: true,
			logs: { headSamplingRate: 1 },
			traces: { enabled: true, headSamplingRate: 0.01 },
		},
		// Simulates the platform-provided Access context only in local development.
		access: {
			dev: {
				aud: "local-development",
				identity: { email: "owner@example.invalid" },
			},
		},
		env: {
			// Stores Enable Banking session IDs and encrypted TrueLayer token records.
			// No ID: `cf deploy` reuses the namespace already bound to the Worker, or creates one.
			SESSION_STORE: bindings.kv({}),
			...(mode === "development"
				? Object.fromEntries(OPTIONAL_SECRETS.map((name) => [name, bindings.secret()]))
				: {}),
		},
	},
}));
