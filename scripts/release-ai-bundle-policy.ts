export const forbiddenReleaseAiBundleMarkers = [
  "api.openai.com",
  "OpenAiBriefParser",
  "OpenAiEmbeddingProvider",
  "OpenAiQueryOptimizer",
  "OpenAiRanker",
  "OpenAiTasteScout"
] as const;

const officialReleaseServerBundleRoot = "/app/dist/server";

export function releaseAiBundleScanScript(root = officialReleaseServerBundleRoot) {
  return [
    'const fs=require("node:fs"),path=require("node:path");',
    `const forbidden=${JSON.stringify(forbiddenReleaseAiBundleMarkers)};`,
    "const files=[];",
    'const walk=(dir)=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){',
    "const target=path.join(dir,entry.name);",
    "if(entry.isDirectory())walk(target);",
    'else if(entry.isFile()&&entry.name.endsWith(".js"))files.push(target);',
    "}};",
    `walk(${JSON.stringify(root)});`,
    'if(files.some((file)=>{const source=fs.readFileSync(file,"utf8");',
    "return forbidden.some((marker)=>source.includes(marker));}))process.exit(1);"
  ].join("");
}
