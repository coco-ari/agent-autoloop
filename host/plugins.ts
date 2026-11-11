// A plugin in this install's folder wins over one that ships.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HOME } from "./home.ts";

export function availablePlugins(kind: "agent" | "channel" | "source") {
  const names = new Set<string>();
  for (const root of [join(HOME, "plugins"), join(import.meta.dirname, "..", "plugins")]) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true }))
      if (
        entry.isDirectory() &&
        /^[a-z][a-z0-9-]*$/.test(entry.name) &&
        existsSync(join(root, entry.name, `${kind}.ts`))
      )
        names.add(entry.name);
  }
  return [...names].sort();
}

export async function loadPlugin(name: string, kind: "agent" | "channel" | "source") {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`插件名字不正确：${name}`);
  const entry = join(name, `${kind}.ts`);
  const file = [join(HOME, "plugins", entry), join(import.meta.dirname, "..", "plugins", entry)].find(existsSync);
  if (!file) throw new Error(`没有 ${name} 的插件（plugins/${name}/${kind}.ts）`);
  return (await import(pathToFileURL(file).href)).default;
}
