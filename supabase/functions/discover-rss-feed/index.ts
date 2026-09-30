import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createDiscoverRssFeedHandler } from "./handler.ts";

Deno.serve(createDiscoverRssFeedHandler());
