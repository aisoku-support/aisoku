import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createEnsureRssFeedHandler } from "./handler.ts";

Deno.serve(createEnsureRssFeedHandler());
