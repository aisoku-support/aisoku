// Embedded PostgreSQL; no connection to Supabase or any production database.
import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { deepStrictEqual, rejects, strictEqual } from "node:assert";

Deno.test("router SQL: claims, recovery, 31B ordering, idempotency, generation and permissions", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      `create role anon; create role authenticated; create role service_role bypassrls;
      create table topics(id uuid primary key,thread_title text,representative_title text,
      representative_description text,representative_url text,representative_published_at timestamptz default now(),
      thread_title_pending boolean default false,topic_pregen_pending boolean default true,
      subject text,event text,facts text[],created_at timestamptz default now());
      create table topic_thread_title_queue(topic_id uuid,status text);`,
    );
    for (
      const path of [
        "20260923060000_create_shared_ai_reply_cache.sql",
        "20260924120000_add_topic_pregen_cache.sql",
        "20260927093027_free_shared_ai_router.sql",
        "20260928144828_shared_ai_later_chunk_generation.sql",
        "20260928164328_grant_shared_chunk_replies_to_service_role.sql",
        "20260928180615_fix_shared_ai_chunk_reply_name.sql",
      ]
    ) {
      // topic_pregen_pending belongs to the pregen migration, not the fixture.
      if (path.includes("add_topic_pregen_cache")) {
        await db.exec("alter table topics drop column topic_pregen_pending");
      }
      await db.exec(
        await Deno.readTextFile(
          new URL(`../migrations/${path}`, import.meta.url),
        ),
      );
    }
    const generatedNames = await db.query<{ name: string }>(`
      select value->>'name' as name
      from jsonb_array_elements(public.build_shared_ai_chunk_replies(
        array['1','2','3','4','5','6','7','8','9','10'], '[]'::jsonb, 2
      ))
    `);
    deepStrictEqual(
      generatedNames.rows.map((row) => row.name),
      Array(10).fill("名無しのAIさん"),
    );
    const topic = crypto.randomUUID(),
      owner = crypto.randomUUID(),
      other = crypto.randomUUID(),
      attempt = crypto.randomUUID();
    await db.query(
      `insert into topics(id,representative_url,thread_title,facts) values($1,'https://fixture.invalid/1','title',array['fact']);`,
      [topic],
    );
    const rpc = async (name: string, params: unknown[]) => {
      const result = await db.query<{ result: any }>(
        `select ${name}(${
          params.map((_, i) => `$${i + 1}`).join(",")
        }) as result`,
        params,
      );
      return result.rows[0].result;
    };
    const asServiceRole = async <T>(action: () => Promise<T>): Promise<T> => {
      await db.exec("set role service_role");
      try {
        return await action();
      } finally {
        await db.exec("reset role");
      }
    };
    strictEqual(
      (await rpc("claim_shared_ai_job", [topic, owner])).status,
      "claimed",
    );
    const claims = await Promise.all(
      Array.from(
        { length: 8 },
        () => rpc("claim_shared_ai_job", [topic, crypto.randomUUID()]),
      ),
    );
    strictEqual(claims.every((c) => c.status === "running"), true);
    strictEqual(
      await rpc("begin_shared_ai_attempt", [
        topic,
        owner,
        "groq-120b",
        attempt,
      ]),
      true,
    );
    strictEqual(
      await rpc("begin_shared_ai_attempt", [
        topic,
        owner,
        "groq-120b",
        crypto.randomUUID(),
      ]),
      false,
    );
    await db.query(
      `update shared_ai_jobs set expires_at=now()-interval '1 second' where topic_id=$1`,
      [topic],
    );
    const recovered = await rpc("claim_shared_ai_job", [topic, other]);
    deepStrictEqual(recovered.attempted, ["groq-120b"]);
    strictEqual(
      (await db.query<{ status: string }>(
        "select status from shared_ai_attempts",
      )).rows[0].status,
      "unknown",
    );
    strictEqual(
      await rpc("begin_shared_ai_attempt", [
        topic,
        owner,
        "cloudflare-gemma",
        crypto.randomUUID(),
      ]),
      false,
    );
    await db.query(
      "insert into topic_pregen_target(singleton,generation,topic_id) values(true,1,$1)",
      [topic],
    );
    strictEqual(
      await rpc("save_topic_pregen_chunk", [topic, 1, "", "", "[]"]),
      false,
    );
    const replies = JSON.stringify(
      Array.from(
        { length: 10 },
        (_, i) => ({
          text: `text ${i}`,
          origin: "sharedAi",
          type: "ai",
          replyTo: null,
        }),
      ),
    );
    // Concurrent callers are queued by embedded PG; test both serialization orders below.
    const result = await Promise.all([
      rpc("save_topic_pregen_chunk", [topic, 1, "ignored", "ignored", replies]),
      rpc("complete_shared_ai_attempt", [topic, attempt, replies]),
      rpc("complete_shared_ai_attempt", [topic, attempt, replies]),
    ]);
    deepStrictEqual(result, [true, 2, 2]);
    strictEqual(
      await rpc("save_topic_pregen_chunk", [
        topic,
        1,
        "ignored",
        "ignored",
        replies,
      ]),
      true,
    );
    deepStrictEqual(
      (await db.query(
        "select chunk_index from thread_chunks order by chunk_index",
      )).rows,
      [{ chunk_index: 1 }, { chunk_index: 2 }],
    );
    strictEqual(
      (await rpc("claim_shared_ai_job", [topic, crypto.randomUUID()])).status,
      "ready",
    );
    strictEqual(
      await rpc("begin_shared_ai_attempt", [
        topic,
        other,
        "cloudflare-gemma",
        crypto.randomUUID(),
      ]),
      false,
    );
    await db.exec("update topic_pregen_target set generation=2");
    strictEqual(
      await rpc("save_topic_pregen_chunk", [
        topic,
        1,
        "ignored",
        "ignored",
        replies,
      ]),
      false,
    );
    await rejects(() =>
      rpc("append_shared_ai_chunk", [
        topic,
        "bad",
        JSON.stringify([{ text: "bad", origin: "user" }]),
      ])
    );
    const topic2 = crypto.randomUUID(),
      owner2 = crypto.randomUUID(),
      attempt2 = crypto.randomUUID();
    await db.query(
      `insert into topics(id,representative_url,thread_title) values($1,'https://fixture.invalid/2','title')`,
      [topic2],
    );
    await rpc("claim_shared_ai_job", [topic2, owner2]);
    await rpc("begin_shared_ai_attempt", [
      topic2,
      owner2,
      "groq-120b",
      attempt2,
    ]);
    strictEqual(
      await rpc("complete_shared_ai_attempt", [topic2, attempt2, replies]),
      1,
    );
    await db.query("update topic_pregen_target set topic_id=$1,generation=3", [
      topic2,
    ]);
    strictEqual(
      await rpc("save_topic_pregen_chunk", [
        topic2,
        3,
        "ignored",
        "ignored",
        replies,
      ]),
      true,
    );
    deepStrictEqual(
      (await db.query(
        "select chunk_index from thread_chunks where article_id=(select id from articles where news_url=$1) order by chunk_index",
        ["https://fixture.invalid/2"],
      )).rows,
      [{ chunk_index: 1 }, { chunk_index: 2 }],
    );

    // Match the service_role's existing column grants. The router migration
    // adds generation_attempt, so its SELECT/INSERT rights must be granted too.
    const topic3 = crypto.randomUUID(),
      owner3 = crypto.randomUUID(),
      attempt3 = crypto.randomUUID();
    await db.query(
      `insert into topics(id,representative_url,thread_title) values($1,'https://fixture.invalid/3','title')`,
      [topic3],
    );
    await rpc("claim_shared_ai_job", [topic3, owner3]);
    await rpc("begin_shared_ai_attempt", [
      topic3,
      owner3,
      "groq-120b",
      attempt3,
    ]);
    await db.exec(`
      grant select on topics to service_role;
      grant select,insert,update on articles to service_role;
      grant select (article_id,chunk_index,conversation_pattern),
        insert (article_id,chunk_index,replies,conversation_pattern,updated_at) on thread_chunks to service_role;
      grant usage on sequence articles_id_seq,thread_chunks_id_seq to service_role;
    `);
    await rejects(() =>
      asServiceRole(() =>
        rpc("complete_shared_ai_attempt", [topic3, attempt3, replies])
      )
    );
    await db.exec(`
      grant select (generation_attempt) on thread_chunks to service_role;
      grant insert (generation_attempt) on thread_chunks to service_role;
    `);
    strictEqual(
      await asServiceRole(() =>
        rpc("complete_shared_ai_attempt", [topic3, attempt3, replies])
      ),
      1,
    );
    strictEqual(
      (await db.query<{ generation_attempt: string }>(
        "select generation_attempt from thread_chunks where article_id=(select id from articles where news_url=$1)",
        ["https://fixture.invalid/3"],
      )).rows[0].generation_attempt,
      `router:${attempt3}`,
    );
    await db.exec("set role anon");
    await rejects(() => rpc("claim_shared_ai_job", [topic, owner]));
    await rejects(() => db.query("select * from shared_ai_attempts"));
    await db.exec(
      "reset role; grant usage on sequence thread_chunks_id_seq to anon; set role anon",
    );
    await db.query(
      `insert into thread_chunks(article_id,chunk_index,replies,conversation_pattern) select id,3,$1::jsonb,'independent' from articles where news_url='https://fixture.invalid/2'`,
      [replies],
    );

    await db.exec("reset role");
    const sharedRequest = crypto.randomUUID();
    await db.query(
      `insert into articles(news_url,news_title) values('https://fixture.invalid/follow-up','title')`,
    );
    const followupArticle = await db.query<{ id: number }>(
      "select id from articles where news_url='https://fixture.invalid/follow-up'",
    );
    await db.query(
      `insert into thread_chunks(article_id,chunk_index,replies,conversation_pattern) values($1,1,$2::jsonb,'independent')`,
      [followupArticle.rows[0].id, replies],
    );
    const claimArgs = [
      "https://fixture.invalid/follow-up",
      "title",
      2,
      sharedRequest,
      "singleReply",
    ];
    await db.exec(
      "revoke select (replies) on thread_chunks from service_role",
    );
    await rejects(() =>
      asServiceRole(() => rpc("claim_shared_ai_chunk_generation", claimArgs))
    );
    await db.exec(
      await Deno.readTextFile(
        new URL(
          "../migrations/20260928164328_grant_shared_chunk_replies_to_service_role.sql",
          import.meta.url,
        ),
      ),
    );
    const claim = await asServiceRole(() =>
      rpc("claim_shared_ai_chunk_generation", claimArgs)
    );
    strictEqual(claim.status, "claimed");
    const competing = await rpc("claim_shared_ai_chunk_generation", [
      "https://fixture.invalid/follow-up",
      "title",
      2,
      crypto.randomUUID(),
      "branch",
    ]);
    strictEqual(competing.status, "running");
    const articleId = claim.articleId;
    const chunkTexts = Array.from({ length: 10 }, (_, i) => `shared ${i + 1}`);
    const lateChunkTexts = Array.from(
      { length: 10 },
      (_, i) => `late ${i + 1}`,
    );
    const article = await db.query<{ id: number }>(
      "select id from articles where news_url='https://fixture.invalid/follow-up'",
    );
    strictEqual(article.rows[0].id, articleId);
    const legacyInsert = await db.query(
      `insert into thread_chunks(article_id,chunk_index,replies,conversation_pattern)
       values($1,2,$2::jsonb,'independent') returning id`,
      [articleId, replies],
    );
    strictEqual(legacyInsert.rows.length, 0);
    const relations = JSON.stringify([{ from: 2, to: 1 }]);
    const primary = await rpc("complete_shared_ai_chunk_primary", [
      articleId,
      2,
      sharedRequest,
      "google-gemma",
      chunkTexts,
      relations,
    ]);
    strictEqual(primary.status, "saved");
    strictEqual(primary.chunkIndex, 2);
    const persisted = await db.query<
      { replies: Array<{ replyTo: number | null }> }
    >(
      "select replies from thread_chunks where article_id=$1 and chunk_index=2",
      [articleId],
    );
    strictEqual(persisted.rows[0].replies.length, 10);
    strictEqual(persisted.rows[0].replies[1].replyTo, 1);
    strictEqual(
      (await rpc("claim_shared_ai_chunk_generation", [
        "https://fixture.invalid/follow-up",
        "title",
        2,
        crypto.randomUUID(),
        "branch",
      ])).status,
      "ready",
    );
    const late = await rpc("append_shared_ai_late_result", [
      articleId,
      2,
      sharedRequest,
      "groq-120b",
      lateChunkTexts,
      relations,
    ]);
    strictEqual(late.status, "saved");
    strictEqual(late.chunkIndex, 3);
    const lateRetry = await rpc("append_shared_ai_late_result", [
      articleId,
      2,
      sharedRequest,
      "groq-120b",
      lateChunkTexts,
      relations,
    ]);
    strictEqual(lateRetry.status, "already_saved");
    deepStrictEqual(
      (await db.query<{ chunk_index: number; first_text: string }>(
        `select chunk_index, replies->0->>'text' as first_text from thread_chunks
         where article_id=$1 order by chunk_index`,
        [articleId],
      )).rows,
      [
        { chunk_index: 1, first_text: "text 0" },
        { chunk_index: 2, first_text: "shared 1" },
        { chunk_index: 3, first_text: "late 1" },
      ],
    );
  } finally {
    await db.close();
  }
});
