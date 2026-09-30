import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createGetTopicSourcesHandler } from "./handler.ts";

Deno.serve(createGetTopicSourcesHandler());
