import { loadSyncMap } from "../relay/io/ticktick-sync-store.js";
import { diffTickTickReadback } from "../relay/core/ticktick-readback.js";
import { readFileSync } from "node:fs";

const map = loadSyncMap("state/loop-state.json");
const raw = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const remote = (raw.tasks ?? []).map((t: any) => ({
  id: t.id, status: t.status ?? 0,
  items: (t.items ?? []).map((i: any) => ({ id: i.id, status: i.status ?? 0, title: i.title })),
  projectId: t.projectId, title: t.title, tags: t.tags ?? [],
}));
const r = diffTickTickReadback(map, remote);
const ent = Object.entries(map).filter(([, v]: any) => v.ticktickId);
console.log("map 条目", ent.length, "墓碑", ent.filter(([, v]: any) => v.done).length);
console.log("TickTick 活跃任务", remote.length);
console.log("doneUnitKeys", r.doneUnitKeys.length, "dismissed", r.dismissedUnitKeys.length);
console.log("\n被判定 closed 的前 15 个:");
for (const k of r.doneUnitKeys.slice(0, 15)) console.log("  ", k, "|", (map as any)[k].title?.slice(0, 48));
