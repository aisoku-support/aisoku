# Codex local production command launcher

Run `node tools/operations/codex-production.mjs env` to see
which supported settings are available. It reports names and availability only.

The NewsData one-request manual test is:

```powershell
node tools/operations/codex-production.mjs newsdata-test
```

It sends one `manual_test` invocation to `update-newsdata` using the existing
`NEWSDATA_JOB_SECRET` from the ignored env files. The deployed function stops
after its first NewsData API request. The launcher prints only run status and
counts. It exits before making a network request if `NEWSDATA_JOB_SECRET` is
not available locally.

For a service command, pass the exact operation explicitly, for example:

```powershell
node tools/operations/codex-production.mjs supabase projects list
node tools/operations/codex-production.mjs wrangler whoami
```

The launcher loads `.env` first and `.env.server` second, without overriding
already-set process variables. Values stay in the launcher/child process and
are not printed or persisted. Both files are listed in the repository
`.gitignore`; keep them local and never commit them.

Supabase CLI also uses its normal per-user login state. The repository's local
project reference is under `supabase/.temp/project-ref`. The launcher does not
create a link, log in, deploy, or call a service unless the selected CLI command
does so.

Wrangler OAuth must be available to the same Windows user and process running
Codex. If `wrangler whoami` cannot see it, use an existing globally installed
Wrangler login for that user; this setup does not create API tokens or modify
Cloudflare resources. Account ID may be configured in the Worker's
`wrangler.toml` or environment, and is reported only as available/missing by
the `env` command.

The launcher does not install CLIs or infer a production action. It can run
Supabase CLI, Wrangler, Node, or Deno commands once those tools are available.
