# Latest Topic sharedAi pre-generation

Deploy this Worker after applying `supabase/migrations/20260924120000_add_topic_pregen_cache.sql` and deploying the updated `topic-processing` function.

## Runtime configuration

Set these Cloudflare secrets for the Worker:

- `NOTIFICATION_SECRET`: notification-only shared secret; set the same value as Supabase `TOPIC_PREGEN_NOTIFICATION_SECRET`.
- `GEMINI_API_KEY`: Google AI Studio key for the `gemma-4-31b-it` call.
- `SUPABASE_SERVICE_ROLE_KEY`: service role key used only by the coordinator for target registration and atomic cache save.

Set these ordinary Worker variables in the Cloudflare dashboard or Wrangler environment:

- `SUPABASE_URL`: project URL.

Set these Supabase Edge Function secrets:

- `TOPIC_PREGEN_URL`: deployed Worker endpoint.
- `TOPIC_PREGEN_NOTIFICATION_SECRET`: same notification-only secret as `NOTIFICATION_SECRET`.

Deploy with Wrangler from this directory. `wrangler.toml` declares a SQLite-backed singleton Durable Object and Alarm. The Google API key and Supabase service role key never travel in the notification request or logs.

The title batch selects at most its newest eligible new Topic. A notification registers one latest target; each retry then stays inside the Durable Object and contacts Google only. One-time target registration and successful chunk persistence use Supabase RPCs; the retry loop does not poll Supabase or call Upstash.
