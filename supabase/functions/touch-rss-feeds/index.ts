import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createTouchRssFeedsHandler } from "./handler.ts";

Deno.serve(createTouchRssFeedsHandler());
