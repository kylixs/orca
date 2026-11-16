import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildHash,
  parseHash,
  ROUTE_NAMES,
} from "../apps/web/router/routes.js";

const entries = (query: URLSearchParams): [string, string][] => [...query];

test("静态路由往返一致且生成规范 hash", () => {
  const cases = [
    ["workbench", "#/workbench"],
    ["projects", "#/projects"],
    ["hosts", "#/hosts"],
    ["relays", "#/relays"],
    ["users", "#/users"],
    ["audit", "#/audit"],
    ["settings", "#/settings"],
    ["forbidden", "#/forbidden"],
    ["login", "#/login"],
    ["not-found", "#/not-found"],
  ] as const;
  for (const [name, hash] of cases) {
    assert.equal(buildHash({ name }), hash);
    const route = parseHash(hash);
    assert.equal(route.name, name);
    assert.deepEqual(route.params, {});
    assert.deepEqual(entries(route.query), []);
  }
});

test("参数路由与查询往返一致", () => {
  const cases = [
    { name: "projects", params: { id: "proj_1" }, query: [["tab", "perms"]] },
    { name: "hosts", params: { id: "host_1" }, query: [["tab", "info"]] },
    { name: "users", params: { id: "user_1" }, query: [] },
    { name: "workspace", params: { id: "proj_1" }, query: [] },
  ] as const;
  for (const input of cases) {
    const hash = buildHash({
      name: input.name,
      params: { ...input.params },
      query: input.query,
    });
    const route = parseHash(hash);
    assert.equal(route.name, input.name);
    assert.deepEqual(route.params, input.params);
    assert.deepEqual(
      entries(route.query),
      input.query.map(([key, value]) => [key, value]),
    );
    assert.equal(buildHash(route), hash);
  }
});

test("查询参数保序（解析与重建都不排序）", () => {
  const hash = "#/audit?result=fail&range=30d&q=deploy&event=file.write";
  const route = parseHash(hash);
  assert.equal(route.name, "audit");
  assert.deepEqual(entries(route.query), [
    ["result", "fail"],
    ["range", "30d"],
    ["q", "deploy"],
    ["event", "file.write"],
  ]);
  assert.equal(buildHash(route), hash);
});

test("重复查询键保序且不合并", () => {
  const route = parseHash("#/audit?event=a&event=b");
  assert.deepEqual(entries(route.query), [
    ["event", "a"],
    ["event", "b"],
  ]);
  assert.equal(buildHash(route), "#/audit?event=a&event=b");
});

test("普通对象查询按插入顺序（也接受条目迭代器）", () => {
  assert.equal(
    buildHash({ name: "projects", query: { q: "web", range: "30d" } }),
    "#/projects?q=web&range=30d",
  );
  assert.equal(
    buildHash({
      name: "users",
      query: [
        ["query", "zhang"],
        ["role", "admin"],
      ],
    }),
    "#/users?query=zhang&role=admin",
  );
});

test("空值查询参数被省略（规范化）", () => {
  const route = parseHash("#/projects?q=&tab=");
  assert.deepEqual(entries(route.query), []);
  assert.equal(buildHash(route), "#/projects");
  assert.equal(
    buildHash({ name: "projects", query: { q: "", range: undefined } }),
    "#/projects",
  );
});

test("路径参数严格编码并可还原", () => {
  const id = "proj 中文/?#%";
  const hash = buildHash({ name: "projects", params: { id } });
  assert.equal(hash, `#/projects/${encodeURIComponent(id)}`);
  const route = parseHash(hash);
  assert.equal(route.name, "projects");
  assert.equal(route.params.id, id);
  assert.equal(buildHash(route), hash);
});

test("id 大小写保留；路由字面段大小写敏感", () => {
  const project = parseHash("#/projects/Proj_ABC");
  assert.equal(project.name, "projects");
  assert.equal(project.params.id, "Proj_ABC");

  assert.equal(parseHash("#/Workbench").name, "not-found");
  assert.equal(parseHash("#/PROJECTS").name, "not-found");
  assert.equal(parseHash("#/projects/Proj_ABC/TAB").name, "not-found");
});

test("未知路由显式 404（不回落工作台）", () => {
  for (const hash of [
    "#/members",
    "#/diagnostics",
    "#/nope",
    "#/project/abc",
    "#/projects/p1/workspace",
    "#/projects/p1/extra",
    "#/hosts/h1/extra",
  ]) {
    assert.equal(parseHash(hash).name, "not-found", hash);
  }
});

test("畸形百分号编码与缺失前导斜杠为 404", () => {
  assert.equal(parseHash("#/projects/%E0%A4%A").name, "not-found");
  assert.equal(parseHash("#/projects/%").name, "not-found");
  assert.equal(parseHash("#projects").name, "not-found");
  assert.equal(parseHash("projects").name, "not-found");
});

test("空 hash 与 #/ 落到默认工作台", () => {
  for (const hash of ["", "#", "#/"]) {
    const route = parseHash(hash);
    assert.equal(route.name, "workbench", JSON.stringify(hash));
    assert.deepEqual(route.params, {});
  }
});

test("尾斜杠按同一路由接收", () => {
  assert.equal(parseHash("#/projects/").name, "projects");
  assert.deepEqual(parseHash("#/projects/p1/").params, { id: "p1" });
  assert.equal(parseHash("#/projects//").name, "not-found");
});

test("未知查询键原样保留（由调用方决定是否规范化）", () => {
  const route = parseHash("#/hosts?tab=perms&foo=bar");
  assert.deepEqual(entries(route.query), [
    ["tab", "perms"],
    ["foo", "bar"],
  ]);
});

test("构造缺失参数或未知路由名时抛出", () => {
  assert.throws(() => buildHash({ name: "workspace" }), TypeError);
  // 可选 id 传空串等同于不传，落到列表路由。
  assert.equal(
    buildHash({ name: "projects", params: { id: "" } }),
    "#/projects",
  );
  // SAFETY: 故意传入表外路由名以验证运行时拒绝。
  assert.throws(() => buildHash({ name: "members" as never }), RangeError);
});

test("路由名表去重且包含全部已知路由", () => {
  assert.deepEqual(
    [...ROUTE_NAMES],
    [
      "login",
      "workbench",
      "projects",
      "workspace",
      "hosts",
      "relays",
      "users",
      "audit",
      "settings",
      "forbidden",
      "not-found",
    ],
  );
});
