// Uses a real PostgreSQL server and independent TCP connections.
// SHARED_AI_TEST_DATABASE_URL must point to a disposable local test database.
import postgres from "npm:postgres@3.4.7";
import { deepStrictEqual, strictEqual } from "node:assert";

const connectionUrl = Deno.env.get("SHARED_AI_TEST_DATABASE_URL");
if (!connectionUrl) throw new Error("SHARED_AI_TEST_DATABASE_URL is required");
const parsedUrl = new URL(connectionUrl);
if (
  parsedUrl.hostname !== "127.0.0.1" ||
  parsedUrl.pathname !== "/shared_ai_router_test" ||
  !/^\d+$/.test(parsedUrl.port)
) {
  throw new Error("test database must be shared_ai_router_test on 127.0.0.1");
}

const migrationFiles = [
  "20260923060000_create_shared_ai_reply_cache.sql",
  "20260924120000_add_topic_pregen_cache.sql",
  "20260927093027_free_shared_ai_router.sql",
  "20260928144828_shared_ai_later_chunk_generation.sql",
  "20260928164328_grant_shared_chunk_replies_to_service_role.sql",
];
const replies = (label: string) =>
  Array.from({ length: 10 }, (_, index) => ({
    text: `${label}-${index + 1}`,
    origin: "sharedAi",
    type: "ai",
    replyTo: null,
  }));

Deno.test("PostgreSQL multi-connection locks and preserves router/31B chunks", async () => {
  const connections = Array.from({ length: 8 }, () =>
    postgres(connectionUrl!, {
      max: 1,
      connect_timeout: 10,
      idle_timeout: 0,
      prepare: false,
      ssl: false,
      max_lifetime: 1800,
      backoff: (retries: number) =>
        (0.5 + Math.random() / 2) * Math.min(3 ** retries / 100, 20),
      keep_alive: 60,
      debug: false,
      fetch_types: true,
      publications: "alltables",
      target_session_attrs: "read-write",
      connection: { application_name: "shared-ai-pg-isolated-test" },
      // The test cluster trusts loopback; avoid reading ambient PGPASSWORD.
      password: "local-loopback-trust",
    }));
  try {
    const admin = connections[0];
    await admin.unsafe(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create table topics(
        id uuid primary key,
        thread_title text,
        representative_title text,
        representative_description text,
        representative_url text,
        representative_published_at timestamptz default now(),
        thread_title_pending boolean default false,
        topic_pregen_pending boolean default true,
        subject text,
        event text,
        facts text[],
        created_at timestamptz default now()
      );
      create table topic_thread_title_queue(topic_id uuid,status text);
    `);
    for (const file of migrationFiles) {
      if (file === "20260924120000_add_topic_pregen_cache.sql") {
        await admin.unsafe(
          "alter table topics drop column topic_pregen_pending",
        );
      }
      const migration = await Deno.readTextFile(
        new URL(`../migrations/${file}`, import.meta.url),
      );
      await admin.unsafe(migration);
    }
    console.log("PostgreSQL migrations applied");

    // Each one-connection pool must be backed by a distinct PostgreSQL backend.
    const backendIds = await Promise.all(
      connections.map(async (connection) =>
        Number((await connection`select pg_backend_pid() as pid`)[0].pid)
      ),
    );
    strictEqual(new Set(backendIds).size, connections.length);
    const payloadProbe = await admin`
      select jsonb_typeof(${admin.json(replies("probe"))}::jsonb) as kind,
        jsonb_array_length(${admin.json(replies("probe"))}::jsonb)::int as count
    `;
    deepStrictEqual(payloadProbe[0], { kind: "array", count: 10 });
    console.log(`Independent PostgreSQL backends: ${backendIds.length}`);

    const topic = crypto.randomUUID();
    const ownerIds: string[] = connections.map(() => crypto.randomUUID());
    await admin`insert into topics(id,representative_url,thread_title,facts)
      values(${topic}::uuid,'https://fixture.invalid/concurrent','concurrent',array['fact'])`;

    const claims = await Promise.all(
      connections.map(async (connection, index) => {
        const rows = await connection`
          select public.claim_shared_ai_job(${topic}::uuid,${
          ownerIds[index]
        }::uuid) as result
        `;
        return { owner: ownerIds[index], ...rows[0].result } as {
          owner: string;
          status: string;
        };
      }),
    );
    strictEqual(claims.filter((claim) => claim.status === "claimed").length, 1);
    strictEqual(claims.filter((claim) => claim.status === "running").length, 7);
    console.log("Concurrent topic claims serialized");
    const owner = claims.find((claim) => claim.status === "claimed")!.owner;
    const ownerConnection = connections[ownerIds.indexOf(owner)];

    const models = ["groq-120b", "google-gemma", "cloudflare-gemma"];
    const attempts = models.map(() => crypto.randomUUID());
    const beginResults = await Promise.all(
      models.map((model, index) =>
        connections[index]`
          select public.begin_shared_ai_attempt(
            ${topic}::uuid,${owner}::uuid,${model},${attempts[index]}::uuid
          ) as allowed
        `
      ),
    );
    strictEqual(beginResults.every((rows) => rows[0].allowed), true);
    console.log("Independent model attempts claimed");

    // Delay insert after the production article-row lock so concurrent appenders
    // contend on the same row instead of merely running one after another.
    await admin.unsafe(`
      create function public.test_delay_chunk_insert() returns trigger
      language plpgsql as $$ begin perform pg_sleep(0.15); return new; end $$;
      create trigger zz_test_delay_chunk_insert before insert on public.thread_chunks
      for each row execute function public.test_delay_chunk_insert();
    `);
    const completionCalls = [
      [attempts[0], replies("router-groq")],
      [attempts[0], replies("router-groq")], // same sent result, retried concurrently
      [attempts[1], replies("router-google")],
      [attempts[2], replies("router-cloudflare")],
    ] as const;
    const completed = await Promise.all(
      completionCalls.map(([attempt, payload], index) =>
        connections[index]`
          select public.complete_shared_ai_attempt(
            ${topic}::uuid,${attempt}::uuid,${
          connections[index].json(payload)
        }::jsonb
          ) as chunk_index
        `
      ),
    );
    console.log("Concurrent router attempts completed");
    const resultIndexes = completed.map((rows) => rows[0].chunk_index);
    strictEqual(resultIndexes[0], resultIndexes[1]);
    deepStrictEqual([...new Set(resultIndexes)].sort(), [1, 2, 3]);

    const topicChunks = await admin`
      select c.chunk_index, c.generation_attempt,
        jsonb_array_length(c.replies)::int as reply_count,
        c.replies->0->>'text' as first_text
      from public.thread_chunks c join public.articles a on a.id=c.article_id
      where a.news_url='https://fixture.invalid/concurrent'
      order by c.chunk_index
    `;
    deepStrictEqual(topicChunks.map((row) => row.chunk_index), [1, 2, 3]);
    strictEqual(topicChunks.every((row) => row.reply_count === 10), true);
    strictEqual(
      new Set(topicChunks.map((row) => row.generation_attempt)).size,
      3,
    );
    strictEqual(
      (await admin`select count(*)::int as count from shared_ai_attempts where topic_id=${topic}::uuid and status='saved'`)[
        0
      ].count,
      3,
    );

    // Concurrent late saves for two requests must receive unique chunk indexes,
    // while a retry of one request/model pair must not insert a duplicate.
    const lateUrl = "https://fixture.invalid/later-chunk-concurrency";
    await admin`insert into articles(news_url,news_title) values(${lateUrl},'late concurrency')`;
    const lateArticle = await admin<{ id: number }[]>`
      select id from articles where news_url=${lateUrl}
    `;
    const lateArticleId = lateArticle[0].id;
    await admin`
      insert into thread_chunks(article_id,chunk_index,replies,conversation_pattern)
      values(${lateArticleId},1,${
      admin.json(replies("base"))
    }::jsonb,'independent')
    `;
    const oldRequestId = crypto.randomUUID();
    const oldClaim = await admin<{ result: { articleId: number } }[]>`
      select public.claim_shared_ai_chunk_generation(
        ${lateUrl},'late concurrency',2,${oldRequestId}::uuid,'singleReply'
      ) as result
    `;
    strictEqual(Number(oldClaim[0].result.articleId), Number(lateArticleId));
    const emptyRelations = admin.json([]);
    const oldPrimary = await admin<{ result: { status: string } }[]>`
      select public.complete_shared_ai_chunk_primary(
        ${lateArticleId},2,${oldRequestId}::uuid,'groq-120b',
        ${
      admin.array(Array.from({ length: 10 }, (_, i) => `old ${i + 1}`))
    }::text[],
        ${emptyRelations}::jsonb
      ) as result
    `;
    strictEqual(oldPrimary[0].result.status, "saved");
    const newRequestId = crypto.randomUUID();
    const newClaim = await admin<{ result: { status: string } }[]>`
      select public.claim_shared_ai_chunk_generation(
        ${lateUrl},'late concurrency',3,${newRequestId}::uuid,'branch'
      ) as result
    `;
    strictEqual(newClaim[0].result.status, "claimed");
    const newPrimary = await admin<{ result: { status: string } }[]>`
      select public.complete_shared_ai_chunk_primary(
        ${lateArticleId},3,${newRequestId}::uuid,'google-gemma',
        ${
      admin.array(Array.from({ length: 10 }, (_, i) => `new ${i + 1}`))
    }::text[],
        ${emptyRelations}::jsonb
      ) as result
    `;
    strictEqual(newPrimary[0].result.status, "saved");
    const oldLateReplies = Array.from(
      { length: 10 },
      (_, i) => `old late ${i + 1}`,
    );
    const newLateReplies = Array.from(
      { length: 10 },
      (_, i) => `new late ${i + 1}`,
    );
    const lateResults = await Promise.all([
      connections[1]`
        select public.append_shared_ai_late_result(
          ${lateArticleId},2,${oldRequestId}::uuid,'cloudflare-gemma',
          ${connections[1].array(oldLateReplies)}::text[],${
        connections[1].json([])
      }::jsonb
        ) as result
      `,
      connections[2]`
        select public.append_shared_ai_late_result(
          ${lateArticleId},2,${oldRequestId}::uuid,'cloudflare-gemma',
          ${connections[2].array(oldLateReplies)}::text[],${
        connections[2].json([])
      }::jsonb
        ) as result
      `,
      connections[3]`
        select public.append_shared_ai_late_result(
          ${lateArticleId},3,${newRequestId}::uuid,'gemini-3.1',
          ${connections[3].array(newLateReplies)}::text[],${
        connections[3].json([])
      }::jsonb
        ) as result
      `,
    ]);
    const results = lateResults.map((rows) =>
      rows[0].result as {
        status: string;
        chunkIndex: number;
      }
    );
    strictEqual(results.filter((r) => r.status === "saved").length, 2);
    strictEqual(results.filter((r) => r.status === "already_saved").length, 1);
    deepStrictEqual([...new Set(results.map((r) => r.chunkIndex))].sort(), [
      4,
      5,
    ]);
    const lateChunks = await admin<
      { chunk_index: number; first_text: string }[]
    >`
      select chunk_index,replies->0->>'text' as first_text from thread_chunks
      where article_id=${lateArticleId} and chunk_index>=4 order by chunk_index
    `;
    strictEqual(lateChunks.length, 2);
    deepStrictEqual(
      new Set(lateChunks.map((row) => row.first_text)),
      new Set(["old late 1", "new late 1"]),
    );
    console.log(
      "Concurrent later saves received unique chunks; duplicate retry was idempotent",
    );

    await ownerConnection`select public.finish_shared_ai_job(${topic}::uuid,${owner}::uuid)`;
    const ready = await admin`
      select public.claim_shared_ai_job(${topic}::uuid,${crypto.randomUUID()}::uuid) as result
    `;
    strictEqual(ready[0].result.status, "ready");

    // Finished without a saved chunk is deferred until expiry, then recoverable.
    const recoveryTopic = crypto.randomUUID();
    const recoveryOwner = crypto.randomUUID();
    await admin`insert into topics(id,representative_url,thread_title,facts)
      values(${recoveryTopic}::uuid,'https://fixture.invalid/recovery','recovery',array['fact'])`;
    const firstClaim = await admin`
      select public.claim_shared_ai_job(${recoveryTopic}::uuid,${recoveryOwner}::uuid) as result
    `;
    strictEqual(firstClaim[0].result.status, "claimed");
    await admin`select public.finish_shared_ai_job(${recoveryTopic}::uuid,${recoveryOwner}::uuid)`;
    const deferred = await admin`
      select public.claim_shared_ai_job(${recoveryTopic}::uuid,${crypto.randomUUID()}::uuid) as result
    `;
    strictEqual(deferred[0].result.status, "deferred");
    await admin`update shared_ai_jobs set expires_at=now()-interval '1 second'
      where topic_id=${recoveryTopic}::uuid`;
    const recovered = await admin`
      select public.claim_shared_ai_job(${recoveryTopic}::uuid,${crypto.randomUUID()}::uuid) as result
    `;
    strictEqual(recovered[0].result.status, "claimed");

    // Race the normal router save against the 31B generation-guarded RPC.
    const raceTopic = crypto.randomUUID();
    const raceOwner = crypto.randomUUID();
    const routerAttempt = crypto.randomUUID();
    await admin`insert into topics(id,representative_url,thread_title,facts)
      values(${raceTopic}::uuid,'https://fixture.invalid/router-31b','router-31b',array['fact'])`;
    await admin`select public.claim_shared_ai_job(${raceTopic}::uuid,${raceOwner}::uuid)`;
    strictEqual(
      (await admin`
        select public.begin_shared_ai_attempt(
          ${raceTopic}::uuid,${raceOwner}::uuid,'groq-120b',${routerAttempt}::uuid
        ) as allowed
      `)[0].allowed,
      true,
    );
    const target = await admin`
      select * from public.register_topic_pregen_target(${raceTopic}::uuid)
    `;
    strictEqual(target.length, 1);
    const generation = target[0].generation;
    const raceResults = await Promise.all([
      connections[0]`
        select public.complete_shared_ai_attempt(
          ${raceTopic}::uuid,${routerAttempt}::uuid,${
        connections[0].json(replies("normal-router"))
      }::jsonb
        ) as chunk_index
      `,
      connections[1]`
        select public.save_topic_pregen_chunk(
          ${raceTopic}::uuid,${generation}::bigint,'ignored','ignored',
          ${connections[1].json(replies("31b-pregen"))}::jsonb
        ) as saved
      `,
    ]);
    strictEqual(raceResults[1][0].saved, true);
    const raceChunks = await admin`
      select c.chunk_index,c.generation_attempt,jsonb_array_length(c.replies)::int as reply_count,
        c.replies->0->>'text' as first_text
      from public.thread_chunks c join public.articles a on a.id=c.article_id
      where a.news_url='https://fixture.invalid/router-31b'
      order by c.chunk_index
    `;
    deepStrictEqual(raceChunks.map((row) => row.chunk_index), [1, 2]);
    strictEqual(raceChunks.every((row) => row.reply_count === 10), true);
    deepStrictEqual(
      new Set(raceChunks.map((row) => row.first_text)),
      new Set(["normal-router-1", "31b-pregen-1"]),
    );
    const staleGeneration = await admin`
      select public.save_topic_pregen_chunk(
        ${raceTopic}::uuid,${
      Number(generation) - 1
    }::bigint,'ignored','ignored',
        ${admin.json(replies("stale-31b"))}::jsonb
      ) as saved
    `;
    strictEqual(staleGeneration[0].saved, false);
    strictEqual(
      (await admin`
        select count(*)::int as count from public.thread_chunks c
        join public.articles a on a.id=c.article_id
        where a.news_url='https://fixture.invalid/router-31b'
      `)[0].count,
      2,
    );
  } finally {
    await Promise.all(
      connections.map((connection) => connection.end({ timeout: 2 })),
    );
  }
});
