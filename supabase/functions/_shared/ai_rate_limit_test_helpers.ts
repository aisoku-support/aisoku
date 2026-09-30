import {
  lauxlib,
  lua,
  lualib,
  to_jsstring,
  to_luastring,
} from "npm:fengari@0.1.4";
import { AiRateLimiter, type QuotaConfig } from "./ai_rate_limit.ts";
export class MemoryQuotaRedis extends AiRateLimiter {
  private state = lauxlib.luaL_newstate();
  constructor(config: QuotaConfig) {
    super(config, fetch, () => "test");
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
        if cmd=='INCRBY' then DB[key]=tonumber(DB[key] or '0')+tonumber(args[1]); return DB[key] end
        if cmd=='DECRBY' then DB[key]=tonumber(DB[key] or '0')-tonumber(args[1]); return DB[key] end
        if cmd=='EXISTS' then return DB[key] and 1 or 0 end
        if cmd=='SET' then DB[key]=args[1]; if args[2]=='PX' then EXP[key]=NOW+tonumber(args[3]) end; return 'OK' end
        if cmd=='PEXPIRE' then EXP[key]=NOW+tonumber(args[1]); return 1 end
        if cmd=='ZCARD' then local n=0; for _ in pairs(DB[key] or {}) do n=n+1 end; return n end
        if cmd=='ZRANGE' then
          local rows={}; for member,score in pairs(DB[key] or {}) do table.insert(rows,{member=member,score=score}) end
          table.sort(rows,function(x,y) return x.score<y.score end)
          local a={}; for _,row in ipairs(rows) do table.insert(a,row.member); if args[3]=='WITHSCORES' then table.insert(a,tostring(row.score)) end end
          return a
        end
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
  override command(command: unknown[]): Promise<any> {
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
    return Promise.resolve(this.run(script));
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
