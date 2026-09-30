// Redisコマンドはメモリ内で代替し、保存/ロックのLua自体を実行する。
import {
  lauxlib,
  lua,
  lualib,
  to_jsstring,
  to_luastring,
} from "npm:fengari@0.1.4";
import { acquire, Redis, release, saveArticles, saveLog } from "./store.ts";
import { config, keys } from "./config.ts";
import { normalize } from "./normalize.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
class MemoryRedis extends Redis {
  private state = lauxlib.luaL_newstate();
  constructor() {
    super("", "");
    lualib.luaL_openlibs(this.state);
    lua.lua_pushjsfunction(this.state, () => {
      this.push(JSON.parse(this.read(1) as string));
      return 1;
    });
    lua.lua_setglobal(this.state, to_luastring("decode"));
    lua.lua_pushjsfunction(this.state, () => {
      this.push(JSON.stringify(this.read(1)));
      return 1;
    });
    lua.lua_setglobal(this.state, to_luastring("encode"));
    this.run(`
      cjson = {decode=decode, encode=encode}; DB = {}; EXP = {}; NOW=0
      redis = {call=function(cmd, key, ...)
        local args={...}
        if EXP[key] and EXP[key] <= NOW then DB[key]=nil; EXP[key]=nil end
        if cmd=='GET' then return DB[key] or false end
        if cmd=='EXISTS' then return DB[key] and 1 or 0 end
        if cmd=='SET' then DB[key]=args[1]; if args[2]=='EX' then EXP[key]=NOW+tonumber(args[3]) end; return 'OK' end
        if cmd=='DEL' then DB[key]=nil; EXP[key]=nil; return 1 end
        if cmd=='ZADD' then DB[key]=DB[key] or {}; DB[key][args[2]]=tonumber(args[1]); return 1 end
        if cmd=='ZREM' then if DB[key] then DB[key][args[1]]=nil end; return 1 end
        if cmd=='ZREMRANGEBYSCORE' then
          for member,score in pairs(DB[key] or {}) do if score <= tonumber(args[2]) then DB[key][member]=nil end end
          return 1
        end
        error('Unsupported command: '..cmd)
      end}
    `);
  }
  private push(value: unknown) {
    const L = this.state;
    if (value == null) lua.lua_pushnil(L);
    else if (typeof value === "string") {
      lua.lua_pushstring(L, to_luastring(value));
    } else if (typeof value === "number") lua.lua_pushnumber(L, value);
    else if (typeof value === "boolean") lua.lua_pushboolean(L, value);
    else {
      lua.lua_newtable(L);
      for (const [key, v] of Object.entries(value)) {
        this.push(v);
        if (Array.isArray(value)) lua.lua_rawseti(L, -2, Number(key) + 1);
        else lua.lua_setfield(L, -2, to_luastring(key));
      }
    }
  }
  private read(index: number): unknown {
    const L = this.state;
    const at = lua.lua_absindex(L, index);
    switch (lua.lua_type(L, at)) {
      case lua.LUA_TNIL:
        return null;
      case lua.LUA_TBOOLEAN:
        return lua.lua_toboolean(L, at);
      case lua.LUA_TNUMBER:
        return lua.lua_tonumber(L, at);
      case lua.LUA_TSTRING:
        return to_jsstring(lua.lua_tolstring(L, at));
      case lua.LUA_TTABLE: {
        const values: Record<string, unknown> = {};
        lua.lua_pushnil(L);
        while (lua.lua_next(L, at)) {
          values[String(this.read(-2))] = this.read(-1);
          lua.lua_pop(L, 1);
        }
        const count = lua.lua_rawlen(L, at);
        return count > 0
          ? Array.from({ length: count }, (_, i) => values[String(i + 1)])
          : values;
      }
      default:
        throw new Error("Unexpected Lua type");
    }
  }
  private run(script: string): unknown {
    if (
      lauxlib.luaL_dostring(this.state, to_luastring(script)) !== lua.LUA_OK
    ) throw new Error(String(this.read(-1)));
    const result = lua.lua_gettop(this.state) ? this.read(-1) : null;
    lua.lua_settop(this.state, 0);
    return result;
  }
  override command<T = unknown>(...command: unknown[]): Promise<T> {
    let script: string;
    if (command[0] === "EVAL") {
      const count = Number(command[2]);
      this.push(command.slice(3, 3 + count));
      lua.lua_setglobal(this.state, to_luastring("KEYS"));
      this.push(command.slice(3 + count).map(String));
      lua.lua_setglobal(this.state, to_luastring("ARGV"));
      script = String(command[1]);
    } else {
      this.push(command);
      lua.lua_setglobal(this.state, to_luastring("ARGV"));
      script = "return redis.call(table.unpack(ARGV))";
    }
    return Promise.resolve(this.run(script) as T);
  }
  entries() {
    return this.run("return DB") as Record<string, unknown>;
  }
  advance(seconds: number) {
    this.run(`NOW=NOW+${seconds}`);
  }
  close() {
    lua.lua_close(this.state);
  }
}
const article = (id: string, url: string, categories: string[]) =>
  normalize(
    {
      article_id: id,
      link: url,
      title: "title",
      category: categories,
      pubDate: "2026-09-06 00:00:00",
    },
    config,
    "2026-09-06T00:00:00Z",
  );
Deno.test("Lua storage merges historical IDs/URLs, categories and aliases without category copies", async () => {
  const redis = new MemoryRedis();
  try {
    const a = article("a", "https://example.com/a", ["top"]);
    const b = article("b", "https://example.com/b", ["sports"]);
    equal(await saveArticles(redis, [[a], [b]], config), {
      new_articles: 2,
      already_known: 0,
      new_article_ids: ["a", "b"],
    });
    equal(
      await saveArticles(
        redis,
        [[{ ...a, normalized_url: b.normalized_url }]],
        config,
      ),
      { new_articles: 0, already_known: 1, new_article_ids: [] },
    );
    let bodies = Object.entries(redis.entries()).filter(([k]) =>
      k.startsWith("newsdata:article:")
    );
    equal(bodies.length, 1);
    const body = JSON.parse(bodies[0][1] as string);
    equal(body.newsdata_categories.sort(), ["sports", "top"]);
    equal(body.app_categories.sort(), ["エンタメ", "トレンド"]);
    equal(body.identity_keys.length, 4);
    equal(await saveArticles(redis, [[b]], config), {
      new_articles: 0,
      already_known: 1,
      new_article_ids: [],
    });
    equal(
      Object.keys(redis.entries()).some((k) => k.startsWith("news:feed:")),
      false,
    );
    redis.advance(config.articleRetentionSeconds + 1);
    equal(await redis.command("GET", bodies[0][0]), false);
    equal(await saveArticles(redis, [[a]], config), {
      new_articles: 1,
      already_known: 0,
      new_article_ids: ["a"],
    });
    bodies = Object.entries(redis.entries()).filter(([k]) =>
      k.startsWith("newsdata:article:")
    );
    equal(bodies.length, 1);
  } finally {
    redis.close();
  }
});
Deno.test("Lua lock blocks overlap and owner check protects release", async () => {
  const redis = new MemoryRedis();
  try {
    equal(await acquire(redis, config, "a", 0), true);
    equal(await acquire(redis, config, "b", 0), false);
    await release(redis, "b");
    equal(await acquire(redis, config, "c", 3600000), false);
    await release(redis, "a");
    equal(await acquire(redis, config, "d", 0), true);
    equal(await acquire(redis, config, "e", 3600000), false);
    await release(redis, "d");
    equal(await acquire(redis, config, "e", 3600000), true);
    const log = {
      trigger: "manual",
      requests: [{ request_index: 1, status: "success" }],
    };
    await saveLog(redis, "run", log, config, Date.now());
    equal(JSON.parse(await redis.command<string>("GET", keys.job("run"))), log);
    redis.advance(config.logRetentionSeconds + 1);
    equal(await redis.command("GET", keys.job("run")), false);
  } finally {
    redis.close();
  }
});
